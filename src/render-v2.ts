import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstatSync, readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { assertIssuedMotionArtifactHandle, buildMotionExecutionJobV1, resolveMotionArtifactHandle, type MotionArtifactHandle } from "./motion-v2.js";
import { semanticHashV2 } from "./operations-v2.js";
import { resolveRenderFont } from "./render.js";
import { AssetHandleSchema, ProjectV2Schema, RenderOutputSchemaV2, TransitionV2Schema, VerificationRefSchema, type AssetHandle, type MediaProbeV2, type ProjectV2 } from "./schema-v2.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInt = z.number().int().finite().positive();
const finite = z.number().finite();
export const MAX_RENDER_ARTIFACT_BYTES = 512 * 1024 * 1024;
const jobPayloadSchema = z.object({
  jobVersion: z.literal(1),
  projectId: z.string().min(1),
  sourceRevisionId: z.string().min(1),
  sourceRevisionHash: sha256Schema,
  assetHandle: AssetHandleSchema,
  source: z.object({ width: positiveInt, height: positiveInt, hasAudio: z.boolean() }).strict(),
  composition: z.object({ width: positiveInt, height: positiveInt, fps: z.number().positive().finite(), durationMs: positiveInt }).strict(),
  clip: z.object({
    id: z.string().min(1),
    sourceInMs: z.number().int().nonnegative(),
    sourceOutMs: positiveInt,
    speed: z.number().min(0.25).max(4),
    transform: z.object({ x: finite, y: finite, scale: z.number().positive(), rotation: finite, anchorX: z.number().min(0).max(1), anchorY: z.number().min(0).max(1) }).strict(),
    crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict().optional(),
    opacity: z.number().min(0).max(1),
    audioGainDb: finite,
    muted: z.boolean(),
  }).strict(),
}).strict();

const compositionVideoClipSchema = jobPayloadSchema.shape.clip.extend({
  assetId: z.string().min(1),
  timelineStartMs: z.number().int().nonnegative(),
  transitionOut: TransitionV2Schema.optional(),
});
const compositionLayerSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1), kind: z.literal("text"), timelineStartMs: z.number().int().nonnegative(), durationMs: positiveInt,
    text: z.string().min(1).max(1024), fontSize: z.number().int().min(8).max(96), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }).strict(),
  z.object({
    id: z.string().min(1), kind: z.literal("image"), timelineStartMs: z.number().int().nonnegative(), durationMs: positiveInt, assetId: z.string().min(1),
  }).strict(),
]);
const compositionJobPayloadSchema = z.object({
  jobVersion: z.literal(2),
  projectId: z.string().min(1),
  sourceRevisionId: z.string().min(1),
  sourceRevisionHash: sha256Schema,
  assetInputs: z.array(z.object({
    assetId: z.string().min(1),
    handle: AssetHandleSchema,
    kind: z.enum(["video", "audio", "image"]),
    source: z.object({ width: positiveInt.optional(), height: positiveInt.optional(), durationMs: positiveInt.optional(), hasAudio: z.boolean() }).strict(),
  }).strict()).min(1).max(4),
  composition: z.object({ width: positiveInt, height: positiveInt, fps: z.number().positive().finite(), durationMs: positiveInt, outputDurationMs: positiveInt }).strict(),
  videoClips: z.array(compositionVideoClipSchema).min(1).max(2),
  audioClip: z.object({ id: z.string().min(1), assetId: z.string().min(1), sourceInMs: z.number().int().nonnegative(), sourceOutMs: positiveInt, speed: z.number().min(0.25).max(4), audioGainDb: finite, muted: z.boolean() }).strict().optional(),
  layers: z.array(compositionLayerSchema).max(2),
  fontSha256: sha256Schema.optional(),
}).strict();
const compositionMotionArtifactSchema = z.object({
  artifactId: z.string().uuid(),
  ref: z.string().regex(/^\.replex-staging\/motion\/jobs\/[0-9a-f-]{36}\/motion\.mp4$/),
  sha256: sha256Schema,
  motionJobHash: sha256Schema,
  sourceRevisionId: z.string().min(1),
  sourceRevisionHash: sha256Schema,
  targetClipId: z.string().min(1),
  sourceAssetId: z.string().min(1),
}).strict();
const compositionVideoClipV3Schema = compositionVideoClipSchema.extend({ motionArtifact: compositionMotionArtifactSchema.optional() });
const motionCompositionJobPayloadSchema = compositionJobPayloadSchema.extend({
  jobVersion: z.literal(3),
  videoClips: z.array(compositionVideoClipV3Schema).min(1).max(2),
});

type JobPayload = z.infer<typeof jobPayloadSchema>;
type CompositionJobPayload = z.infer<typeof compositionJobPayloadSchema>;
type MotionCompositionJobPayload = z.infer<typeof motionCompositionJobPayloadSchema>;
type FrozenJobPayload = JobPayload | CompositionJobPayload | MotionCompositionJobPayload;
type FrozenRenderJob = MediaExecutionJob | CompositionExecutionJob | CompositionExecutionJobV3;
const frozenJobPayloadSchema = z.discriminatedUnion("jobVersion", [jobPayloadSchema, compositionJobPayloadSchema, motionCompositionJobPayloadSchema]);
type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly unknown[] ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type MediaExecutionJob = DeepReadonly<JobPayload & { jobHash: string }>;
export type CompositionExecutionJob = DeepReadonly<CompositionJobPayload & { jobHash: string }>;
export type CompositionExecutionJobV3 = DeepReadonly<MotionCompositionJobPayload & { jobHash: string }>;

export interface ResolvedAssetHandle {
  assetId: string;
  sha256: string;
  ref: string;
  path: string;
}

export interface MediaExecutionAuthorization {
  projectRoot: string;
  resolvedHandles: readonly ResolvedAssetHandle[];
  isRevisionCurrent: (revisionId: string, semanticHash: string) => boolean | Promise<boolean>;
}

