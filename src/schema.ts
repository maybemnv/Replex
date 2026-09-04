import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);

function tryParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function normalizeOrigin(value: string): string {
  const parsed = tryParseUrl(value);
  if (!parsed) return value.trim().replace(/\/+$/, "");
  return parsed.origin;
}

const origin = z
  .string()
  .url()
  .refine((value) => {
    const parsed = tryParseUrl(value);
    return !!parsed && /^https?:$/.test(parsed.protocol);
  }, {
    message: "origin must use http or https",
  })
  .refine(
    (value) => {
      const parsed = tryParseUrl(value);
      if (!parsed) return false;
      return (
        parsed.username === "" &&
        parsed.password === "" &&
        /^https?:\/\/[^/?#@]*\/?$/i.test(value)
      );
    },
    { message: "origin must not include path, query, fragment, or userinfo" },
  );

export const MillisecondsSchema = z.number().int().finite().nonnegative();
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "invalid stable ID");

export const BriefSchema = z
  .object({
    audience: nonEmptyText,
    message: nonEmptyText,
    targetDurationMs: z.literal(30000),
  })
  .strict();

export const ViewportSchema = z
  .object({
    width: z.literal(1920),
    height: z.literal(1080),
  })
  .strict();

export const EnvironmentSchema = z
  .object({
    appOrigin: origin,
    allowedOrigins: z.array(origin).min(1),
    viewport: ViewportSchema,
    locale: nonEmptyText,
    timezone: nonEmptyText,
    browserVersion: nonEmptyText,
    reducedMotion: z.literal("reduce"),
    colorScheme: z.literal("light"),
    resetLabel: nonEmptyText.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const normalized = normalizeOrigin(value.appOrigin);
    if (!value.allowedOrigins.some((origin) => normalizeOrigin(origin) === normalized)) {
      context.addIssue({
        code: "custom",
        path: ["allowedOrigins"],
        message: "allowedOrigins must include appOrigin",
      });
    }
  });

const targetSchema = z
  .object({
    kind: z.enum(["role", "label", "testId", "url"]),
    value: nonEmptyText,
    name: nonEmptyText.optional(),
  })
  .strict();

const checkpointSchema = z
  .object({
    kind: z.enum(["url", "visible", "text", "attribute"]),
    expected: nonEmptyText,
    target: targetSchema.optional(),
  })
  .strict();

export const BrowserStepSchema = z
  .object({
    id: IdSchema,
    order: z.number().int().nonnegative(),
    action: z.enum(["goto", "click", "fill", "select", "upload", "waitFor"]),
    target: targetSchema.optional(),
    valueRef: nonEmptyText.optional(),
    consequential: z.boolean(),
    approved: z.boolean(),
    checkpoint: checkpointSchema,
    sceneKey: IdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "goto" && value.target?.kind !== "url") {
      context.addIssue({ code: "custom", path: ["target"], message: "goto steps require a url target" });
    }
    if ((value.action === "fill" || value.action === "select" || value.action === "upload") && !value.valueRef) {
      context.addIssue({ code: "custom", path: ["valueRef"], message: `${value.action} steps require a valueRef` });
    }
  });

export const FlowSchema = z
  .object({
    id: IdSchema,
    approvedAt: z.string().datetime({ offset: true }),
    prohibitedActions: z.array(nonEmptyText),
    steps: z.array(BrowserStepSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, step] of value.steps.entries()) {
      if (ids.has(step.id)) context.addIssue({ code: "custom", path: ["steps", index, "id"], message: "flow action IDs must be unique" });
      if (step.order !== index) context.addIssue({ code: "custom", path: ["steps", index, "order"], message: "flow step order must match its declared position" });
      ids.add(step.id);
    }
  });

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "expected a SHA-256 hex digest");

export const FocusSchema = z
  .object({
    preset: z.enum(["none", "box", "zoom"]),
    bounds: z
      .object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
        width: z.number().finite().positive().max(1),
        height: z.number().finite().positive().max(1),
      })
      .strict()
      .optional(),
    startMs: MillisecondsSchema,
    endMs: MillisecondsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endMs <= value.startMs) context.addIssue({ code: "custom", path: ["endMs"], message: "focus range must be positive" });
    if (value.preset === "none" && value.bounds) context.addIssue({ code: "custom", path: ["bounds"], message: "none focus cannot have bounds" });
    if (value.preset !== "none" && !value.bounds) context.addIssue({ code: "custom", path: ["bounds"], message: "focus bounds are required" });
  });

export const TransitionSchema = z
  .object({
    type: z.enum(["cut", "crossfade"]),
    durationMs: z.union([z.literal(0), z.literal(250), z.literal(500)]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "cut" && value.durationMs !== 0) context.addIssue({ code: "custom", path: ["durationMs"], message: "cut duration must be zero" });
    if (value.type === "crossfade" && value.durationMs === 0) context.addIssue({ code: "custom", path: ["durationMs"], message: "crossfade duration must be positive" });
  });

