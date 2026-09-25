import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { MediaEvidenceIndexSchema, type MediaEvidenceArtifact, type MediaEvidenceIndex } from "./media-evidence.js";
import { OperationLogRecordSchema, type OperationLogRecord } from "./operations-v2.js";
import { ProjectV2Schema, type MediaAsset, type ProjectV2 } from "./schema-v2.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const pageOffset = z.number().int().nonnegative().max(1_000_000);
const pageLimit = z.number().int().positive().max(25);

export const V2InspectRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project_summary") }).strict(),
  z.object({ kind: z.literal("assets"), offset: pageOffset.optional(), limit: pageLimit.optional() }).strict(),
  z.object({ kind: z.literal("clips"), offset: pageOffset.optional(), limit: pageLimit.optional() }).strict(),
  z.object({
    kind: z.literal("media_evidence"),
    assetId: identifier,
    image: z.enum(["contact_sheet", "selected_frame"]).optional(),
    frameOffset: z.number().int().nonnegative().max(3).optional(),
  }).strict().superRefine((request, context) => {
    if (request.frameOffset !== undefined && request.image !== "selected_frame") {
      context.addIssue({ code: "custom", path: ["frameOffset"], message: "frameOffset requires a selected_frame image request" });
    }
  }),
  z.object({ kind: z.literal("verification") }).strict(),
  z.object({ kind: z.literal("operation_history"), limit: z.number().int().positive().max(20).optional() }).strict(),
]);

export type V2InspectRequest = z.infer<typeof V2InspectRequestSchema>;

export interface V2InspectionContext {
  project: ProjectV2;
  evidenceRoot?: string;
  evidenceIndexes?: readonly MediaEvidenceIndex[];
  operationLog?: readonly OperationLogRecord[];
  /** Host policy may lower, but cannot raise, the module's image budget. */
  imageByteBudget?: number;
  /** Host policy may lower, but cannot raise, the module's serialized response limit. */
  responseByteLimit?: number;
}

export interface V2InspectImage {
  ref: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

export type V2InspectResult =
  | { ok: true; kind: V2InspectRequest["kind"]; data: Record<string, unknown>; evidenceRefs: string[]; images?: V2InspectImage[] }
  | { ok: false; code: "INVALID_REQUEST" | "INVALID_PROJECT" | "OUTPUT_LIMIT" };

type ProbeProjection = {
  durationMs?: number;
  bitRateBps?: number;
  streams: Array<{
    index: number;
    type: "video" | "audio" | "subtitle" | "data" | "attachment";
    codec?: string;
    width?: number;
    height?: number;
    fps?: number;
    sampleRateHz?: number;
    channels?: number;
  }>;
};

type SafeEvidence = {
  status: "available" | "stale" | "unavailable" | "invalid";
  probe?: ProbeProjection;
  sceneBoundariesMs?: number[];
  audio?: {
    peakDbfs: number | null;
    meanDbfs: number | null;
    silenceSegmentCount: number;
    silenceSegments: Array<{ startMs: number; endMs: number | null }>;
    loudness: { integratedLufs: number | null; truePeakDbtp: number | null; rangeLufs: number | null };
  };
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_OPERATION_SCAN = 1_000;
const MAX_IMAGE_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_IMAGE_BUDGET = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_RESPONSE_BYTES = 256 * 1024;
const MAX_EVIDENCE_INDEX_BYTES = 64 * 1024;
const MAX_EVIDENCE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const probeEvidenceSchema = z.object({
  durationMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
  bitRateBps: z.number().int().positive().max(10_000_000_000).optional(),
  streams: z.array(z.object({
    index: z.number().int().nonnegative().max(255),
    type: z.enum(["video", "audio", "subtitle", "data", "attachment"]),
    codec: z.string().max(64).optional(),
    width: z.number().int().positive().max(16_384).optional(),
    height: z.number().int().positive().max(16_384).optional(),
    fps: z.number().positive().max(1000).optional(),
    sampleRateHz: z.number().int().positive().max(768_000).optional(),
    channels: z.number().int().positive().max(64).optional(),
  }).strict()).min(1).max(32),
}).strict();

const sceneEvidenceSchema = z.object({
  version: z.literal(1),
  threshold: z.literal(0.3),
  boundariesMs: z.array(z.number().int().nonnegative().max(24 * 60 * 60 * 1000)).min(2).max(129),
}).strict().superRefine(({ boundariesMs }, context) => {
  for (let index = 1; index < boundariesMs.length; index += 1) {
    if (boundariesMs[index] <= boundariesMs[index - 1]) {
      context.addIssue({ code: "custom", path: ["boundariesMs", index], message: "scene boundaries must increase" });
    }
  }
});

const audioEvidenceSchema = z.object({
  version: z.literal(1),
  silenceThresholdDb: z.number().finite().min(-100).max(0),
  peakDbfs: z.number().finite().min(-200).max(0).nullable(),
  meanDbfs: z.number().finite().min(-200).max(0).nullable(),
  silenceSegments: z.array(z.object({
    startMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000),
    endMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000).nullable(),
  }).strict()).max(128),
  loudness: z.object({
    integratedLufs: z.number().finite().min(-200).max(100).nullable(),
    truePeakDbtp: z.number().finite().min(-200).max(100).nullable(),
    rangeLufs: z.number().finite().min(-200).max(100).nullable(),
  }).strict(),
}).strict();

