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
