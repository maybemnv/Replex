import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { join } from "node:path";
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

export interface VerificationOptions {
  checkMedia?: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  persist?: boolean;
}

/** Mechanical authorization for a render; no aesthetic or publishability claim is made here. */
export function verifyProject(project: Project, root: string, options: VerificationOptions = {}): VerificationResult {
  const checkMedia = options.checkMedia ?? true;
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

  const checkedCaptures = new Set<string>();
  for (const scene of project.scenes) {
    const capture = project.captures[scene.captureId];
    check("SCENE_CAPTURE", Boolean(capture), `Scene ${scene.id} resolves to a capture.`, "scene_mapping");
    if (!capture) continue;
    const path = safePath(root, capture.path);
    const present = Boolean(path && existsSync(path) && statSync(path).size > 0);
    check("CAPTURE_EXISTS", present, `Capture ${capture.id} exists and is non-empty.`, "capture", path ? [capture.path] : undefined);
    if (present && path) check("CAPTURE_HASH", sha256File(path) === capture.sha256, `Capture ${capture.id} matches its recorded SHA-256.`, "capture", [capture.path]);
    if (checkMedia && present && path && !checkedCaptures.has(capture.id)) {
      checkedCaptures.add(capture.id);
      const media = probeCapture(path, capture, options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe");
      check("CAPTURE_MEDIA", media.passed, media.detail, "capture", [capture.path]);
      if (media.passed) {
        const visual = scanCapture(path, options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg");
        check("CAPTURE_BLANK_FREEZE", visual.passed, visual.detail, "capture", [capture.path]);
      }
    }
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
  let result: VerificationResult = { id: `verification-${project.currentRevisionId}`, phase: "scene", passed: !firstCause, checks, ...(firstCause ? { firstCause } : {}) };
  if (options.persist !== false) {
    try {
      writeVerificationResult(root, result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result = {
        ...result,
        passed: false,
        checks: [...result.checks, { code: "VERIFICATION_PERSISTED", passed: false, detail: `Could not persist verification evidence: ${detail}` }],
        ...(result.firstCause ? {} : { firstCause: "verification" as const }),
      };
    }
  }
  return result;
}

export function writeVerificationResult(root: string, result: VerificationResult): string {
  const directory = join(root, "verification");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${result.id.replace(/^verification-/, "")}.json`);
  const temporary = join(directory, `.${result.id}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
    committed = true;
    return path;
  } finally {
    if (!committed && existsSync(temporary)) unlinkSync(temporary);
  }
}

export function loadVerificationResult(root: string, revisionId: string): VerificationResult | undefined {
  try {
    const value = JSON.parse(readFileSync(join(root, "verification", `${revisionId}.json`), "utf8")) as Partial<VerificationResult>;
    if (value.id !== `verification-${revisionId}` || value.phase !== "scene" || !Array.isArray(value.checks) || typeof value.passed !== "boolean") return undefined;
    return value as VerificationResult;
  } catch {
    return undefined;
  }
}

function safePath(root: string, candidate: string): string | undefined {
  if (isAbsolute(candidate) || candidate.includes("..")) return undefined;
  const resolved = resolve(root, candidate);
  return relative(resolve(root), resolved).startsWith("..") ? undefined : resolved;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function probeCapture(path: string, capture: Project["captures"][string], ffprobePath: string): { passed: boolean; detail: string } {
  const run = spawnSync(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", path], { encoding: "utf8", windowsHide: true });
  if (run.status !== 0) return { passed: false, detail: `Capture ${capture.id} could not be probed: ${(run.stderr || run.error?.message || "ffprobe failed").trim()}` };
  try {
    const output = JSON.parse(run.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }> };
    const video = output.streams?.find((stream) => stream.codec_type === "video");
    const durationMs = Number(output.format?.duration ?? "NaN") * 1000;
    const fps = parseRate(video?.avg_frame_rate);
    const passed = Boolean(video?.codec_name) && Number.isFinite(durationMs) && Math.abs(durationMs - capture.durationMs) <= 250 && video?.width === capture.width && video?.height === capture.height && Math.abs(fps - capture.fps) <= 0.05;
    return { passed, detail: passed ? `Capture ${capture.id} media matches recorded duration, dimensions, and frame rate.` : `Capture ${capture.id} media does not match recorded duration, dimensions, and frame rate.` };
  } catch (error) {
    return { passed: false, detail: `Capture ${capture.id} returned invalid ffprobe JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function scanCapture(path: string, ffmpegPath: string): { passed: boolean; detail: string } {
  const run = spawnSync(ffmpegPath, ["-hide_banner", "-i", path, "-vf", "blackdetect=d=1:pix_th=0.10,freezedetect=n=0.003:d=1", "-an", "-f", "null", "-"], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  if (run.status !== 0) return { passed: false, detail: `Capture visual scan failed: ${(run.stderr || run.error?.message || "ffmpeg failed").trim()}` };
  const intervals = [...(run.stderr || "").matchAll(/(?:black_duration|freeze_duration):([0-9.]+)/g)].map((match) => Number(match[1]));
  const longInterval = intervals.find((duration) => duration >= 1);
  return longInterval === undefined
    ? { passed: true, detail: "Capture has no detected black or frozen interval lasting at least one second." }
    : { passed: false, detail: `Capture contains a black or frozen interval of ${longInterval.toFixed(3)} seconds.` };
}

function parseRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? numerator / denominator : numerator;
}
