import { spawnSync } from "node:child_process";

export const ffmpegPath = process.env.REPLEX_FFMPEG_PATH ?? "ffmpeg";
export const ffprobePath = process.env.REPLEX_FFPROBE_PATH ?? "ffprobe";

function probes(ffmpeg: string, ffprobe: string): boolean {
  for (const [command, args] of [[ffmpeg, ["-version"]], [ffprobe, ["-version"]]] as const) {
    const run = spawnSync(command, args, { encoding: "utf8", windowsHide: true, shell: false, timeout: 15_000 });
    if (run.error || run.status !== 0) return false;
  }
  return true;
}

/** True only when the media tools resolve and execute, not merely when the names exist on PATH. */
export const mediaAvailable = probes(ffmpegPath, ffprobePath);