export const CaptureSchema = z
  .object({
    id: IdSchema,
    sceneKey: IdSchema,
    runId: IdSchema,
    actionIds: z.array(IdSchema).min(1),
    checkpointActionId: IdSchema,
    path: nonEmptyText,
    sha256: Sha256Schema,
    durationMs: MillisecondsSchema.refine((value) => value > 0, "capture duration must be positive"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.literal(30),
    capturedAt: z.string().datetime({ offset: true }),
    predecessorId: IdSchema.optional(),
  })
  .strict();

export const SceneSchema = z
  .object({
    id: IdSchema,
    sceneKey: IdSchema,
    captureId: IdSchema,
    actionIds: z.array(IdSchema).min(1),
    checkpointActionId: IdSchema,
    sourceInMs: MillisecondsSchema,
    sourceOutMs: MillisecondsSchema,
    speed: z.union([z.literal(0.75), z.literal(1), z.literal(1.25), z.literal(1.5), z.literal(2)]),
    order: z.number().int().nonnegative(),
    focus: FocusSchema.optional(),
    transition: TransitionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceOutMs <= value.sourceInMs) context.addIssue({ code: "custom", path: ["sourceOutMs"], message: "scene range must be positive" });
  });

export const OverlaySchema = z
  .object({
    id: IdSchema,
    sceneId: IdSchema,
    kind: z.enum(["title", "callout"]),
    text: nonEmptyText,
    placement: z.enum(["top", "bottom", "target"]),
    startMs: MillisecondsSchema,
    endMs: MillisecondsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endMs <= value.startMs) context.addIssue({ code: "custom", path: ["endMs"], message: "overlay range must be positive" });
    if (value.text.length > (value.kind === "title" ? 80 : 120)) context.addIssue({ code: "custom", path: ["text"], message: "overlay text is too long" });
  });

export const MediaProbeSchema = z
  .object({
    durationMs: MillisecondsSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.literal(30),
    videoCodec: nonEmptyText,
    audioCodec: nonEmptyText,
  })
  .strict();

export const RenderOutputSchema = z
  .object({
    id: IdSchema,
    revisionId: IdSchema,
    renderJobSha256: Sha256Schema,
    path: nonEmptyText,
    ffprobe: MediaProbeSchema,
    verificationId: IdSchema,
  })
  .strict();

export const RevisionSchema = z
  .object({
    id: IdSchema,
    parentId: IdSchema.optional(),
    actor: z.enum(["baseline", "model", "operator", "recapture"]),
    operationIds: z.array(IdSchema),
    manifestSha256: Sha256Schema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const RecaptureLineageSchema = z
  .object({
    id: IdSchema,
    sceneId: IdSchema,
    previousCaptureId: IdSchema,
    replacementCaptureId: IdSchema,
    changedStepIds: z.array(IdSchema).min(1),
    reason: nonEmptyText,
    revisionId: IdSchema,
  })
  .strict();

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: IdSchema,
    brief: BriefSchema,
    environment: EnvironmentSchema,
    flow: FlowSchema,
    captures: z.record(IdSchema, CaptureSchema),
    scenes: z.array(SceneSchema).min(1),
    overlays: z.record(IdSchema, OverlaySchema),
    revisions: z.array(RevisionSchema).min(1),
    outputs: z.array(RenderOutputSchema),
    recaptureLineage: z.array(RecaptureLineageSchema),
    currentRevisionId: IdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const captureIds = new Set(Object.keys(value.captures));
    const sceneIds = new Set(value.scenes.map((scene) => scene.id));
    const revisionIds = new Set(value.revisions.map((revision) => revision.id));
    for (const [key, capture] of Object.entries(value.captures)) {
      if (key !== capture.id) context.addIssue({ code: "custom", path: ["captures", key], message: "capture key must equal capture id" });
    }
    for (const [index, scene] of value.scenes.entries()) {
      if (!captureIds.has(scene.captureId)) context.addIssue({ code: "custom", path: ["scenes", index, "captureId"], message: "scene capture does not exist" });
      else if (value.captures[scene.captureId].sceneKey !== scene.sceneKey) context.addIssue({ code: "custom", path: ["scenes", index, "sceneKey"], message: "scene key does not match capture" });
    }
    for (const [key, overlay] of Object.entries(value.overlays)) {
      if (key !== overlay.id) context.addIssue({ code: "custom", path: ["overlays", key], message: "overlay key must equal overlay id" });
      if (!sceneIds.has(overlay.sceneId)) context.addIssue({ code: "custom", path: ["overlays", key, "sceneId"], message: "overlay scene does not exist" });
    }
    for (const [index, output] of value.outputs.entries()) {
      if (!revisionIds.has(output.revisionId)) context.addIssue({ code: "custom", path: ["outputs", index, "revisionId"], message: "output revision does not exist" });
    }
  });

export const ManifestSchema = ProjectSchema;

export const RuntimeConfigSchema = z
  .object({
    appOrigin: origin,
    allowedOrigins: z.array(origin).min(1),
    locale: nonEmptyText,
    timezone: nonEmptyText,
    brief: BriefSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const normalized = normalizeOrigin(value.appOrigin);
    if (!value.allowedOrigins.some((origin) => normalizeOrigin(origin) === normalized)) {
      context.addIssue({
        code: "custom",
        path: ["allowedOrigins"],
        message: "allowedOrigins must include appOrigin",
      });
    }
  });

export type Brief = z.infer<typeof BriefSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type BrowserStep = z.infer<typeof BrowserStepSchema>;
export type Flow = z.infer<typeof FlowSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type RenderOutput = z.infer<typeof RenderOutputSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type RecaptureLineage = z.infer<typeof RecaptureLineageSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export class ConfigValidationError extends Error {
  readonly code = "CONFIG_INVALID" as const;
  readonly issues: z.ZodIssue[];

  constructor(error: z.ZodError) {
    super("configuration is invalid");
    this.name = "ConfigValidationError";
    this.issues = error.issues;
  }
}

export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  const result = RuntimeConfigSchema.safeParse(input);
  if (!result.success) throw new ConfigValidationError(result.error);
  return result.data;
}