export interface MediaExecutionOptions {
  /** Host-owned path to a trusted native direct FFmpeg binary; wrappers are unsupported because cancellation drains this child process. */
  ffmpegPath?: string;
  /** Host-owned path to a trusted native direct FFprobe binary. */
  ffprobePath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MediaExecutionPreflight {
  status: "passed";
  sourceRevisionId: string;
  sourceRevisionHash: string;
  assetId: string;
  assetSha256: string;
}

export interface CompositionExecutionPreflight {
  status: "passed";
  sourceRevisionId: string;
  sourceRevisionHash: string;
  assets: Array<{ assetId: string; sha256: string }>;
}

export interface RenderArtifactV2 {
  outputId: string;
  ref: string;
  sha256: string;
  probe: MediaProbeV2;
  sourceRevisionId: string;
  sourceRevisionHash: string;
  renderJobHash: string;
  backendId: "native-ffmpeg";
  backendVersion: string;
  ffmpegVersion: string;
  verificationRefId: string;
  verification: {
    id: string;
    status: "passed";
    revisionId: string;
    evidenceRefs: string[];
    evidenceSha256: string;
    sourceRevisionHash: string;
    renderJobHash: string;
    artifactSha256: string;
    checks: { probe: true; decode: true; hash: true };
  };
}

/** Records a verified render as derived project state without changing its semantic revision. */
export function registerRenderArtifactV2(projectInput: ProjectV2, artifact: RenderArtifactV2): ProjectV2 {
  const project = ProjectV2Schema.parse(projectInput);
  const revision = project.revisions.find(({ id }) => id === project.currentRevisionId);
  const verification = artifact.verification;
  if (!revision || revision.manifestSha256 !== semanticHashV2(project)
    || artifact.sourceRevisionId !== project.currentRevisionId
    || artifact.sourceRevisionHash !== revision.manifestSha256) {
    throw new Error("render artifact does not target the current project revision");
  }
  if (verification.status !== "passed" || verification.id !== artifact.verificationRefId
    || verification.revisionId !== artifact.sourceRevisionId
    || verification.sourceRevisionHash !== artifact.sourceRevisionHash
    || verification.renderJobHash !== artifact.renderJobHash
    || verification.artifactSha256 !== artifact.sha256
    || !verification.checks.probe || !verification.checks.decode || !verification.checks.hash
    || !/^[a-f0-9]{64}$/.test(verification.evidenceSha256)
    || verification.evidenceRefs.length === 0) {
    throw new Error("render artifact verification receipt is inconsistent");
  }

  const output = RenderOutputSchemaV2.parse({
    outputId: artifact.outputId,
    ref: artifact.ref,
    sha256: artifact.sha256,
    probe: artifact.probe,
    sourceRevisionId: artifact.sourceRevisionId,
    revisionId: artifact.sourceRevisionId,
    renderJobHash: artifact.renderJobHash,
    backendId: artifact.backendId,
    backendVersion: artifact.backendVersion,
    verificationRefId: artifact.verificationRefId,
  });
  const verificationRef = VerificationRefSchema.parse({
    id: artifact.verificationRefId,
    revisionId: artifact.sourceRevisionId,
    status: "passed",
    evidenceRefs: artifact.verification.evidenceRefs,
  });
  const existingOutput = project.outputs.find(({ outputId }) => outputId === output.outputId);
  if (existingOutput && canonicalJson(existingOutput) !== canonicalJson(output)) throw new Error("render output ID already refers to different data");
  const existingRef = project.verification.refs.find(({ id }) => id === verificationRef.id);
  if (existingRef && canonicalJson(existingRef) !== canonicalJson(verificationRef)) throw new Error("verification ID already refers to different data");

  if (!existingOutput) project.outputs.push(output);
  project.verification = {
    revisionId: artifact.sourceRevisionId,
    status: "passed",
    refs: existingRef ? project.verification.refs : [...project.verification.refs, verificationRef],
  };
  return ProjectV2Schema.parse(project);
}

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value as DeepReadonly<T>;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function boundedDigestFile(path: string): Promise<{ sha256: string; size: number }> {
  const before = await stat(path);
  if (!before.isFile() || before.size > MAX_RENDER_ARTIFACT_BYTES) throw new Error("render artifact exceeds the local size limit");
  const sha256 = await digestFile(path);
  const after = await stat(path);
  if (!after.isFile() || after.size > MAX_RENDER_ARTIFACT_BYTES || after.size !== before.size) throw new Error("render artifact changed or exceeded the local size limit while hashing");
  return { sha256, size: after.size };
}

function assertJobHash(job: MediaExecutionJob): JobPayload {
  const { jobHash, ...payload } = job;
  const parsed = jobPayloadSchema.parse(payload);
  if (digest(canonicalJson(parsed)) !== jobHash) throw new Error("media execution job hash does not match its frozen plan");
  return parsed;
}

/** Plans only one uploaded-video clip; the backend receives no ProjectV2 object. */
export function buildMediaExecutionJob(projectInput: ProjectV2, handles: readonly AssetHandle[]): MediaExecutionJob {
  const project = ProjectV2Schema.parse(projectInput);
  if (project.composition.motionPresets?.length) throw new Error("motion presets require composition execution job v3");
  if (project.composition.clips.length !== 1) throw new Error("native V2 render requires exactly one video clip");
  if (project.composition.layers.length) throw new Error("native V2 render does not support composition layers");
  if (project.composition.width < 16 || project.composition.height < 16 || project.composition.width % 2 !== 0 || project.composition.height % 2 !== 0
    || project.composition.width > 4096 || project.composition.height > 4096 || project.composition.fps < 1 || project.composition.fps > 60
    || project.composition.durationMs > 120_000) {
    throw new Error("composition exceeds native V2 render limits");
  }

  const revision = project.revisions.find(({ id }) => id === project.currentRevisionId);
  const sourceRevisionHash = semanticHashV2(project);
  if (!revision || revision.manifestSha256 !== sourceRevisionHash) throw new Error("current revision manifest hash does not match semantic project state");

  const clip = project.composition.clips[0];
  const asset = project.assets[clip.assetId];
  const track = project.composition.tracks.find(({ id }) => id === clip.trackId);
  if (!asset || asset.type !== "uploaded_video" || asset.provenance.kind !== "upload") throw new Error("native V2 render supports one uploaded video asset");
  if (!track || track.kind !== "video") throw new Error("native V2 render clip must use a video track");
  if (clip.timelineStartMs !== 0 || Math.abs((clip.sourceOutMs - clip.sourceInMs) / clip.speed - project.composition.durationMs) > 1) {
    throw new Error("single clip must fill the canonical composition duration from timeline zero");
  }
  if (!asset.probe.width || asset.probe.width < 2 || !asset.probe.height || asset.probe.height < 2 || !asset.probe.durationMs || clip.sourceOutMs > asset.probe.durationMs) {
    throw new Error("uploaded video requires valid dimensions and duration within the source");
  }
  if (Math.abs(clip.transform.x) > project.composition.width * 2 || Math.abs(clip.transform.y) > project.composition.height * 2
    || clip.transform.scale > 8 || Math.max(project.composition.width, project.composition.height) * clip.transform.scale > 8192
    || Math.abs(clip.transform.rotation) > 360 || clip.audioGainDb < -60 || clip.audioGainDb > 24) {
    throw new Error("clip transform or audio gain exceeds native V2 render limits");
  }

  const supplied = handles.map((handle) => AssetHandleSchema.parse(handle)).find(({ assetId }) => assetId === asset.id);
  if (!supplied || supplied.sha256 !== asset.sha256 || supplied.ref !== (asset.path ?? asset.objectRef)) {
    throw new Error("authorized asset handle does not match the selected immutable upload");
  }

  const payload = jobPayloadSchema.parse({
    jobVersion: 1,
    projectId: project.projectId,
    sourceRevisionId: project.currentRevisionId,
    sourceRevisionHash,
    assetHandle: supplied,
    source: { width: asset.probe.width, height: asset.probe.height, hasAudio: asset.probe.audioCodec !== undefined },
    composition: { width: project.composition.width, height: project.composition.height, fps: project.composition.fps, durationMs: project.composition.durationMs },
    clip: {
      id: clip.id,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed: clip.speed,
      transform: clip.transform,
      ...(clip.crop ? { crop: clip.crop } : {}),
      opacity: clip.opacity,
      audioGainDb: clip.audioGainDb,
      muted: clip.muted || track.muted,
    },
  });
  return freezeDeep({ ...payload, jobHash: digest(canonicalJson(payload)) }) as MediaExecutionJob;
}

function assertFrozenJobHash(job: FrozenRenderJob): FrozenJobPayload {
  const { jobHash, ...payloadInput } = job;
  const payload = frozenJobPayloadSchema.parse(payloadInput);
  if (digest(canonicalJson(payload)) !== jobHash) throw new Error("media execution job hash does not match its frozen plan");
  return payload;
}

function compositionFontSha256(): string {
  const { file } = resolveRenderFont();
  const info = lstatSync(file);
  if (extname(file).toLowerCase() !== ".ttf" || info.isSymbolicLink() || !info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("composition font must be a bounded regular TrueType file");
  return digest(readFileSync(file));
}

/** Plans the bounded native 2D profile without exposing ProjectV2 or host paths to the backend. */
export function buildCompositionExecutionJob(projectInput: ProjectV2, handles: readonly AssetHandle[]): CompositionExecutionJob {
  return planCompositionExecutionJob(projectInput, handles) as CompositionExecutionJob;
}

/** Plans job v3 with executor-issued motion artifacts while retaining original source handles for canonical audio. */
export function buildCompositionExecutionJobV3(
  projectInput: ProjectV2,
  handles: readonly AssetHandle[],
  motionArtifactHandles: readonly MotionArtifactHandle[],
): CompositionExecutionJobV3 {
  return planCompositionExecutionJob(projectInput, handles, motionArtifactHandles) as CompositionExecutionJobV3;
}

function planCompositionExecutionJob(
  projectInput: ProjectV2,
  handles: readonly AssetHandle[],
  motionArtifactHandles?: readonly MotionArtifactHandle[],
): CompositionExecutionJob | CompositionExecutionJobV3 {
  const project = ProjectV2Schema.parse(projectInput);
  const activeMotion = project.composition.motionPresets ?? [];
  if (activeMotion.length > 0 && motionArtifactHandles === undefined) throw new Error("motion presets require composition execution job v3");
  if (activeMotion.length === 0 && motionArtifactHandles !== undefined) throw new Error("composition job v3 requires active motion presets");
  const { width, height, fps, durationMs } = project.composition;
  if (width < 16 || height < 16 || width % 2 !== 0 || height % 2 !== 0 || width > 4096 || height > 4096 || fps < 1 || fps > 60 || durationMs > 120_000) {
    throw new Error("composition exceeds native V2 render limits");
  }
  const revision = project.revisions.find(({ id }) => id === project.currentRevisionId);
  const sourceRevisionHash = semanticHashV2(project);
  if (!revision || revision.manifestSha256 !== sourceRevisionHash) throw new Error("current revision manifest hash does not match semantic project state");

  const motionByTarget = new Map<string, z.infer<typeof compositionMotionArtifactSchema>>();
  const authorized = new Map<string, AssetHandle>();
  for (const handleInput of handles) {
    const handle = AssetHandleSchema.parse(handleInput);
    const previous = authorized.get(handle.assetId);
    if (previous && canonicalJson(previous) !== canonicalJson(handle)) throw new Error("authorized handles contain conflicting identity for one asset");
    authorized.set(handle.assetId, handle);
  }
  for (const input of motionArtifactHandles ?? []) {
    const handle = assertIssuedMotionArtifactHandle(input);
    const target = project.composition.clips.find(({ id }) => id === handle.targetClipId);
    const sourceHandle = target ? authorized.get(target.assetId) : undefined;
    if (!activeMotion.some(({ targetId }) => targetId === handle.targetClipId) || !target || !sourceHandle || target.assetId !== handle.sourceAssetId
      || motionByTarget.has(handle.targetClipId) || handle.sourceRevisionId !== project.currentRevisionId || handle.sourceRevisionHash !== sourceRevisionHash
      || buildMotionExecutionJobV1(project, handle.targetClipId, sourceHandle).jobHash !== handle.motionJobHash) {
      throw new Error("motion artifact does not match the canonical preset, target, or current source revision");
    }
    motionByTarget.set(handle.targetClipId, compositionMotionArtifactSchema.parse(handle));
  }
  if (motionArtifactHandles !== undefined && motionByTarget.size !== activeMotion.length) throw new Error("every canonical motion preset requires one authorized motion artifact");
  const inputs = new Map<string, CompositionJobPayload["assetInputs"][number]>();
  const addInput = (assetId: string, kind: "video" | "audio" | "image") => {
    const asset = project.assets[assetId];
    if (!asset || !(kind === "video" ? ["uploaded_video", "browser_capture"].includes(asset.type) : kind === "audio" ? asset.type === "audio" : ["image", "generated_graphic"].includes(asset.type))) {
      throw new Error(`composition asset ${assetId} has an unsupported media type`);
    }
    const handle = authorized.get(assetId);
    if (!handle || handle.sha256 !== asset.sha256 || handle.ref !== (asset.path ?? asset.objectRef)) throw new Error("authorized asset handle does not match the selected immutable asset");
    const existing = inputs.get(assetId);
    if (existing) {
      if (existing.kind !== kind) throw new Error("one asset cannot be used with conflicting composition media types");
      return existing;
    }
    const source = kind === "video"
      ? { width: asset.probe.width, height: asset.probe.height, durationMs: asset.probe.durationMs, hasAudio: asset.probe.audioCodec !== undefined }
      : kind === "audio"
        ? { durationMs: asset.probe.durationMs, hasAudio: true }
        : { width: asset.probe.width, height: asset.probe.height, hasAudio: false };
    if (kind !== "audio" && (!source.width || source.width < 2 || source.width > 4096 || !source.height || source.height < 2 || source.height > 4096 || source.width * source.height > 16_777_216)) {
      throw new Error("composition visual asset dimensions exceed native V2 render limits");
    }
    const planned = { assetId, handle, kind, source };
    inputs.set(assetId, planned);
    return planned;
  };

  const videoEntries = project.composition.clips
    .filter((clip) => project.assets[clip.assetId]?.type !== "audio")
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs);
  const audioEntries = project.composition.clips.filter((clip) => project.assets[clip.assetId]?.type === "audio");
  if (videoEntries.length < 1 || videoEntries.length > 2 || audioEntries.length > 1) throw new Error("native composition supports one or two video clips and at most one audio clip");
  if (videoEntries.length === 2 && videoEntries[0]!.assetId === videoEntries[1]!.assetId) throw new Error("native composition requires distinct video assets");
  const primaryTrackId = videoEntries[0]!.trackId;
  const primaryTrack = project.composition.tracks.find(({ id }) => id === primaryTrackId);
  if (!primaryTrack || primaryTrack.kind !== "video" || videoEntries.some(({ trackId }) => trackId !== primaryTrackId)) throw new Error("native composition video clips must use one video track");
  if (videoEntries[0]!.timelineStartMs !== 0) throw new Error("native composition video must start at timeline zero");

  const videoClips = videoEntries.map((clip, index) => {
    const asset = project.assets[clip.assetId]!;
    const track = project.composition.tracks.find(({ id }) => id === clip.trackId)!;
    const input = addInput(clip.assetId, "video");
    if (!input.source.durationMs || clip.sourceOutMs > input.source.durationMs) throw new Error("video clip source range exceeds its immutable asset");
    if (Math.abs(clip.transform.x) > width * 2 || Math.abs(clip.transform.y) > height * 2 || clip.transform.scale > 8
      || Math.max(width, height) * clip.transform.scale > 8192 || Math.abs(clip.transform.rotation) > 360 || clip.audioGainDb < -60 || clip.audioGainDb > 24) {
      throw new Error("clip transform or audio gain exceeds native V2 render limits");
    }
    if (asset.type !== "uploaded_video" && asset.type !== "browser_capture") throw new Error("native composition video input is unsupported");
    const planned = {
      id: clip.id, assetId: clip.assetId, timelineStartMs: clip.timelineStartMs, sourceInMs: clip.sourceInMs, sourceOutMs: clip.sourceOutMs,
      speed: clip.speed, transform: clip.transform, ...(clip.crop ? { crop: clip.crop } : {}), opacity: clip.opacity,
      audioGainDb: clip.audioGainDb, muted: clip.muted || track.muted,
      ...(clip.transitionOut ? { transitionOut: clip.transitionOut } : {}),
      ...(motionByTarget.has(clip.id) ? { motionArtifact: motionByTarget.get(clip.id)! } : {}),
    };
    return motionArtifactHandles === undefined
      ? compositionVideoClipSchema.parse(planned)
      : compositionVideoClipV3Schema.parse(planned);
  });
  if (videoClips.at(-1)!.transitionOut) throw new Error("the final video clip cannot have an outgoing transition");
  const clipDurations = videoClips.map((clip) => (clip.sourceOutMs - clip.sourceInMs) / clip.speed);
  if (videoClips.length === 2 && Math.abs(videoClips[1]!.timelineStartMs - clipDurations[0]!) > 1) throw new Error("native composition video clips must be contiguous");
  const canonicalDuration = clipDurations.reduce((total, duration) => total + duration, 0);
  if (Math.abs(canonicalDuration - durationMs) > 1) throw new Error("native composition video clips must fill the canonical duration");
  const transition = videoClips[0]!.transitionOut;
  const transitionMs = transition?.type === "crossfade" ? transition.durationMs : 0;
  const outputDurationMs = Math.round(canonicalDuration - transitionMs);
  if (outputDurationMs <= 0) throw new Error("native composition render duration must be positive");

  let audioClip: CompositionJobPayload["audioClip"];
  if (audioEntries.length) {
    const clip = audioEntries[0]!;
    const track = project.composition.tracks.find(({ id }) => id === clip.trackId);
    const input = addInput(clip.assetId, "audio");
    if (!track || track.kind !== "audio" || clip.timelineStartMs !== 0 || clip.audioGainDb < -60 || clip.audioGainDb > 24
      || (clip.sourceOutMs - clip.sourceInMs) / clip.speed < outputDurationMs) throw new Error("native audio clip must be a bounded full-length clip on an audio track");
    audioClip = { id: clip.id, assetId: clip.assetId, sourceInMs: clip.sourceInMs, sourceOutMs: clip.sourceOutMs, speed: clip.speed, audioGainDb: clip.audioGainDb, muted: clip.muted || track.muted };
    if (input.source.durationMs && clip.sourceOutMs > input.source.durationMs) throw new Error("audio clip source range exceeds its immutable asset");
  }

  const activeLayers = project.composition.layers.filter((layer) => !project.composition.tracks.find(({ id }) => id === layer.trackId)?.muted);
  if (activeLayers.length > 2 || activeLayers.filter(({ kind }) => kind === "text").length > 1 || activeLayers.filter(({ kind }) => kind === "image").length > 1
    || activeLayers.some(({ kind }) => kind === "graphic")) throw new Error("native composition supports one timed text layer and one timed image layer");
  const layers = activeLayers.map((layer) => {
    if (layer.keyframes.length || layer.timelineStartMs + layer.durationMs > outputDurationMs) throw new Error("native composition layers must be static and fit the rendered duration");
    if (layer.kind === "text" && "text" in layer.properties) {
      if (layer.properties.fontFamily && layer.properties.fontFamily !== "Replex Sans") throw new Error("native composition supports only the Replex Sans font preset");
      const text = layer.properties.text;
      if (Buffer.byteLength(text, "utf8") > 2048) throw new Error("composition text exceeds the local render limit");
      const requestedFontSize = layer.properties.fontSize ?? 36;
      // ponytail: approximate title width with average glyph size; font-metric layout if reviewer samples show clipping.
      const fontSize = Math.min(requestedFontSize, Math.floor(width * 0.9 / (Math.max(1, [...text].length) * 0.58)));
      if (fontSize < 8) throw new Error("composition text is too long to fit the native title layout");
      return compositionLayerSchema.parse({
        id: layer.id, kind: "text", timelineStartMs: layer.timelineStartMs, durationMs: layer.durationMs,
        text, fontSize, color: layer.properties.color ?? "#ffffff",
      });
    }
    if (layer.kind !== "image" || !("assetId" in layer.properties)) throw new Error("native composition does not support this layer kind");
    const assetId = layer.properties.assetId;
    addInput(assetId, "image");
    return compositionLayerSchema.parse({ id: layer.id, kind: "image", timelineStartMs: layer.timelineStartMs, durationMs: layer.durationMs, assetId });
  });

  const payloadInput = {
    projectId: project.projectId,
    sourceRevisionId: project.currentRevisionId,
    sourceRevisionHash,
    assetInputs: [...inputs.values()],
    composition: { width, height, fps, durationMs, outputDurationMs },
    videoClips,
    ...(audioClip ? { audioClip } : {}),
    layers,
    ...(layers.some(({ kind }) => kind === "text") ? { fontSha256: compositionFontSha256() } : {}),
  };
  const payload = motionArtifactHandles === undefined
    ? compositionJobPayloadSchema.parse({ jobVersion: 2, ...payloadInput })
    : motionCompositionJobPayloadSchema.parse({ jobVersion: 3, ...payloadInput });
  return freezeDeep({ ...payload, jobHash: digest(canonicalJson(payload)) }) as CompositionExecutionJob | CompositionExecutionJobV3;
}

function pathInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation);
}

