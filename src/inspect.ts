import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./schema.js";

export type InspectionRequest =
  | { kind: "inspect_project" }
  | { kind: "inspect_flow" }
  | { kind: "inspect_scene"; sceneId: string }
  | { kind: "inspect_capture"; captureId: string }
  | { kind: "inspect_browser_trace" }
  | { kind: "inspect_verification_results" }
  | { kind: "inspect_screenshot"; sceneId: string };

export interface ArtifactReference {
  id: string;
  path: string;
  kind: "capture" | "screenshot" | "trace" | "verification";
}

export interface InspectionDetails {
  scenes?: Array<Record<string, unknown>>;
  scene?: Record<string, unknown>;
  flow?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  verification?: Record<string, unknown>;
}

export type InspectionResult =
  | { ok: true; tool: InspectionRequest["kind"]; summary: string; artifacts: ArtifactReference[]; truncated: boolean; details?: InspectionDetails }
  | { ok: false; code: "INVALID_REQUEST" | "NOT_FOUND" | "FORBIDDEN"; detail: string };

const MAX_SUMMARY_CHARS = 1000;

/** The model-facing read seam: stable IDs in, short redacted facts and handles out. */
export function inspectProject(project: Project, root: string, request: InspectionRequest): InspectionResult {
  if (!validRequest(request)) return { ok: false, code: "INVALID_REQUEST", detail: "inspection request must use one fixed tool and stable ID fields" };
  let summary: string;
  let artifacts: ArtifactReference[] = [];
  let details: InspectionDetails | undefined;
  switch (request.kind) {
    case "inspect_project":
      summary = `Project ${project.projectId}. Brief: ${project.brief.message}. Scenes: ${project.scenes.map((scene) => `${scene.sceneKey}=${scene.id}`).join(", ")}. Revision ${project.currentRevisionId}, target ${project.brief.targetDurationMs}ms.`;
      artifacts = captureArtifacts(project).slice(0, 20);
      details = { scenes: orderedScenes(project).slice(0, 12).map((scene) => sceneDetails(scene, project)) };
      break;
    case "inspect_flow": {
      summary = `Flow ${project.flow.id}. ${project.flow.steps.length} approved steps. Checkpoints: ${project.flow.steps.map((step) => `${step.id} ${step.checkpoint.kind}=${safeText(step.checkpoint.expected)}`).join("; ")}. Allowed origins: ${project.environment.allowedOrigins.join(", ")}.`;
      details = {
        flow: {
          id: project.flow.id,
          allowedOrigins: project.environment.allowedOrigins,
          steps: project.flow.steps.slice(0, 20).map((step) => ({
            id: step.id,
            sceneKey: step.sceneKey,
            action: step.action,
            consequential: step.consequential,
            approved: step.approved,
            checkpoint: checkpointDetails(step.checkpoint),
          })),
        },
      };
      break;
    }
    case "inspect_scene": {
      const scene = project.scenes.find((candidate) => candidate.id === request.sceneId);
      if (!scene) return { ok: false, code: "NOT_FOUND", detail: "scene does not exist" };
      const capture = project.captures[scene.captureId];
      const checkpoint = project.flow.steps.find((step) => step.id === scene.checkpointActionId)?.checkpoint;
      summary = `Scene ${scene.id} (${scene.sceneKey}): capture ${scene.captureId}, ${scene.sourceInMs}-${scene.sourceOutMs}ms at ${scene.speed}x, actions ${scene.actionIds.join(", ")}, checkpoint ${scene.checkpointActionId}${checkpoint ? ` ${checkpoint.kind}=${safeText(checkpoint.expected)}` : ""}.`;
      artifacts = capture ? [captureArtifact(capture.id, capture.path)] : [];
      details = { scene: sceneDetails(scene, project), scenes: [sceneDetails(scene, project)] };
      break;
    }
    case "inspect_capture": {
      const capture = project.captures[request.captureId];
      if (!capture) return { ok: false, code: "NOT_FOUND", detail: "capture does not exist" };
      summary = `Capture ${capture.id}: scene ${capture.sceneKey}, ${capture.durationMs}ms, ${capture.width}x${capture.height} at ${capture.fps}fps, actions ${capture.actionIds.join(", ")}, checkpoint ${capture.checkpointActionId}, SHA-256 ${capture.sha256}.`;
      artifacts = [captureArtifact(capture.id, capture.path)];
      details = { capture: { id: capture.id, sceneKey: capture.sceneKey, runId: capture.runId, actionIds: capture.actionIds, checkpointActionId: capture.checkpointActionId, path: capture.path, durationMs: capture.durationMs, width: capture.width, height: capture.height, fps: capture.fps, sha256: capture.sha256 } };
      break;
    }
    case "inspect_screenshot": {
      const scene = project.scenes.find((candidate) => candidate.id === request.sceneId);
      if (!scene) return { ok: false, code: "NOT_FOUND", detail: "scene does not exist" };
      const path = `screenshots/${scene.sceneKey}-after.png`;
      if (!existsSync(join(root, path))) return { ok: false, code: "NOT_FOUND", detail: "targeted screenshot does not exist" };
      summary = `Targeted post-checkpoint screenshot is available for scene ${scene.id}.`;
      artifacts = [{ id: `screenshot:${scene.id}:after`, path, kind: "screenshot" }];
      break;
    }
    case "inspect_browser_trace": {
      const path = "traces/trace.zip";
      if (!existsSync(join(root, path))) return { ok: false, code: "NOT_FOUND", detail: "trace evidence does not exist" };
      summary = "Trace evidence exists. The raw trace remains undisclosed; use the named capture and checkpoint evidence instead.";
      artifacts = [{ id: "trace:latest", path, kind: "trace" }];
      break;
    }
    case "inspect_verification_results": {
      const path = `verification/${project.currentRevisionId}.json`;
      if (!existsSync(join(root, path))) return { ok: false, code: "NOT_FOUND", detail: "verification evidence does not exist" };
      const verification = readVerificationDetails(join(root, path));
      summary = `Verification evidence is available for revision ${project.currentRevisionId}${verification ? `: ${verification.passed ? "passed" : "failed"}, ${verification.failedChecks} failed checks${verification.firstCause ? `, first cause ${verification.firstCause}` : ""}.` : "."}`;
      artifacts = [{ id: `verification:${project.currentRevisionId}`, path, kind: "verification" }];
      if (verification) details = { verification };
      break;
    }
  }
  const redacted = redact(summary);
  const result: InspectionResult = { ok: true, tool: request.kind, summary: cap(redacted), artifacts, truncated: redacted.length > MAX_SUMMARY_CHARS || (request.kind === "inspect_project" && (project.scenes.length > 12 || Object.keys(project.captures).length > 20)) || (request.kind === "inspect_flow" && project.flow.steps.length > 20), ...(details ? { details } : {}) };
  auditDisclosure(root, result);
  return result;
}

