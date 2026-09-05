import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Project } from "./schema.js";

export type VerificationPhase = "browser" | "scene" | "recapture" | "render";
export type FirstCause = "browser_automation" | "checkpoint_state" | "capture" | "scene_mapping" | "operation" | "recapture" | "model_decision" | "verification" | "rendering";

export interface VerificationCheck {
  code: string;
  passed: boolean;
  detail: string;
  evidencePaths?: string[];
}

export interface VerificationResult {
  id: string;
  phase: VerificationPhase;
  passed: boolean;
  checks: VerificationCheck[];
  firstCause?: FirstCause;
}

/** Mechanical authorization for a render; no aesthetic or publishability claim is made here. */
export function verifyProject(project: Project, root: string): VerificationResult {
  const checks: VerificationCheck[] = [];
  let firstCause: FirstCause | undefined;
  const check = (code: string, passed: boolean, detail: string, cause: FirstCause, evidencePaths?: string[]) => {
    checks.push({ code, passed, detail, ...(evidencePaths?.length ? { evidencePaths } : {}) });
    if (!passed && !firstCause) firstCause = cause;
  };

  check("FLOW_APPROVED", project.flow.steps.every((step) => step.approved), "Every declared flow step is approved.", "browser_automation");
  check("SCENE_COUNT", project.scenes.length >= 3 && project.scenes.length <= 5, "Project contains 3–5 scenes.", "scene_mapping");
  const uniqueSceneIds = new Set(project.scenes.map((scene) => scene.id)).size === project.scenes.length;
  const uniqueKeys = new Set(project.scenes.map((scene) => scene.sceneKey)).size === project.scenes.length;
  const ordered = project.scenes.map((scene) => scene.order).sort((a, b) => a - b).every((order, index) => order === index);
  check("SCENE_IDENTITY", uniqueSceneIds && uniqueKeys && ordered, "Scene IDs, keys, and orders are unique and contiguous.", "scene_mapping");

  for (const scene of project.scenes) {
    const capture = project.captures[scene.captureId];
    check("SCENE_CAPTURE", Boolean(capture), `Scene ${scene.id} resolves to a capture.`, "scene_mapping");
    if (!capture) continue;
    const path = safePath(root, capture.path);
    const present = Boolean(path && existsSync(path) && statSync(path).size > 0);
    check("CAPTURE_EXISTS", present, `Capture ${capture.id} exists and is non-empty.`, "capture", path ? [capture.path] : undefined);
    if (present && path) check("CAPTURE_HASH", sha256File(path) === capture.sha256, `Capture ${capture.id} matches its recorded SHA-256.`, "capture", [capture.path]);
    const flowSteps = new Set(project.flow.steps.map((step) => step.id));
    const provenance = scene.actionIds.every((id) => flowSteps.has(id) && capture.actionIds.includes(id)) && scene.actionIds.includes(scene.checkpointActionId) && scene.checkpointActionId === capture.checkpointActionId;
    check("SCENE_PROVENANCE", provenance, `Scene ${scene.id} maps to approved producing actions and checkpoint.`, "scene_mapping");
    check("SCENE_RANGE", scene.sourceInMs >= 0 && scene.sourceOutMs > scene.sourceInMs && scene.sourceOutMs <= capture.durationMs, `Scene ${scene.id} range fits its capture.`, "scene_mapping");
  }

  for (const overlay of Object.values(project.overlays)) {
    const scene = project.scenes.find((candidate) => candidate.id === overlay.sceneId);
    const duration = scene ? (scene.sourceOutMs - scene.sourceInMs) / scene.speed : 0;
    check("OVERLAY_RANGE", Boolean(scene) && overlay.startMs >= 0 && overlay.endMs > overlay.startMs && overlay.endMs <= duration, `Overlay ${overlay.id} fits its scene and safe operation range.`, "scene_mapping");
  }
  const duration = project.scenes.reduce((sum, scene) => sum + (scene.sourceOutMs - scene.sourceInMs) / scene.speed, 0);
  check("TOTAL_DURATION", duration >= 25000 && duration <= 35000, `Derived duration is ${Math.round(duration)}ms.`, "scene_mapping");
  return { id: `verification-${project.currentRevisionId}`, phase: "scene", passed: !firstCause, checks, ...(firstCause ? { firstCause } : {}) };
}

function safePath(root: string, candidate: string): string | undefined {
  if (isAbsolute(candidate) || candidate.includes("..")) return undefined;
  const resolved = resolve(root, candidate);
  return relative(resolve(root), resolved).startsWith("..") ? undefined : resolved;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