async function checkedSourcePath(projectRoot: string, handle: ResolvedAssetHandle, expected: AssetHandle): Promise<string> {
  if (handle.assetId !== expected.assetId || handle.sha256 !== expected.sha256 || handle.ref !== expected.ref) {
    throw new Error("resolved asset handle does not match the frozen job");
  }
  const root = await realpath(projectRoot);
  const referencedPath = resolve(root, ...handle.ref.replace(/\\/g, "/").split("/"));
  const resolvedHandle = resolve(handle.path);
  if (!pathInside(root, referencedPath) || referencedPath !== resolvedHandle || !pathInside(root, resolvedHandle)) {
    throw new Error("authorized asset handle escapes the project root");
  }
  const [rootReal, fileReal, fileStat, linkStat] = await Promise.all([realpath(root), realpath(resolvedHandle), stat(resolvedHandle), lstat(resolvedHandle)]);
  if (!pathInside(rootReal, fileReal) || !fileStat.isFile() || linkStat.isSymbolicLink() || linkStat.nlink !== 1) throw new Error("authorized asset handle is not a regular project media file");
  const actualHash = await digestFile(fileReal);
  if (actualHash !== expected.sha256) throw new Error("uploaded source bytes changed since the job was planned");
  return fileReal;
}

async function checkPreflight(
  payload: JobPayload,
  authorization: MediaExecutionAuthorization,
): Promise<{ result: MediaExecutionPreflight; sourcePath: string }> {
  if (!await authorization.isRevisionCurrent(payload.sourceRevisionId, payload.sourceRevisionHash)) {
    throw new Error("media execution job revision is no longer current");
  }
  const resolved = authorization.resolvedHandles.find(({ assetId }) => assetId === payload.assetHandle.assetId);
  if (!resolved) throw new Error("authorized asset handle was not resolved for this job");
  const sourcePath = await checkedSourcePath(authorization.projectRoot, resolved, payload.assetHandle);
  return {
    sourcePath,
    result: {
      status: "passed",
      sourceRevisionId: payload.sourceRevisionId,
      sourceRevisionHash: payload.sourceRevisionHash,
      assetId: payload.assetHandle.assetId,
      assetSha256: payload.assetHandle.sha256,
    },
  };
}

