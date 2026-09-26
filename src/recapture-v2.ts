import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { artifactSceneKey, type CaptureResult } from "./capture.js";
import { canonicalJson } from "./canonical-json.js";
import {
  authorizeLocalImport,
  closeAuthorizedLocalImport,
  LocalImportError,
  type LocalImportOptions,
} from "./import-v2.js";
import type { OperationBatchInput, OperationLogRecord } from "./operations-v2.js";
import { IdSchema, Sha256Schema } from "./schema.js";
import { MediaAssetSchema, type MediaAsset, type ProjectV2 } from "./schema-v2.js";
import { LocalProjectStore, LocalProjectStoreError } from "./service/project-store.js";

const datetime = z.string().datetime({ offset: true });
const CapturedRunSchema = z.object({
  id: IdSchema,
  status: z.enum(["passed", "failed"]),
  startedAt: datetime,
  endedAt: datetime,
}).passthrough();

const PreservationCheckSchema = z.object({
  name: z.enum([
    "assets-preserved",
    "clips-preserved",
    "composition-preserved",
    "browser-history-preserved",
    "one-revision-operation",
    "verification-staled",
  ]),
  beforeSha256: Sha256Schema,
  afterSha256: Sha256Schema,
  passed: z.literal(true),
}).strict();

export const RecapturePreservationReportSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: IdSchema,
  baseRevisionId: IdSchema,
  resultRevisionId: IdSchema,
  runId: IdSchema,
  sceneKey: IdSchema,
  changedActionIds: z.object({ source: z.literal("host_asserted"), ids: z.array(IdSchema).min(1) }).strict(),
  previousAsset: z.object({ id: IdSchema, sha256: Sha256Schema }).strict(),
  replacementAsset: z.object({ id: IdSchema, sha256: Sha256Schema }).strict(),
  operation: z.object({ id: IdSchema, type: z.literal("replace_browser_capture"), actor: z.literal("recapture") }).strict(),
  expectedChanges: z.object({
    addedAssetId: IdSchema,
    retargetedClipIds: z.array(IdSchema),
    verificationStatus: z.literal("stale"),
  }).strict(),
  checks: z.array(PreservationCheckSchema).length(6),
}).strict();

export type RecapturePreservationReport = z.infer<typeof RecapturePreservationReportSchema>;

export type RecaptureV2ErrorCode =
  | "INVALID_REQUEST"
  | "CAPTURE_FAILED"
  | "SCENE_INVALID"
  | "FLOW_MISMATCH"
  | "SOURCE_NOT_AUTHORIZED"
  | "SOURCE_CHANGED"
  | "STALE_REVISION"
  | "INVALID_OPERATION"
  | "PRESERVATION_FAILED"
  | "EVIDENCE_FAILED";

export class RecaptureV2Error extends Error {
  constructor(readonly code: RecaptureV2ErrorCode, message: string) {
    super(message);
    this.name = "RecaptureV2Error";
  }
}

export interface RecaptureBrowserSceneRequest {
  projectId: string;
  baseRevisionId: string;
  previousAssetId: string;
  capture: CaptureResult;
  sceneKey: string;
  changedActionIds: string[];
  reason: string;
  intentId: string;
}