function orderedScenes(project: Project): Project["scenes"] {
  return [...project.scenes].sort((left, right) => left.order - right.order);
}

function sceneDetails(scene: Project["scenes"][number], project?: Project): Record<string, unknown> {
  const checkpoint = project?.flow.steps.find((step) => step.id === scene.checkpointActionId)?.checkpoint;
  const overlays = project ? Object.values(project.overlays).filter((overlay) => overlay.sceneId === scene.id).slice(0, 12).map((overlay) => ({ id: overlay.id, kind: overlay.kind, text: safeText(overlay.text), placement: overlay.placement, startMs: overlay.startMs, endMs: overlay.endMs })) : undefined;
  return {
    id: scene.id,
    sceneKey: scene.sceneKey,
    captureId: scene.captureId,
    actionIds: scene.actionIds.slice(0, 20),
    checkpointActionId: scene.checkpointActionId,
    ...(checkpoint ? { checkpoint: checkpointDetails(checkpoint) } : {}),
    sourceInMs: scene.sourceInMs,
    sourceOutMs: scene.sourceOutMs,
    speed: scene.speed,
    order: scene.order,
    ...(overlays ? { overlays } : {}),
  };
}

function checkpointDetails(checkpoint: { kind: string; expected: string; target?: { kind: string; value: string; name?: string } }): Record<string, unknown> {
  return {
    kind: checkpoint.kind,
    expected: safeText(checkpoint.expected),
    ...(checkpoint.target ? { target: { kind: checkpoint.target.kind, value: safeText(checkpoint.target.value), ...(checkpoint.target.name ? { name: safeText(checkpoint.target.name) } : {}) } } : {}),
  };
}

function readVerificationDetails(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; phase?: unknown; passed?: unknown; firstCause?: unknown; checks?: unknown };
    if (typeof value.id !== "string" || typeof value.phase !== "string" || typeof value.passed !== "boolean" || !Array.isArray(value.checks)) return undefined;
    const checks = value.checks.filter((check): check is { code?: unknown; passed?: unknown; detail?: unknown } => Boolean(check && typeof check === "object")).slice(0, 30);
    return {
      id: value.id,
      phase: value.phase,
      passed: value.passed,
      ...(typeof value.firstCause === "string" ? { firstCause: value.firstCause } : {}),
      failedChecks: checks.filter((check) => check.passed === false).length,
      checks: checks.map((check) => ({ code: typeof check.code === "string" ? safeText(check.code) : "unknown", passed: check.passed === true, detail: typeof check.detail === "string" ? safeText(check.detail, 300) : "missing detail" })),
    };
  } catch {
    return undefined;
  }
}

function validRequest(value: unknown): value is InspectionRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (input.kind === "inspect_project" || input.kind === "inspect_flow" || input.kind === "inspect_browser_trace" || input.kind === "inspect_verification_results") return keys.length === 1;
  if (input.kind === "inspect_scene" || input.kind === "inspect_screenshot") return keys.length === 2 && typeof input.sceneId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.sceneId);
  return input.kind === "inspect_capture" && keys.length === 2 && typeof input.captureId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.captureId);
}

function captureArtifacts(project: Project): ArtifactReference[] {
  return Object.values(project.captures).map((capture) => captureArtifact(capture.id, capture.path));
}

function captureArtifact(id: string, path: string): ArtifactReference {
  return { id: `capture:${id}`, path: path.replace(/\\/g, "/"), kind: "capture" };
}

function auditDisclosure(root: string, result: Extract<InspectionResult, { ok: true }>): void {
  if (!root || root === "unused") return;
  const path = join(root, "logs", "disclosures.jsonl");
  mkdirSync(join(root, "logs"), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), tool: result.tool, artifactIds: result.artifacts.map((artifact) => artifact.id) })}\n`, "utf8");
}

function redact(value: string): string {
  return value.replace(/\b(?:token|access_token|refresh_token|api[-_]?key|password|secret)\s*[=:]\s*[^\s,;]+/gi, "[REDACTED]");
}

function safeText(value: string, limit = 180): string {
  return redact(value).slice(0, limit);
}

function cap(value: string): string {
  return value.length <= MAX_SUMMARY_CHARS ? value : `${value.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}