async function checkCompositionPreflight(
  payload: CompositionJobPayload | MotionCompositionJobPayload,
  authorization: MediaExecutionAuthorization,
): Promise<{ result: CompositionExecutionPreflight; sourcePaths: Map<string, string> }> {
  if (!await authorization.isRevisionCurrent(payload.sourceRevisionId, payload.sourceRevisionHash)) throw new Error("media execution job revision is no longer current");
  const sourcePaths = new Map<string, string>();
  for (const input of payload.assetInputs) {
    const resolved = authorization.resolvedHandles.find(({ assetId }) => assetId === input.assetId);
    if (!resolved) throw new Error("authorized asset handle was not resolved for this job");
    sourcePaths.set(input.assetId, await checkedSourcePath(authorization.projectRoot, resolved, input.handle));
  }
  return {
    sourcePaths,
    result: {
      status: "passed",
      sourceRevisionId: payload.sourceRevisionId,
      sourceRevisionHash: payload.sourceRevisionHash,
      assets: payload.assetInputs.map(({ assetId, handle }) => ({ assetId, sha256: handle.sha256 })),
    },
  };
}

/** Checks job/revision authorization and immutable source identity before any backend work. */
export async function verifyMediaExecutionPreflight(
  job: MediaExecutionJob,
  authorization: MediaExecutionAuthorization,
): Promise<MediaExecutionPreflight> {
  return (await checkPreflight(assertJobHash(job), authorization)).result;
}

