import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { chromium } from "@playwright/test";
import { resolveRenderFont } from "../render.js";

function executable(name: string): string {
  const candidates = isAbsolute(name) ? [name] : (process.env.PATH ?? "").split(delimiter).map((root) => join(root, name));
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); return realpathSync(path); } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("Demo needs FFmpeg/ffprobe. Set REPLEX_FFMPEG_PATH and REPLEX_FFPROBE_PATH to trusted direct binaries.");
}

export function checkDemoPrerequisites(options: { nodeVersion?: string; ffmpegPath?: string; ffprobePath?: string } = {}) {
  if (Number((options.nodeVersion ?? process.versions.node).split(".")[0]) < 22) throw new Error("Demo requires Node.js 22 or newer.");
  const ffmpegPath = executable(options.ffmpegPath ?? process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg");
  const ffprobePath = executable(options.ffprobePath ?? process.env.REPLEX_FFPROBE_PATH ?? "ffprobe");
  const versions: string[] = [];
  for (const [binary, name] of [[ffmpegPath, "ffmpeg"], [ffprobePath, "ffprobe"]]) {
    const run = spawnSync(binary!, ["-version"], { shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 });
    if (run.error || run.status !== 0) throw new Error(`Demo could not run ${name}; check its configured direct binary.`);
    const text = run.stdout;
    // FFmpeg 9 releases, or a development build with its libavfilter ABI; older system builds fail V2 renders.
    const release = text.match(/version\s+(?:n)?(\d+)\./i);
    const filter = text.match(/libavfilter\s+(\d+)\./);
    if (release ? Number(release[1]) < 9 : !filter || Number(filter[1]) < 12) throw new Error("Demo needs FFmpeg/ffprobe 9 or a compatible development build; older system builds are unsupported.");
    versions.push(text.split("\n")[0]!);
  }
  try { accessSync(chromium.executablePath(), constants.X_OK); }
  catch { throw new Error("Demo needs bundled Chromium. Run: npx playwright install chromium"); }
  try { accessSync(resolveRenderFont().file, constants.R_OK); }
  catch { throw new Error("Demo needs a readable TrueType render font; configure REPLEX_FONT_FILE."); }
  return { ffmpegPath, ffprobePath, versions };
}
