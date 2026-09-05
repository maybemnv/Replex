import { appendFileSync, mkdirSync } from "node:fs";
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
  kind: "capture" | "screenshot" | "verification";
}

export type InspectionResult =
  | { ok: true; tool: InspectionRequest["kind"]; summary: string; artifacts: ArtifactReference[]; truncated: boolean }
  | { ok: false; code: "INVALID_REQUEST" | "NOT_FOUND" | "FORBIDDEN"; detail: string };

const MAX_SUMMARY_CHARS = 1000;

/** The model-facing read seam: stable IDs in, short redacted facts and handles out. */
export function inspectProject(project: Project, root: string, request: InspectionRequest): InspectionResult {
  if (!validRequest(request)) return { ok: false, code: "INVALID_REQUEST", detail: "inspection request must use one fixed tool and stable ID fields" };
  if (request.kind === "inspect_browser_trace") return { ok: false, code: "FORBIDDEN", detail: "raw browser traces are never model-disclosable" };

  let summary: string;
  let artifacts: ArtifactReference[] = [];
  switch (request.kind) {
    case "inspect_project":
      summary = `Project ${project.projectId}. Brief: ${project.brief.message}. ${project.scenes.length} scenes, revision ${project.currentRevisionId}, target ${project.brief.targetDurationMs}ms.`;
      artifacts = captureArtifacts(project);
      break;
    case "inspect_flow":
      summary = `Flow ${project.flow.id}. ${project.flow.steps.length} approved steps. Allowed origins: ${project.environment.allowedOrigins.join(", ")}.`;
      break;
    case "inspect_scene": {
      const scene = project.scenes.find((candidate) => candidate.id === request.sceneId);
      if (!scene) return { ok: false, code: "NOT_FOUND", detail: "scene does not exist" };
      const capture = project.captures[scene.captureId];
      summary = `Scene ${scene.id} (${scene.sceneKey}): capture ${scene.captureId}, ${scene.sourceInMs}-${scene.sourceOutMs}ms at ${scene.speed}x, checkpoint ${scene.checkpointActionId}.`;
      artifacts = capture ? [captureArtifact(capture.id, capture.path)] : [];
      break;
    }
    case "inspect_capture": {
      const capture = project.captures[request.captureId];
      if (!capture) return { ok: false, code: "NOT_FOUND", detail: "capture does not exist" };
      summary = `Capture ${capture.id}: scene ${capture.sceneKey}, ${capture.durationMs}ms, ${capture.width}x${capture.height} at ${capture.fps}fps, SHA-256 ${capture.sha256}.`;
      artifacts = [captureArtifact(capture.id, capture.path)];
      break;
    }
    case "inspect_screenshot": {
      const scene = project.scenes.find((candidate) => candidate.id === request.sceneId);
      if (!scene) return { ok: false, code: "NOT_FOUND", detail: "scene does not exist" };
      summary = `No screenshot is disclosed for scene ${scene.id}; request its bounded capture metadata instead.`;
      break;
    }
    case "inspect_verification_results":
      summary = `No persisted verification result is attached to revision ${project.currentRevisionId}. Verification must run before rendering.`;
      break;
  }
  const redacted = redact(summary);
  const result: InspectionResult = { ok: true, tool: request.kind, summary: cap(redacted), artifacts, truncated: redacted.length > MAX_SUMMARY_CHARS };
  auditDisclosure(root, result);
  return result;
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

function cap(value: string): string {
  return value.length <= MAX_SUMMARY_CHARS ? value : `${value.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}