/** Checks every source handle and the pinned revision before multi-input composition. */
export async function verifyCompositionExecutionPreflight(
  job: CompositionExecutionJob,
  authorization: MediaExecutionAuthorization,
): Promise<CompositionExecutionPreflight> {
  const { jobHash, ...payloadInput } = job;
  const payload = compositionJobPayloadSchema.parse(payloadInput);
  if (digest(canonicalJson(payload)) !== jobHash) throw new Error("media execution job hash does not match its frozen plan");
  return (await checkCompositionPreflight(payload, authorization)).result;
}

interface ProcessResult { stdout: string; stderr: string }

function runProcess(executable: string, args: string[], timeoutMs: number, signal?: AbortSignal, outputLimit = 2 * 1024 * 1024): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.reject(new Error("media execution was cancelled"));
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      rejectPromise(new Error("media backend could not start"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener("abort", cancel);
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill();
      hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const cancel = () => stop(new Error("media execution was cancelled"));
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const next = target === "stdout" ? stdout + chunk.toString("utf8") : stderr + chunk.toString("utf8");
      if (Buffer.byteLength(next) > outputLimit) {
        stop(new Error("media backend output exceeded its limit"));
      } else if (target === "stdout") stdout = next;
      else stderr = next;
    };
    const timer = setTimeout(() => stop(new Error("media execution timed out")), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(failure ?? new Error("media backend could not start"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) rejectPromise(failure);
      else if (code !== 0) rejectPromise(new Error("media backend execution failed"));
      else resolvePromise({ stdout, stderr });
    });
  });
}

function numberText(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function seconds(milliseconds: number): string {
  return numberText(milliseconds / 1000);
}

function evenCropFor(width: number, height: number, crop: JobPayload["clip"]["crop"]): { x: number; y: number; width: number; height: number } | undefined {
  if (!crop) return undefined;
  const sourceWidth = width - width % 2;
  const sourceHeight = height - height % 2;
  const x = Math.floor(width * crop.x / 2) * 2;
  const y = Math.floor(height * crop.y / 2) * 2;
  const cropWidth = Math.min(sourceWidth - x, Math.floor(width * crop.width / 2) * 2);
  const cropHeight = Math.min(sourceHeight - y, Math.floor(height * crop.height / 2) * 2);
  if (x < 0 || y < 0 || cropWidth < 2 || cropHeight < 2) throw new Error("clip crop is too small for native V2 rendering");
  return { x, y, width: cropWidth, height: cropHeight };
}

function evenCrop(job: JobPayload): { x: number; y: number; width: number; height: number } | undefined {
  return evenCropFor(job.source.width, job.source.height, job.clip.crop);
}

function atempoFilters(speed: number): string {
  const values: number[] = [];
  let remaining = speed;
  while (remaining < 0.5) { values.push(0.5); remaining /= 0.5; }
  while (remaining > 2) { values.push(2); remaining /= 2; }
  values.push(remaining);
  return values.map((value) => `atempo=${numberText(value)}`).join(",");
}

function buildFfmpegArgs(job: JobPayload, sourcePath: string, stagedPath: string): string[] {
  const { width, height, fps, durationMs } = job.composition;
  const duration = seconds(durationMs);
  const clip = job.clip;
  const crop = evenCrop(job);
  const cropFilter = crop ? `,crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}` : "";
  const scale = numberText(clip.transform.scale);
  const rotation = numberText(clip.transform.rotation * Math.PI / 180);
  const opacity = numberText(clip.opacity);
  // V2 crops in normalized source space before contain-fit; anchors align the transformed clip in canvas slack.
  // x/y are signed canvas-pixel offsets applied after alignment; scale is a multiplier and rotation uses degrees.
  const videoFilter = `[0:v]trim=start=${seconds(clip.sourceInMs)}:end=${seconds(clip.sourceOutMs)},setpts=(PTS-STARTPTS)/${numberText(clip.speed)}${cropFilter},fps=${numberText(fps)},scale=${width}:${height}:force_original_aspect_ratio=decrease:reset_sar=1,format=rgba,scale=w='max(2,trunc(iw*${scale}/2)*2)':h='max(2,trunc(ih*${scale}/2)*2)',rotate=${rotation}:ow=rotw(${rotation}):oh=roth(${rotation}):c=none,colorchannelmixer=aa=${opacity}[clip]`;
  const audioInput = job.source.hasAudio ? "[0:a]" : "[2:a]";
  const audioStart = job.source.hasAudio ? seconds(clip.sourceInMs) : "0";
  const audioEnd = job.source.hasAudio ? seconds(clip.sourceOutMs) : duration;
  const audioSpeed = job.source.hasAudio ? `${atempoFilters(clip.speed)},` : "";
  const gain = clip.muted ? "volume=0" : `volume=${numberText(clip.audioGainDb)}dB`;
  const audioFilter = `${audioInput}atrim=start=${audioStart}:end=${audioEnd},asetpts=PTS-STARTPTS,${audioSpeed}${gain},apad,atrim=duration=${duration}[audio]`;
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-f", "lavfi", "-t", duration, "-i", `color=c=black:s=${width}x${height}:r=${numberText(fps)}`,
  ];
  if (!job.source.hasAudio) args.push("-f", "lavfi", "-t", duration, "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  const graph = `${videoFilter};[1:v]format=rgba[background];[background][clip]overlay=x='(W-w)*${numberText(clip.transform.anchorX)}+${numberText(clip.transform.x)}':y='(H-h)*${numberText(clip.transform.anchorY)}+${numberText(clip.transform.y)}':shortest=1:eof_action=pass:format=auto[video];${audioFilter}`;
  args.push(
    "-filter_complex", graph,
    "-map", "[video]", "-map", "[audio]", "-t", duration,
    "-r", numberText(fps), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-threads", "1", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    "-metadata", "creation_time=1970-01-01T00:00:00Z", "-movflags", "+faststart", "-fs", String(MAX_RENDER_ARTIFACT_BYTES), stagedPath,
  );
  return args;
}

function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/;/g, "\\;");
}