export interface RecaptureBrowserSceneResult {
  project: ProjectV2;
  revisionId: string;
  replacementAsset: MediaAsset;
  operationLog: OperationLogRecord[];
  report: RecapturePreservationReport;
  evidenceRef: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function reject(code: RecaptureV2ErrorCode, message: string): never {
  throw new RecaptureV2Error(code, message);
}

async function validateRun(capture: CaptureResult, sceneKey: string): Promise<{ runRoot: string; scene: CaptureResult["captures"][number] }> {
  if (!capture || capture.run?.status !== "passed" || !Array.isArray(capture.captures)) reject("CAPTURE_FAILED", "browser capture run did not pass");
  const matches = capture.captures.filter((scene) => scene.sceneKey === sceneKey);
  if (matches.length !== 1) reject("SCENE_INVALID", "capture run must contain exactly one selected scene");
  const scene = matches[0]!;
  if (scene.runId !== capture.run.id || !Array.isArray(scene.actionIds) || scene.actionIds.some((id) => !IdSchema.safeParse(id).success)
    || !IdSchema.safeParse(scene.checkpointActionId).success || !Sha256Schema.safeParse(scene.sha256).success
    || !Number.isInteger(scene.width) || scene.width < 1 || !Number.isInteger(scene.height) || scene.height < 1
    || !Number.isInteger(scene.durationMs) || scene.durationMs < 1) reject("SCENE_INVALID", "selected capture scene metadata is invalid");

  let runPath: string;
  let runRoot: string;
  try {
    runPath = resolve(capture.runPath);
    if (basename(runPath) !== "run.json") reject("SCENE_INVALID", "capture run record path is invalid");
    runRoot = dirname(runPath);
    const rootInfo = await lstat(runRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) reject("SCENE_INVALID", "capture run root must be a real directory");
    const canonicalRoot = await realpath(runRoot);
    const runInfo = await lstat(runPath);
    if (runInfo.isSymbolicLink() || !runInfo.isFile() || runInfo.nlink !== 1 || runInfo.size > 16_384) reject("SCENE_INVALID", "capture run record is invalid");
    const canonicalRunPath = await realpath(runPath);
    if (!samePath(canonicalRunPath, join(canonicalRoot, "run.json")) || basename(canonicalRoot) !== capture.run.id) {
      reject("SCENE_INVALID", "capture run identity does not match its local artifacts");
    }
    const record = CapturedRunSchema.safeParse(JSON.parse(await readFile(canonicalRunPath, "utf8")) as unknown);
    if (!record.success || record.data.id !== capture.run.id || record.data.status !== "passed"
      || record.data.startedAt !== capture.run.startedAt || record.data.endedAt !== capture.run.endedAt) {
      reject("CAPTURE_FAILED", "capture run record does not match the result");
    }
    const expectedScenePath = join(canonicalRoot, "captures", `${artifactSceneKey(sceneKey)}.webm`);
    if (!samePath(scene.sourcePath, expectedScenePath)) reject("SOURCE_NOT_AUTHORIZED", "selected scene is outside its expected capture location");
    return { runRoot: canonicalRoot, scene };
  } catch (error) {
    if (error instanceof RecaptureV2Error) throw error;
    return reject("SCENE_INVALID", "capture run artifacts could not be validated");
  }
}

function checkFlow(project: ProjectV2, previousAsset: MediaAsset, scene: CaptureResult["captures"][number], changedActionIds: string[]): void {
  if (previousAsset.provenance.kind !== "browser") reject("FLOW_MISMATCH", "previous asset has no browser provenance");
  const flow = project.browser?.flows[previousAsset.provenance.flowId];
  if (!flow || flow.id !== previousAsset.provenance.flowId) reject("FLOW_MISMATCH", "approved browser flow is unavailable");
  const steps = flow.steps.filter((step) => step.sceneKey === scene.sceneKey);
  const stepIds = steps.map((step) => step.id);
  if (steps.length === 0 || steps.some((step) => !step.approved)
    || JSON.stringify(stepIds) !== JSON.stringify(scene.actionIds)
    || scene.checkpointActionId !== stepIds.at(-1)
    || previousAsset.provenance.sceneKey !== scene.sceneKey
    || previousAsset.provenance.actionIds.join("\0") !== stepIds.join("\0")
    || previousAsset.provenance.checkpointActionId !== stepIds.at(-1)) {
    reject("FLOW_MISMATCH", "selected capture does not match the approved browser scene");
  }
  if (changedActionIds.length === 0 || new Set(changedActionIds).size !== changedActionIds.length
    || changedActionIds.some((actionId) => !stepIds.includes(actionId))) {
    reject("INVALID_REQUEST", "changed action IDs must be unique host assertions within the selected scene");
  }
}

function makeCheck(name: z.infer<typeof PreservationCheckSchema>["name"], before: unknown, after: unknown): z.infer<typeof PreservationCheckSchema> {
  const beforeSha256 = digest(before);
  const afterSha256 = digest(after);
  if (beforeSha256 !== afterSha256) reject("PRESERVATION_FAILED", `preservation check failed: ${name}`);
  return { name, beforeSha256, afterSha256, passed: true };
}

function buildReport(
  before: ProjectV2,
  after: ProjectV2,
  request: RecaptureBrowserSceneRequest,
  scene: CaptureResult["captures"][number],
  replacementAsset: MediaAsset,
  operationLog: OperationLogRecord[],
): RecapturePreservationReport {
  const previousAsset = before.assets[request.previousAssetId]!;
  const afterWithoutNewAsset = Object.fromEntries(Object.entries(after.assets).filter(([id]) => id !== replacementAsset.id));
  const retargetedClipIds = before.composition.clips.filter((clip) => clip.assetId === request.previousAssetId).map((clip) => clip.id);
  const beforeClips = before.composition.clips.map((clip) => clip.assetId === request.previousAssetId
    ? { ...clip, assetId: replacementAsset.id }
    : clip);
  const beforeComposition = { ...before.composition };
  const afterComposition = { ...after.composition };
  delete (beforeComposition as Partial<ProjectV2["composition"]>).clips;
  delete (afterComposition as Partial<ProjectV2["composition"]>).clips;
  const beforeBrowser = before.browser!;
  const afterBrowser = after.browser!;
  const beforeHistory = { flows: beforeBrowser.flows, recaptureLineage: beforeBrowser.recaptureLineage };
  const afterHistory = { flows: afterBrowser.flows, recaptureLineage: afterBrowser.recaptureLineage.slice(0, -1) };
  const appendedLineage = afterBrowser.recaptureLineage.at(-1);
  const revision = after.revisions.at(-1);
  const expectedVerification = { revisionId: after.currentRevisionId, status: "stale", refs: before.verification.refs };
  const lineageCorrect = beforeBrowser.recaptureLineage.length + 1 === afterBrowser.recaptureLineage.length
    && appendedLineage?.previousAssetId === request.previousAssetId
    && appendedLineage.replacementAssetId === replacementAsset.id
    && appendedLineage.changedActionIds.join("\0") === request.changedActionIds.join("\0")
    && appendedLineage.revisionId === after.currentRevisionId;
  const operation = operationLog[0];
  const revisionCorrect = after.revisions.length === before.revisions.length + 1
    && revision?.id === after.currentRevisionId
    && revision.parentId === request.baseRevisionId
    && revision.actor === "recapture"
    && revision.operationIds.length === 1
    && operationLog.length === 1
    && operation?.actor === "recapture"
    && operation.baseRevisionId === request.baseRevisionId
    && operation.resultRevisionId === after.currentRevisionId
    && operation.intentId === request.intentId
    && operation.input.type === "replace_browser_capture"
    && operation.input.previousAssetId === request.previousAssetId
    && operation.input.replacementAsset.id === replacementAsset.id
    && operation.input.changedActionIds.join("\0") === request.changedActionIds.join("\0");
  const expectedAsset = after.assets[replacementAsset.id];
  const assetAddedCorrectly = Object.keys(after.assets).length === Object.keys(before.assets).length + 1
    && expectedAsset?.sha256 === replacementAsset.sha256
    && expectedAsset.path === replacementAsset.path;
  if (!assetAddedCorrectly) reject("PRESERVATION_FAILED", "replacement asset was not the only new project asset");
  const expectedRevisionDelta = {
    parentRevisionId: request.baseRevisionId,
    revisionCount: 1,
    operationCount: 1,
    actor: "recapture",
    operationType: "replace_browser_capture",
    operationIds: operation ? [operation.id] : [],
  };
  const actualRevisionDelta = {
    parentRevisionId: revision?.parentId,
    revisionCount: after.revisions.length - before.revisions.length,
    operationCount: operationLog.length,
    actor: revision?.actor,
    operationType: operation?.input.type,
    operationIds: revision?.operationIds ?? [],
  };
  const checks = [
    makeCheck("assets-preserved", before.assets, afterWithoutNewAsset),
    makeCheck("clips-preserved", beforeClips, after.composition.clips),
    makeCheck("composition-preserved", { composition: beforeComposition, outputs: before.outputs }, { composition: afterComposition, outputs: after.outputs }),
    makeCheck("browser-history-preserved", beforeHistory, afterHistory),
    makeCheck("one-revision-operation", expectedRevisionDelta, actualRevisionDelta),
    makeCheck("verification-staled", expectedVerification, after.verification),
  ];
  if (!lineageCorrect || !revisionCorrect || !retargetedClipIds.length) reject("PRESERVATION_FAILED", "recapture revision or lineage does not match the requested change");

  const result = RecapturePreservationReportSchema.safeParse({
    schemaVersion: 1,
    projectId: before.projectId,
    baseRevisionId: request.baseRevisionId,
    resultRevisionId: after.currentRevisionId,
    runId: scene.runId,
    sceneKey: scene.sceneKey,
    changedActionIds: { source: "host_asserted", ids: [...request.changedActionIds] },
    previousAsset: { id: previousAsset.id, sha256: previousAsset.sha256 },
    replacementAsset: { id: replacementAsset.id, sha256: replacementAsset.sha256 },
    operation: { id: operation!.id, type: "replace_browser_capture", actor: "recapture" },
    expectedChanges: { addedAssetId: replacementAsset.id, retargetedClipIds, verificationStatus: "stale" },
    checks,
  });
  if (!result.success) reject("PRESERVATION_FAILED", "preservation report failed its schema");
  return result.data;
}

function mapImportError(error: LocalImportError): RecaptureV2Error {
  if (error.code === "SOURCE_NOT_AUTHORIZED") return new RecaptureV2Error("SOURCE_NOT_AUTHORIZED", "selected browser capture is not authorized");
  if (error.code === "SOURCE_CHANGED") return new RecaptureV2Error("SOURCE_CHANGED", "selected browser capture changed during validation");
  return new RecaptureV2Error("INVALID_OPERATION", "selected browser capture media failed validation");
}

export async function recaptureBrowserSceneV2(
  store: LocalProjectStore,
  request: RecaptureBrowserSceneRequest,
  options: LocalImportOptions = {},
): Promise<RecaptureBrowserSceneResult> {
  if (!IdSchema.safeParse(request.projectId).success || !IdSchema.safeParse(request.baseRevisionId).success
    || !IdSchema.safeParse(request.previousAssetId).success || !IdSchema.safeParse(request.sceneKey).success
    || !IdSchema.safeParse(request.intentId).success || !z.string().trim().min(1).max(500).safeParse(request.reason).success
    || !Array.isArray(request.changedActionIds) || !request.capture) reject("INVALID_REQUEST", "recapture request is invalid");

  const before = await store.current(request.projectId);
  if (before.currentRevisionId !== request.baseRevisionId) reject("STALE_REVISION", "base revision is not current");
  const previousAsset = before.assets[request.previousAssetId];
  if (!previousAsset || previousAsset.type !== "browser_capture" || previousAsset.provenance.kind !== "browser") {
    reject("FLOW_MISMATCH", "previous asset is not a browser capture");
  }
  const previousProvenance = previousAsset.provenance;
  if (!before.composition.clips.some((clip) => clip.assetId === request.previousAssetId)) {
    reject("INVALID_OPERATION", "previous browser capture is not used by a project clip");
  }
  const { runRoot, scene } = await validateRun(request.capture, request.sceneKey);
  checkFlow(before, previousAsset, scene, request.changedActionIds);

  let source;
  try {
    source = await authorizeLocalImport(scene.sourcePath, [runRoot]);
  } catch {
    reject("SOURCE_NOT_AUTHORIZED", "selected browser capture is not authorized");
  }
  const intentId = request.intentId;
  const createdAt = request.capture.run.endedAt;
  const evidenceId = `recapture-${scene.runId}-${scene.sceneKey}`;
  try {
    const applied = await store.applyBatchWithLocalAsset(request.projectId, {
      baseRevisionId: request.baseRevisionId,
      intentId,
      source,
      options,
      buildAsset: (facts) => {
        if (facts.sha256 !== scene.sha256 || facts.type !== "uploaded_video"
          || facts.probe.width !== scene.width || facts.probe.height !== scene.height
          || facts.probe.durationMs !== scene.durationMs) {
          throw new LocalImportError("SOURCE_CHANGED", "capture source differs from its run manifest");
        }
        const assetId = `asset-${digest({ projectId: request.projectId, previousAssetId: request.previousAssetId, runId: scene.runId, sceneKey: scene.sceneKey, sha256: facts.sha256 }).slice(0, 32)}`;
        return MediaAssetSchema.parse({
          id: assetId,
          type: "browser_capture",
          path: facts.path,
          sha256: facts.sha256,
          probe: facts.probe,
          provenance: {
            kind: "browser",
            flowId: previousProvenance.flowId,
            sceneKey: scene.sceneKey,
            actionIds: scene.actionIds,
            checkpointActionId: scene.checkpointActionId,
            runId: scene.runId,
            capturedAt: createdAt,
            predecessorAssetId: request.previousAssetId,
          },
        });
      },
      buildBatch: (replacementAsset): OperationBatchInput => ({
        baseRevisionId: request.baseRevisionId,
        actor: "recapture",
        intentId,
        evidenceRefs: [],
        createdAt,
        operations: [{
          type: "replace_browser_capture",
          previousAssetId: request.previousAssetId,
          replacementAsset,
          changedActionIds: request.changedActionIds,
          reason: request.reason.trim(),
        }],
      }),
    });
    if (!applied.ok) reject(applied.code === "STALE_REVISION" ? "STALE_REVISION" : "INVALID_OPERATION", "browser capture replacement was rejected");
    const replacementAssetId = `asset-${digest({ projectId: request.projectId, previousAssetId: request.previousAssetId, runId: scene.runId, sceneKey: scene.sceneKey, sha256: scene.sha256 }).slice(0, 32)}`;
    const replacementAsset = applied.project.assets[replacementAssetId];
    if (!replacementAsset) reject("PRESERVATION_FAILED", "replacement asset is missing from the committed revision");
    const report = buildReport(before, applied.project, request, scene, replacementAsset, applied.operationLog);
    const evidenceRef = await store.writeEvidence(request.projectId, evidenceId, report);
    return { project: applied.project, revisionId: applied.revisionId, replacementAsset, operationLog: applied.operationLog, report, evidenceRef };
  } catch (error) {
    if (error instanceof RecaptureV2Error) throw error;
    if (error instanceof LocalImportError) throw mapImportError(error);
    if (error instanceof LocalProjectStoreError) {
      if (error.code === "STORAGE_FAILED") reject("EVIDENCE_FAILED", "recapture evidence or project storage failed");
      if (error.code === "INVALID_OPERATION" || error.code === "IDEMPOTENCY_CONFLICT") reject("INVALID_OPERATION", "recapture project transaction failed");
      reject("STALE_REVISION", "recapture project revision is unavailable");
    }
    reject("EVIDENCE_FAILED", "recapture preservation evidence could not be written");
  } finally {
    await closeAuthorizedLocalImport(source);
  }
}