function failure(code: "INVALID_REQUEST" | "INVALID_PROJECT" | "OUTPUT_LIMIT"): V2InspectResult {
  return { ok: false, code };
}

function within(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (relation !== ".." && !relation.startsWith(".." + sep) && !isAbsolute(relation));
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile();
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function safeText(value: string, maximum = 240): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{3,}={0,2}/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|cookie|set-cookie|auth[_-]?token|oauth[_-]?token|token|access[_-]?token|refresh[_-]?token|session(?:[_-]?(?:id|token|key))?|storage[_-]?state|api[_-]?key|password|secret|client[_-]?secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gi, "https://[REDACTED]@")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'<>]*/gi, "[LOCAL_PATH]")
    .replace(/(^|[\s("'=])\/(?!\/)(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/g, "$1[LOCAL_PATH]")
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

function safeId(value: string): string {
  const cleaned = safeText(value, 128);
  return identifier.safeParse(cleaned).success ? cleaned : "[unavailable]";
}

function safeFilename(value: string): string {
  const leaf = value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "file";
  return safeText(leaf, 100);
}

function projectProbe(asset: MediaAsset): Record<string, unknown> {
  const probe = asset.probe;
  return {
    ...(probe.durationMs !== undefined ? { durationMs: probe.durationMs } : {}),
    ...(probe.width !== undefined ? { width: probe.width } : {}),
    ...(probe.height !== undefined ? { height: probe.height } : {}),
    ...(probe.fps !== undefined ? { fps: probe.fps } : {}),
    ...(probe.videoCodec ? { videoCodec: safeText(probe.videoCodec, 40) } : {}),
    ...(probe.audioCodec ? { audioCodec: safeText(probe.audioCodec, 40) } : {}),
    ...(probe.channels !== undefined ? { channels: probe.channels } : {}),
    ...(probe.sampleRateHz !== undefined ? { sampleRateHz: probe.sampleRateHz } : {}),
  };
}

function provenanceProjection(asset: MediaAsset): Record<string, unknown> {
  const provenance = asset.provenance;
  if (provenance.kind === "browser") {
    return {
      kind: provenance.kind,
      flowId: safeId(provenance.flowId),
      sceneKey: safeId(provenance.sceneKey),
      actionIds: provenance.actionIds.slice(0, 32).map(safeId),
      checkpointActionId: safeId(provenance.checkpointActionId),
      capturedAt: provenance.capturedAt,
      ...(provenance.predecessorAssetId ? { predecessorAssetId: safeId(provenance.predecessorAssetId) } : {}),
    };
  }
  if (provenance.kind === "upload") {
    return {
      kind: provenance.kind,
      originalFilename: safeFilename(provenance.originalFilename),
      importedAt: provenance.importedAt,
      sourceSha256: provenance.sourceSha256,
      importMethod: provenance.importMethod,
      originalProbe: {
        ...(provenance.originalProbe.durationMs !== undefined ? { durationMs: provenance.originalProbe.durationMs } : {}),
        ...(provenance.originalProbe.width !== undefined ? { width: provenance.originalProbe.width } : {}),
        ...(provenance.originalProbe.height !== undefined ? { height: provenance.originalProbe.height } : {}),
        ...(provenance.originalProbe.fps !== undefined ? { fps: provenance.originalProbe.fps } : {}),
        ...(provenance.originalProbe.videoCodec ? { videoCodec: safeText(provenance.originalProbe.videoCodec, 40) } : {}),
        ...(provenance.originalProbe.audioCodec ? { audioCodec: safeText(provenance.originalProbe.audioCodec, 40) } : {}),
        ...(provenance.originalProbe.channels !== undefined ? { channels: provenance.originalProbe.channels } : {}),
        ...(provenance.originalProbe.sampleRateHz !== undefined ? { sampleRateHz: provenance.originalProbe.sampleRateHz } : {}),
      },
    };
  }
  return {
    kind: provenance.kind,
    generator: safeText(provenance.generator, 100),
    generatedAt: provenance.generatedAt,
    inputAssetIds: provenance.inputRefs.slice(0, 32).map(safeId),
  };
}

function page<T, U>(values: T[], project: (value: T) => U, offsetValue?: number, limitValue?: number): { total: number; offset: number; limit: number; nextOffset: number | null; items: U[] } {
  const offset = offsetValue ?? 0;
  const limit = limitValue ?? DEFAULT_PAGE_SIZE;
  const selected = values.slice(offset, offset + limit);
  const items = selected.map(project);
  const next = offset + selected.length;
  return { total: values.length, offset, limit, nextOffset: next < values.length ? next : null, items };
}

function projectSummary(project: ProjectV2): Record<string, unknown> {
  return {
    projectId: safeId(project.projectId),
    currentRevisionId: safeId(project.currentRevisionId),
    revisionCount: project.revisions.length,
    brief: {
      ...(project.brief.audience ? { audience: safeText(project.brief.audience) } : {}),
      ...(project.brief.message ? { message: safeText(project.brief.message, 500) } : {}),
      ...(project.brief.targetDurationMs !== undefined ? { targetDurationMs: project.brief.targetDurationMs } : {}),
    },
    composition: {
      width: project.composition.width,
      height: project.composition.height,
      fps: project.composition.fps,
      durationMs: project.composition.durationMs,
    },
    assetCount: Object.keys(project.assets).length,
    clipCount: project.composition.clips.length,
    trackCount: project.composition.tracks.length,
    layerCount: project.composition.layers.length,
  };
}

function assetSummary(asset: MediaAsset): Record<string, unknown> {
  return { assetId: safeId(asset.id), type: asset.type, sha256: asset.sha256, probe: projectProbe(asset), provenance: provenanceProjection(asset) };
}

function clipSummary(clip: ProjectV2["composition"]["clips"][number]): Record<string, unknown> {
  return {
    clipId: safeId(clip.id),
    assetId: safeId(clip.assetId),
    trackId: safeId(clip.trackId),
    timelineStartMs: clip.timelineStartMs,
    sourceInMs: clip.sourceInMs,
    sourceOutMs: clip.sourceOutMs,
    speed: clip.speed,
    transform: clip.transform,
    ...(clip.crop ? { crop: clip.crop } : {}),
    opacity: clip.opacity,
    audioGainDb: clip.audioGainDb,
    muted: clip.muted,
    ...(clip.transitionOut ? { transitionOut: clip.transitionOut } : {}),
  };
}

function verificationSummary(project: ProjectV2): Record<string, unknown> {
  return {
    revisionId: safeId(project.verification.revisionId),
    status: project.verification.status,
    currentRevision: project.verification.revisionId === project.currentRevisionId,
    outputCount: project.outputs.length,
    outputs: project.outputs.slice(-4).map((output) => ({
      outputId: safeId(output.outputId),
      sha256: output.sha256,
      sourceRevisionId: safeId(output.sourceRevisionId),
      renderJobHash: output.renderJobHash,
      backendId: safeText(output.backendId, 80),
      backendVersion: safeText(output.backendVersion, 40),
      probe: {
        ...(output.probe.durationMs !== undefined ? { durationMs: output.probe.durationMs } : {}),
        ...(output.probe.width !== undefined ? { width: output.probe.width } : {}),
        ...(output.probe.height !== undefined ? { height: output.probe.height } : {}),
        ...(output.probe.fps !== undefined ? { fps: output.probe.fps } : {}),
        ...(output.probe.videoCodec ? { videoCodec: safeText(output.probe.videoCodec, 40) } : {}),
        ...(output.probe.audioCodec ? { audioCodec: safeText(output.probe.audioCodec, 40) } : {}),
      },
    })),
  };
}

function operationSummary(record: OperationLogRecord): Record<string, unknown> {
  const input = record.input;
  let detail = input.type.replaceAll("_", " ");
  switch (input.type) {
    case "import_asset": detail = "Imported " + input.asset.type + " asset " + safeId(input.asset.id); break;
    case "remove_asset": detail = "Removed asset " + safeId(input.assetId); break;
    case "create_clip": detail = "Created clip " + safeId(input.clip.id) + " from " + safeId(input.clip.assetId); break;
    case "trim_clip": detail = "Trimmed clip " + safeId(input.clipId) + " to " + input.sourceInMs + "–" + input.sourceOutMs + " ms"; break;
    case "move_clip": detail = "Moved clip " + safeId(input.clipId) + " to " + input.timelineStartMs + " ms"; break;
    case "set_speed": detail = "Set clip " + safeId(input.clipId) + " speed to " + input.speed + "×"; break;
    case "set_volume": detail = "Set clip " + safeId(input.clipId) + " gain to " + input.audioGainDb + " dB"; break;
    case "mute_clip": detail = (input.muted ? "Muted" : "Unmuted") + " clip " + safeId(input.clipId); break;
    case "set_opacity": detail = "Set opacity on " + safeId(input.clipId ?? input.layerId ?? "target") + " to " + input.opacity; break;
    case "set_transition": detail = "Set " + input.transition.type + " transition on clip " + safeId(input.clipId); break;
    case "set_transform": detail = "Reframed clip " + safeId(input.clipId); break;
    case "replace_asset": detail = "Replaced clip " + safeId(input.clipId) + " source with " + safeId(input.assetId); break;
    case "remove_clip": detail = "Removed clip " + safeId(input.clipId); break;
    case "add_text_layer": detail = "Added title layer: " + safeText("text" in input.layer.properties ? input.layer.properties.text : "", 80); break;
    case "update_text_layer": detail = "Updated title layer: " + safeText(input.properties.text, 80); break;
    case "remove_layer": detail = "Removed layer " + safeId(input.layerId); break;
    case "add_image_layer": detail = "Added image layer " + safeId(input.layer.id); break;
    case "animate_property": detail = "Animated " + input.keyframes.length + " keyframe(s) on layer " + safeId(input.layerId); break;
    case "apply_motion_preset": detail = "Applied motion preset " + safeId(input.presetId) + " to " + safeId(input.targetId); break;
    case "recapture_browser_asset": detail = "Recaptured browser asset " + safeId(input.assetId) + ": " + safeText(input.reason, 80); break;
    case "replace_browser_capture": detail = "Replaced browser asset " + safeId(input.previousAssetId) + " after " + safeText(input.reason, 80); break;
    case "split_clip": detail = "Split clip " + safeId(input.clipId) + " at " + input.atTimelineMs + " ms"; break;
  }
  return {
    operationId: safeId(record.id),
    revisionId: safeId(record.resultRevisionId),
    actor: record.actor,
    operationType: input.type,
    summary: safeText(detail, 180),
    createdAt: record.createdAt,
  };
}

function operationHistory(project: ProjectV2, input: readonly OperationLogRecord[], limitValue?: number): Record<string, unknown> {
  const knownRevisions = new Set(project.revisions.map((revision) => revision.id));
  const scanned = input.slice(-MAX_OPERATION_SCAN);
  const records = scanned.flatMap((record) => {
    const parsed = OperationLogRecordSchema.safeParse(record);
    return parsed.success && knownRevisions.has(parsed.data.resultRevisionId) ? [parsed.data] : [];
  });
  const items = records.slice(-(limitValue ?? 10)).map(operationSummary);
  return { total: records.length, truncated: input.length > scanned.length, items };
}

export async function inspectProjectV2(requestInput: unknown, context: V2InspectionContext): Promise<V2InspectResult> {
  const parsedRequest = V2InspectRequestSchema.safeParse(requestInput);
  if (!parsedRequest.success) return failure("INVALID_REQUEST");
  if (context.responseByteLimit !== undefined && (!Number.isInteger(context.responseByteLimit) || context.responseByteLimit < 1)) return failure("INVALID_REQUEST");
  if (context.imageByteBudget !== undefined && (!Number.isInteger(context.imageByteBudget) || context.imageByteBudget < 0)) return failure("INVALID_REQUEST");
  const parsedProject = ProjectV2Schema.safeParse(context.project);
  if (!parsedProject.success) return failure("INVALID_PROJECT");
  const project = parsedProject.data;
  const request = parsedRequest.data;
  let result: V2InspectResult;

  switch (request.kind) {
    case "project_summary":
      result = { ok: true, kind: request.kind, data: projectSummary(project), evidenceRefs: [] };
      break;
    case "assets": {
      const assets = Object.entries(project.assets).sort(([left], [right]) => left.localeCompare(right));
      result = { ok: true, kind: request.kind, data: page(assets, ([, asset]) => assetSummary(asset), request.offset, request.limit), evidenceRefs: [] };
      break;
    }
    case "clips": {
      const clips = [...project.composition.clips]
        .sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.id.localeCompare(right.id));
      result = { ok: true, kind: request.kind, data: page(clips, clipSummary, request.offset, request.limit), evidenceRefs: [] };
      break;
    }
    case "media_evidence":
      result = await inspectMediaEvidence(request, project, context);
      break;
    case "verification":
      result = { ok: true, kind: request.kind, data: verificationSummary(project), evidenceRefs: [] };
      break;
    case "operation_history":
      result = { ok: true, kind: request.kind, data: operationHistory(project, context.operationLog ?? [], request.limit), evidenceRefs: [] };
      break;
  }

  const imageBytes = result.ok ? (result.images ?? []).reduce((sum, image) => sum + image.bytes.byteLength, 0) : 0;
  const dataForSize = result.ok ? { ...result, images: result.images?.map(({ bytes: _bytes, ...image }) => image) } : result;
  const serializedBytes = Buffer.byteLength(JSON.stringify(dataForSize), "utf8") + imageBytes;
  const maximum = Math.min(context.responseByteLimit ?? DEFAULT_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
  return serializedBytes > maximum ? failure("OUTPUT_LIMIT") : result;
}

async function inspectMediaEvidence(
  request: Extract<V2InspectRequest, { kind: "media_evidence" }>,
  project: ProjectV2,
  context: V2InspectionContext,
): Promise<V2InspectResult> {
  const asset = project.assets[request.assetId];
  if (!asset) return failure("INVALID_REQUEST");
  const base = {
    assetId: safeId(asset.id),
    type: asset.type,
    probe: projectProbe(asset),
    provenance: provenanceProjection(asset),
    transcriptStatus: "unavailable",
  };
  const matching = (context.evidenceIndexes ?? []).filter((candidate) => candidate && candidate.sourceAssetId === asset.id);
  if (matching.length === 0) {
    return makeEvidenceResult(request, { ...base, status: "unavailable", visualStatus: request.image ? "unavailable" : "not_requested" }, []);
  }
  if (matching.length !== 1) {
    return makeEvidenceResult(request, { ...base, status: "invalid", visualStatus: request.image ? "unavailable" : "not_requested" }, []);
  }
  const parsedIndex = MediaEvidenceIndexSchema.safeParse(matching[0]);
  if (!parsedIndex.success) {
    return makeEvidenceResult(request, { ...base, status: "invalid", visualStatus: request.image ? "unavailable" : "not_requested" }, []);
  }
  const index = parsedIndex.data;
  if (index.sourceSha256 !== asset.sha256) {
    return makeEvidenceResult(request, { ...base, status: "stale", visualStatus: request.image ? "unavailable" : "not_requested" }, []);
  }
  if (!context.evidenceRoot || !isAbsolute(context.evidenceRoot)) {
    return makeEvidenceResult(request, { ...base, status: "unavailable", visualStatus: request.image ? "unavailable" : "not_requested" }, []);
  }

  try {
    const root = await checkedEvidenceRoot(context.evidenceRoot);
    const indexBytes = await readEvidenceFile(root, index.indexRef, MAX_EVIDENCE_INDEX_BYTES);
    const diskIndex = MediaEvidenceIndexSchema.parse(JSON.parse(indexBytes.toString("utf8")));
    if (canonicalJson(diskIndex) !== canonicalJson(index)) throw new Error("index mismatch");
    if (diskIndex.sourceAssetId !== asset.id || diskIndex.sourceSha256 !== asset.sha256) {
      return makeEvidenceResult(request, { ...base, status: "stale", visualStatus: request.image ? "unavailable" : "not_requested" }, []);
    }
    validateArtifactNames(index);

    const refs: string[] = [];
    const evidence: SafeEvidence = { status: "available" };
    const probeArtifact = oneArtifact(index, "probe");
    if (probeArtifact) {
      const bytes = await readVerifiedArtifact(root, probeArtifact);
      evidence.probe = projectEvidenceProbe(probeEvidenceSchema.parse(JSON.parse(bytes.toString("utf8"))));
      refs.push(probeArtifact.ref);
    }
    const scenesArtifact = oneArtifact(index, "scene_boundaries");
    if (scenesArtifact) {
      const bytes = await readVerifiedArtifact(root, scenesArtifact);
      evidence.sceneBoundariesMs = sceneEvidenceSchema.parse(JSON.parse(bytes.toString("utf8"))).boundariesMs;
      refs.push(scenesArtifact.ref);
    }
    const audioArtifact = oneArtifact(index, "audio_summary");
    if (audioArtifact) {
      const bytes = await readVerifiedArtifact(root, audioArtifact);
      const audio = audioEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
      evidence.audio = {
        peakDbfs: audio.peakDbfs,
        meanDbfs: audio.meanDbfs,
        silenceSegmentCount: audio.silenceSegments.length,
        silenceSegments: audio.silenceSegments,
        loudness: audio.loudness,
      };
      refs.push(audioArtifact.ref);
    }

    const images: V2InspectImage[] = [];
    let visualStatus: "not_requested" | "available" | "unavailable" | "omitted_budget" = "not_requested";
    if (request.image) {
      visualStatus = "unavailable";
      const candidate = request.image === "contact_sheet"
        ? oneArtifact(index, "contact_sheet")
        : index.artifacts.filter((artifact) => artifact.kind === "selected_frame")
          .sort((left, right) => (left.timestampMs ?? 0) - (right.timestampMs ?? 0))[request.frameOffset ?? 0];
      if (candidate) {
        const imageBudget = Math.min(context.imageByteBudget ?? DEFAULT_IMAGE_BUDGET, MAX_IMAGE_RESPONSE_BYTES);
        if (candidate.sizeBytes > imageBudget) {
          visualStatus = "omitted_budget";
        } else {
          const bytes = await readVerifiedArtifact(root, candidate);
          if (!validImageHeader(bytes, candidate.contentType)) throw new Error("invalid evidence image bytes");
          images.push({ ref: candidate.ref, mimeType: candidate.contentType as V2InspectImage["mimeType"], bytes: new Uint8Array(bytes) });
          refs.push(candidate.ref);
          visualStatus = "available";
        }
      }
    }

    return makeEvidenceResult(request, {
      ...base,
      ...evidence,
      visualStatus,
      ...(request.image === "selected_frame" ? {
        visualTimestampMs: index.artifacts
          .filter((artifact) => artifact.kind === "selected_frame")
          .sort((left, right) => (left.timestampMs ?? 0) - (right.timestampMs ?? 0))[request.frameOffset ?? 0]?.timestampMs,
      } : {}),
    }, refs, images);
  } catch {
    return makeEvidenceResult(request, { ...base, status: "invalid", visualStatus: request.image ? "unavailable" : "not_requested" }, []);
  }
}

function projectEvidenceProbe(probe: z.infer<typeof probeEvidenceSchema>): ProbeProjection {
  return {
    ...(probe.durationMs !== undefined ? { durationMs: probe.durationMs } : {}),
    ...(probe.bitRateBps !== undefined ? { bitRateBps: probe.bitRateBps } : {}),
    streams: probe.streams.map((stream) => ({
      index: stream.index,
      type: stream.type,
      ...(stream.codec ? { codec: safeText(stream.codec, 64) } : {}),
      ...(stream.width !== undefined ? { width: stream.width } : {}),
      ...(stream.height !== undefined ? { height: stream.height } : {}),
      ...(stream.fps !== undefined ? { fps: stream.fps } : {}),
      ...(stream.sampleRateHz !== undefined ? { sampleRateHz: stream.sampleRateHz } : {}),
      ...(stream.channels !== undefined ? { channels: stream.channels } : {}),
    })),
  };
}

function validImageHeader(bytes: Buffer, contentType: MediaEvidenceArtifact["contentType"]): boolean {
  if (contentType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return false;
}

function makeEvidenceResult(
  request: Extract<V2InspectRequest, { kind: "media_evidence" }>,
  data: Record<string, unknown>,
  evidenceRefs: string[],
  images: V2InspectImage[] = [],
): V2InspectResult {
  return {
    ok: true,
    kind: request.kind,
    data,
    evidenceRefs: [...new Set(evidenceRefs)],
    ...(images.length ? { images } : {}),
  };
}

function oneArtifact(index: MediaEvidenceIndex, kind: MediaEvidenceArtifact["kind"]): MediaEvidenceArtifact | undefined {
  const matching = index.artifacts.filter((artifact) => artifact.kind === kind);
  if (matching.length > 1) throw new Error("duplicate artifact kind");
  return matching[0];
}

function validateArtifactNames(index: MediaEvidenceIndex): void {
  const runPrefix = index.indexRef.slice(0, -"index.json".length);
  const refs = new Set<string>();
  for (const artifact of index.artifacts) {
    const extension = artifact.contentType === "application/json" ? "json" : artifact.contentType === "image/png" ? "png" : "jpg";
    const expected = runPrefix + artifact.kind.replaceAll("_", "-") + "-" + artifact.sha256 + "." + extension;
    if (artifact.ref !== expected || refs.has(artifact.ref)) throw new Error("invalid artifact reference");
    refs.add(artifact.ref);
  }
}

async function checkedEvidenceRoot(evidenceRoot: string): Promise<string> {
  const info = await lstat(evidenceRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe evidence root");
  const canonical = await realpath(evidenceRoot);
  if (!samePath(evidenceRoot, canonical)) throw new Error("non-canonical evidence root");
  return canonical;
}

async function readEvidenceFile(root: string, ref: string, maximumBytes: number): Promise<Buffer> {
  const parts = ref.split("/");
  if (parts.length < 4 || parts[0] !== "media-evidence" || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error("unsafe evidence reference");
  }
  const target = resolve(root, ...parts);
  if (!within(root, target)) throw new Error("evidence path escaped root");

  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) throw new Error("evidence path contains a symlink");
    const actual = await realpath(current);
    if (!within(root, actual) || !samePath(actual, current)) throw new Error("evidence path escaped root");
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error("evidence parent is not a directory");
  }

  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error("evidence file is not a bounded immutable file");
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(target, constants.O_RDONLY | NOFOLLOW);
    const opened = await file.stat({ bigint: true });
    if (!sameSnapshot(before, opened) || opened.nlink !== 1n) throw new Error("evidence file changed before read");
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (!sameSnapshot(opened, after) || bytes.byteLength !== Number(after.size) || bytes.byteLength > maximumBytes) {
      throw new Error("evidence file changed during read");
    }
    return bytes;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readVerifiedArtifact(root: string, artifact: MediaEvidenceArtifact): Promise<Buffer> {
  if (artifact.sizeBytes > MAX_EVIDENCE_ARTIFACT_BYTES) throw new Error("artifact exceeds its declared maximum");
  const bytes = await readEvidenceFile(root, artifact.ref, MAX_EVIDENCE_ARTIFACT_BYTES);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== artifact.sizeBytes || digest !== artifact.sha256) throw new Error("artifact hash mismatch");
  return bytes;
}