async function buildCompositionFfmpegArgs(
  job: CompositionJobPayload | MotionCompositionJobPayload,
  sourcePaths: ReadonlyMap<string, string>,
  stageDir: string,
  stagedPath: string,
  motionPaths: ReadonlyMap<string, string> = new Map(),
): Promise<string[]> {
  const { width, height, fps, outputDurationMs } = job.composition;
  const duration = seconds(outputDurationMs);
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  const inputIndexes = new Map<string, number>();
  job.assetInputs.forEach((input, index) => {
    const path = sourcePaths.get(input.assetId);
    if (!path) throw new Error("composition source path was not authorized");
    inputIndexes.set(input.assetId, index);
    if (input.kind === "image") args.push("-loop", "1", "-framerate", numberText(fps));
    args.push("-i", path);
  });
  const motionInputIndexes = new Map<string, number>();
  let nextInputIndex = job.assetInputs.length;
  for (const clip of job.videoClips) {
    const hasMotion = "motionArtifact" in clip && clip.motionArtifact !== undefined;
    if (!hasMotion) continue;
    const path = motionPaths.get(clip.id);
    if (!path) throw new Error("composition motion artifact was not authorized");
    args.push("-i", path);
    motionInputIndexes.set(clip.id, nextInputIndex);
    nextInputIndex += 1;
  }
  const backgroundIndex = nextInputIndex;
  args.push("-f", "lavfi", "-t", duration, "-i", `color=c=black:s=${width}x${height}:r=${numberText(fps)}`);
  const hasAudio = job.videoClips.some((clip) => !clip.muted && job.assetInputs.find(({ assetId }) => assetId === clip.assetId)?.source.hasAudio)
    || Boolean(job.audioClip && !job.audioClip.muted);
  const silenceIndex = backgroundIndex + 1;
  if (!hasAudio) args.push("-f", "lavfi", "-t", duration, "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");

  const filters: string[] = [];
  if (job.videoClips.length === 1) filters.push(`[${backgroundIndex}:v]format=rgba[bg0]`);
  else filters.push(`[${backgroundIndex}:v]split=2[bg0][bg1]`);
  for (const [index, clip] of job.videoClips.entries()) {
    const inputIndex = inputIndexes.get(clip.assetId);
    const input = job.assetInputs.find(({ assetId }) => assetId === clip.assetId);
    if (inputIndex === undefined || !input?.source.width || !input.source.height) throw new Error("composition video input is incomplete");
    const crop = evenCropFor(input.source.width, input.source.height, clip.crop);
    const cropFilter = crop ? `,crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}` : "";
    const scale = numberText(clip.transform.scale);
    const rotation = numberText(clip.transform.rotation * Math.PI / 180);
    const motionInputIndex = motionInputIndexes.get(clip.id);
    const visualInput = motionInputIndex ?? inputIndex;
    const timelineFilter = motionInputIndex === undefined
      ? `trim=start=${seconds(clip.sourceInMs)}:end=${seconds(clip.sourceOutMs)},setpts=(PTS-STARTPTS)/${numberText(clip.speed)}`
      : "setpts=PTS-STARTPTS";
    filters.push(`[${visualInput}:v]${timelineFilter}${cropFilter},fps=${numberText(fps)},scale=${width}:${height}:force_original_aspect_ratio=decrease:reset_sar=1,format=rgba,scale=w='max(2,trunc(iw*${scale}/2)*2)':h='max(2,trunc(ih*${scale}/2)*2)',rotate=${rotation}:ow=rotw(${rotation}):oh=roth(${rotation}):c=none,colorchannelmixer=aa=${numberText(clip.opacity)}[clip${index}]`);
    filters.push(`[bg${index}][clip${index}]overlay=x='(W-w)*${numberText(clip.transform.anchorX)}+${numberText(clip.transform.x)}':y='(H-h)*${numberText(clip.transform.anchorY)}+${numberText(clip.transform.y)}':shortest=1:eof_action=pass:format=auto,format=yuv420p,setsar=1[video${index}]`);
  }

  let videoLabel = "video0";
  if (job.videoClips.length === 2) {
    const transition = job.videoClips[0]!.transitionOut;
    if (transition?.type === "crossfade") {
      const firstDuration = (job.videoClips[0]!.sourceOutMs - job.videoClips[0]!.sourceInMs) / job.videoClips[0]!.speed;
      filters.push(`[video0][video1]xfade=transition=fade:duration=${seconds(transition.durationMs)}:offset=${seconds(firstDuration - transition.durationMs)}[videoJoined]`);
    } else {
      filters.push("[video0][video1]concat=n=2:v=1:a=0[videoJoined]");
    }
    videoLabel = "videoJoined";
  }

  for (const layer of job.layers) {
    const start = seconds(layer.timelineStartMs);
    const end = seconds(layer.timelineStartMs + layer.durationMs);
    if (layer.kind === "image") {
      const inputIndex = inputIndexes.get(layer.assetId);
      if (inputIndex === undefined) throw new Error("composition image input was not authorized");
      const nextLabel = `videoImage${job.layers.indexOf(layer)}`;
      const imageWidth = Math.max(2, Math.floor(width / 3 / 2) * 2);
      const imageHeight = Math.max(2, Math.floor(height / 3 / 2) * 2);
      filters.push(`[${inputIndex}:v]scale=${imageWidth}:${imageHeight}:force_original_aspect_ratio=decrease:reset_sar=1,format=rgba[imageOverlay]`);
      filters.push(`[${videoLabel}][imageOverlay]overlay=x=W-w-16:y=16:enable='between(t,${start},${end})':shortest=1:eof_action=pass:format=auto,format=yuv420p[${nextLabel}]`);
      videoLabel = nextLabel;
    } else {
      const textPath = join(stageDir, `overlay-${job.layers.indexOf(layer)}.txt`);
      await writeFile(textPath, layer.text, { flag: "wx", mode: 0o600 });
      const font = resolveRenderFont();
      if (!job.fontSha256 || compositionFontSha256() !== job.fontSha256) throw new Error("configured composition font changed since the job was planned");
      const nextLabel = `videoText${job.layers.indexOf(layer)}`;
      filters.push(`[${videoLabel}]drawtext=fontfile='${escapeFilterPath(font.file)}':textfile='${escapeFilterPath(textPath)}':expansion=none:fontcolor=0x${layer.color.slice(1)}:fontsize=${layer.fontSize}:x=(w-text_w)/2:y=h-text_h-16:enable='between(t,${start},${end})'[${nextLabel}]`);
      videoLabel = nextLabel;
    }
  }

  const audioLabels: string[] = [];
  const crossfade = job.videoClips[0]?.transitionOut?.type === "crossfade" ? job.videoClips[0].transitionOut.durationMs : 0;
  for (const [index, clip] of job.videoClips.entries()) {
    const input = job.assetInputs.find(({ assetId }) => assetId === clip.assetId);
    if (!input?.source.hasAudio || clip.muted) continue;
    const inputIndex = inputIndexes.get(clip.assetId)!;
    const clipDuration = (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
    const gain = `volume=${numberText(clip.audioGainDb)}dB`;
    const fade = crossfade ? index === 0 ? `,afade=t=out:st=${seconds(clipDuration - crossfade)}:d=${seconds(crossfade)}` : `,afade=t=in:st=0:d=${seconds(crossfade)}` : "";
    const delayMs = index === 0 ? 0 : Math.max(0, Math.round((job.videoClips[0]!.sourceOutMs - job.videoClips[0]!.sourceInMs) / job.videoClips[0]!.speed - crossfade));
    const delay = delayMs ? `,adelay=${delayMs}|${delayMs}` : "";
    const label = `audio${audioLabels.length}`;
    filters.push(`[${inputIndex}:a]atrim=start=${seconds(clip.sourceInMs)}:end=${seconds(clip.sourceOutMs)},asetpts=PTS-STARTPTS,${atempoFilters(clip.speed)},${gain},apad,atrim=duration=${seconds(clipDuration)}${fade}${delay}[${label}]`);
    audioLabels.push(label);
  }
  if (job.audioClip && !job.audioClip.muted) {
    const inputIndex = inputIndexes.get(job.audioClip.assetId);
    if (inputIndex === undefined) throw new Error("composition audio input was not authorized");
    const label = `audio${audioLabels.length}`;
    filters.push(`[${inputIndex}:a]atrim=start=${seconds(job.audioClip.sourceInMs)}:end=${seconds(job.audioClip.sourceOutMs)},asetpts=PTS-STARTPTS,${atempoFilters(job.audioClip.speed)},volume=${numberText(job.audioClip.audioGainDb)}dB,apad,atrim=duration=${duration}[${label}]`);
    audioLabels.push(label);
  }
  if (audioLabels.length === 0) filters.push(`[${silenceIndex}:a]atrim=duration=${duration}[audio]`);
  else if (audioLabels.length === 1) filters.push(`[${audioLabels[0]}]apad,atrim=duration=${duration}[audio]`);
  else filters.push(`${audioLabels.map((label) => `[${label}]`).join("")}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,apad,atrim=duration=${duration}[audio]`);

  args.push(
    "-filter_complex_threads", "1", "-filter_complex", filters.join(";"),
    "-map", `[${videoLabel}]`, "-map", "[audio]", "-t", duration,
    "-r", numberText(fps), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-threads", "1", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    "-metadata", "creation_time=1970-01-01T00:00:00Z", "-movflags", "+faststart", "-fs", String(MAX_RENDER_ARTIFACT_BYTES), stagedPath,
  );
  return args;
}

interface OutputProbe {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string;
}

function parseRate(rate: unknown): number {
  if (typeof rate !== "string") return 0;
  const [numerator, denominator] = rate.split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : Number(rate) || 0;
}

async function verifyRenderedOutput(
  path: string,
  job: FrozenJobPayload,
  ffprobePath: string,
  ffmpegPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ probe: OutputProbe; sha256: string }> {
  const expectedDurationMs = job.jobVersion === 1 ? job.composition.durationMs : job.composition.outputDurationMs;
  const initialFile = await stat(path);
  if (!initialFile.isFile() || initialFile.size > MAX_RENDER_ARTIFACT_BYTES) throw new Error("render artifact exceeds the local size limit");
  const probeRun = await runProcess(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", path,
  ], timeoutMs, signal);
  let data: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }> };
  try { data = JSON.parse(probeRun.stdout) as typeof data; } catch { throw new Error("render output probe returned malformed data"); }
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(data.format?.duration);
  const fps = parseRate(video?.avg_frame_rate);
  if (!video?.width || !video.height || !audio?.codec_name || video.codec_name !== "h264" || audio.codec_name !== "aac"
    || video.width !== job.composition.width || video.height !== job.composition.height
    || Math.abs(fps - job.composition.fps) > 0.01
    || !Number.isFinite(durationSeconds)
    || Math.abs(durationSeconds * 1000 - expectedDurationMs) > 1500 / job.composition.fps) {
    throw new Error("render output does not meet its frozen media requirements");
  }
  await runProcess(ffmpegPath, ["-nostdin", "-v", "error", "-xerror", "-i", path, "-f", "null", "-"], timeoutMs, signal);
  const artifactFile = await boundedDigestFile(path);
  if (artifactFile.size !== initialFile.size) throw new Error("render artifact changed while it was being verified");
  return {
    probe: {
      durationMs: Math.round(durationSeconds * 1000),
      width: video.width,
      height: video.height,
      fps,
      videoCodec: video.codec_name,
      audioCodec: audio.codec_name,
    },
    sha256: artifactFile.sha256,
  };
}

