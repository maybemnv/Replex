import { describe, expect, it } from "vitest";
import { createProjectV2, semanticHashV2 } from "../src/operations-v2.js";

describe("new V2 project defaults", () => {
  it("creates empty video, audio, and overlay tracks with a valid initial revision", () => {
    const project = createProjectV2({
      projectId: "new-composition",
      brief: { message: "A software launch video" },
      width: 320,
      height: 180,
      fps: 24,
      durationMs: 3_000,
      createdAt: "2026-09-25T00:00:00.000Z",
    });

    expect(project.composition.tracks.map(({ id, kind }) => [id, kind])).toEqual([
      ["track-video", "video"],
      ["track-audio", "audio"],
      ["track-overlay", "overlay"],
    ]);
    expect(project.composition.clips).toEqual([]);
    expect(project.composition.layers).toEqual([]);
    expect(project.revisions[0]?.manifestSha256).toBe(semanticHashV2(project));
    expect(project.currentRevisionId).toBe("revision-0");
  });
});