async function realContainedDirectory(root: string, relativePath: string): Promise<string> {
  let directory = root;
  for (const part of relativePath.split(/[\\/]+/).filter(Boolean)) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    const actual = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !pathInside(root, actual)) {
      throw new Error("media render staging or output directory escapes the project root");
    }
    directory = actual;
  }
  return directory;
}

interface PublishedFile { path: string; device: number; inode: number }

async function publishExclusive(stagedPath: string, outputPath: string, expectedHash: string): Promise<PublishedFile | undefined> {
  const verifyExisting = async (): Promise<undefined> => {
    const existing = await lstat(outputPath);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error("render artifact target already contains different or unsafe data");
    }
    const hashed = await boundedDigestFile(outputPath);
    if (hashed.sha256 !== expectedHash) {
      throw new Error("render artifact target already contains different or unsafe data");
    }
    return undefined;
  };
  try {
    await lstat(outputPath);
    return await verifyExisting();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await link(stagedPath, outputPath);
    const created = await lstat(outputPath);
    return { path: outputPath, device: created.dev, inode: created.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await verifyExisting();
  }
}

async function removePublished(file: PublishedFile | undefined): Promise<void> {
  if (!file) return;
  try {
    const current = await lstat(file.path);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === file.device && current.ino === file.inode) await unlink(file.path);
  } catch { /* It was already removed; do not replace the original failure. */ }
}

function jobAssetHandles(payload: FrozenJobPayload): AssetHandle[] {
  return payload.jobVersion === 1 ? [payload.assetHandle] : payload.assetInputs.map(({ handle }) => handle);
}

async function resolveMotionArtifactPaths(
  payload: FrozenJobPayload,
  handles: readonly MotionArtifactHandle[],
  projectRoot: string,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  if (payload.jobVersion !== 3) {
    if (handles.length) throw new Error("motion artifact handles are only valid for composition job v3");
    return paths;
  }
  const descriptors = payload.videoClips.flatMap((clip) => clip.motionArtifact ? [clip.motionArtifact] : []);
  if (handles.length !== descriptors.length) throw new Error("composition job v3 requires every authorized motion artifact handle");
  for (const input of handles) {
    const handle = assertIssuedMotionArtifactHandle(input);
    const descriptor = descriptors.find(({ targetClipId }) => targetClipId === handle.targetClipId);
    if (!descriptor || canonicalJson(descriptor) !== canonicalJson(handle) || paths.has(handle.targetClipId)) {
      throw new Error("motion artifact handle does not match the frozen composition job");
    }
    paths.set(handle.targetClipId, await resolveMotionArtifactHandle(input, projectRoot));
  }
  return paths;
}

async function assertJobSourcesCurrent(
  root: string,
  authorization: MediaExecutionAuthorization,
  payload: FrozenJobPayload,
  sourcePaths: ReadonlyMap<string, string>,
  motionHandles: readonly MotionArtifactHandle[],
  motionPaths: ReadonlyMap<string, string>,
  boundary: "before" | "after",
): Promise<void> {
  for (const expected of jobAssetHandles(payload)) {
    const resolved = authorization.resolvedHandles.find(({ assetId }) => assetId === expected.assetId);
    if (!resolved) throw new Error("authorized asset handle was not resolved for this job");
    const actual = await checkedSourcePath(root, resolved, expected);
    if (actual !== sourcePaths.get(expected.assetId)) throw new Error(`media execution revision or source changed ${boundary} output promotion`);
  }
  if (!await authorization.isRevisionCurrent(payload.sourceRevisionId, payload.sourceRevisionHash)) {
    throw new Error(`media execution revision or source changed ${boundary} output promotion`);
  }
  for (const handle of motionHandles) {
    const actual = await resolveMotionArtifactHandle(handle, root);
    if (actual !== motionPaths.get(handle.targetClipId)) throw new Error(`motion artifact changed ${boundary} output promotion`);
  }
}

/** Executes a frozen job and returns a derived artifact without mutating ProjectV2. */
export async function executeMediaExecutionJob(
  job: MediaExecutionJob | CompositionExecutionJob,
  authorization: MediaExecutionAuthorization,
  options: MediaExecutionOptions = {},
): Promise<{ preflight: MediaExecutionPreflight | CompositionExecutionPreflight; artifact: RenderArtifactV2 }> {
  return executeFrozenMediaJob(job, authorization, options, []);
}

/** Executes only frozen composition job v3 using the executor-issued handles named by that job. */
export async function executeCompositionExecutionJobV3(
  job: CompositionExecutionJobV3,
  motionArtifactHandles: readonly MotionArtifactHandle[],
  authorization: MediaExecutionAuthorization,
  options: MediaExecutionOptions = {},
): Promise<{ preflight: CompositionExecutionPreflight; artifact: RenderArtifactV2 }> {
  if (job.jobVersion !== 3) throw new Error("composition execution job v3 is required");
  const result = await executeFrozenMediaJob(job, authorization, options, motionArtifactHandles);
  if ("assetId" in result.preflight) throw new Error("composition execution preflight returned the wrong job kind");
  return { preflight: result.preflight as CompositionExecutionPreflight, artifact: result.artifact };
}

async function executeFrozenMediaJob(
  job: FrozenRenderJob,
  authorization: MediaExecutionAuthorization,
  options: MediaExecutionOptions,
  motionArtifactHandles: readonly MotionArtifactHandle[],
): Promise<{ preflight: MediaExecutionPreflight | CompositionExecutionPreflight; artifact: RenderArtifactV2 }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("media execution timeout is outside the supported range");
  const payload = assertFrozenJobHash(job);
  let preflight: MediaExecutionPreflight | CompositionExecutionPreflight;
  let sourcePaths: Map<string, string>;
  if (payload.jobVersion === 1) {
    const checked = await checkPreflight(payload, authorization);
    preflight = checked.result;
    sourcePaths = new Map([[payload.assetHandle.assetId, checked.sourcePath]]);
  } else {
    const checked = await checkCompositionPreflight(payload, authorization);
    preflight = checked.result;
    sourcePaths = checked.sourcePaths;
  }
  const root = await realpath(authorization.projectRoot);
  const motionPaths = await resolveMotionArtifactPaths(payload, motionArtifactHandles, root);
  const stageRoot = await realContainedDirectory(root, ".replex-staging");
  const stageDir = await mkdtemp(join(stageRoot, `${job.jobHash.slice(0, 16)}-`));
  await chmod(stageDir, 0o700);
  const stagedPath = join(stageDir, "render.mp4");
  const stagedEvidencePath = join(stageDir, "verification.json");
  const ffmpegPath = options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";
  try {
    const args = payload.jobVersion === 1
      ? buildFfmpegArgs(payload, sourcePaths.get(payload.assetHandle.assetId)!, stagedPath)
      : await buildCompositionFfmpegArgs(payload, sourcePaths, stageDir, stagedPath, motionPaths);
    await runProcess(ffmpegPath, args, timeoutMs, options.signal, 8 * 1024 * 1024);
    const verified = await verifyRenderedOutput(stagedPath, payload, ffprobePath, ffmpegPath, timeoutMs, options.signal);
    const version = await runProcess(ffmpegPath, ["-version"], timeoutMs, options.signal, 32 * 1024);
    const ffmpegVersion = version.stdout.split(/\r?\n/, 1)[0]?.trim();
    if (!ffmpegVersion) throw new Error("media backend did not report its version");

    const outputRoot = await realContainedDirectory(root, "renders");
    const outputName = `${job.jobHash}.mp4`;
    const outputPath = join(outputRoot, outputName);
    if (!pathInside(outputRoot, outputPath)) throw new Error("render output path escapes the project root");
    const verificationId = `verification-${job.jobHash.slice(0, 32)}`;
    const evidenceRef = `evidence/renders/${job.jobHash}.json`;
    const evidenceRoot = await realContainedDirectory(root, "evidence/renders");
    const evidencePath = join(evidenceRoot, `${job.jobHash}.json`);
    const receipt = {
      version: 1,
      verificationId,
      status: "passed",
      revisionId: payload.sourceRevisionId,
      sourceRevisionHash: payload.sourceRevisionHash,
      renderJobHash: job.jobHash,
      artifactRef: `renders/${outputName}`,
      artifactSha256: verified.sha256,
      probe: verified.probe,
      backend: { id: "native-ffmpeg", version: String(payload.jobVersion), ffmpegVersion },
      checks: { probe: true, decode: true, hash: true },
    };
    const receiptBytes = `${canonicalJson(receipt)}\n`;
    await writeFile(stagedEvidencePath, receiptBytes, { flag: "wx" });
    const evidenceSha256 = digest(receiptBytes);

    // Pin revision and source again at the final publication boundary.
    await assertJobSourcesCurrent(root, authorization, payload, sourcePaths, motionArtifactHandles, motionPaths, "before");

    let promotedOutput: PublishedFile | undefined;
    let promotedEvidence: PublishedFile | undefined;
    let outputSha = verified.sha256;
    try {
      promotedOutput = await publishExclusive(stagedPath, outputPath, verified.sha256);
      promotedEvidence = await publishExclusive(stagedEvidencePath, evidencePath, evidenceSha256);
      await assertJobSourcesCurrent(root, authorization, payload, sourcePaths, motionArtifactHandles, motionPaths, "after");
      outputSha = (await boundedDigestFile(outputPath)).sha256;
      if (outputSha !== verified.sha256 || await digestFile(evidencePath) !== evidenceSha256) {
        throw new Error("promoted render artifact or verification evidence changed before return");
      }
    } catch (error) {
      await removePublished(promotedEvidence);
      await removePublished(promotedOutput);
      throw error;
    }

    const verification = {
      id: verificationId,
      status: "passed" as const,
      revisionId: payload.sourceRevisionId,
      evidenceRefs: [evidenceRef],
      evidenceSha256,
      sourceRevisionHash: payload.sourceRevisionHash,
      renderJobHash: job.jobHash,
      artifactSha256: outputSha,
      checks: { probe: true as const, decode: true as const, hash: true as const },
    };
    const ref = `renders/${outputName}`;
    const artifact: RenderArtifactV2 = {
      outputId: `render-${job.jobHash.slice(0, 32)}`,
      ref,
      sha256: outputSha,
      probe: verified.probe,
      sourceRevisionId: payload.sourceRevisionId,
      sourceRevisionHash: payload.sourceRevisionHash,
      renderJobHash: job.jobHash,
      backendId: "native-ffmpeg",
      backendVersion: String(payload.jobVersion),
      ffmpegVersion,
      verificationRefId: verificationId,
      verification,
    };
    return { preflight, artifact };
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
