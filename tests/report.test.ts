import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalEnvironment, normalFlow } from "../fixtures/apps/normal/flow.js";
import { createProject } from "../src/project.js";
import { generateReport } from "../src/report.js";

describe("static evidence report", () => {
  it("renders the authoritative revision as escaped, local review evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-report-"));
    try {
      const project = createProject({
        projectId: "report-project",
        brief: { audience: "Founders", message: "<script>alert(1)</script>", targetDurationMs: 30000 },
        environment: normalEnvironment("http://127.0.0.1:4173"),
        flow: normalFlow("http://127.0.0.1:4173"),
        captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({ id: `capture-${index}`, sceneKey, path: `captures/${index}.mp4`, durationMs: 10000, sha256: String(index + 1).repeat(64) })),
      });
      const output = generateReport(project, root, {
        render: { path: "renders/revision-0.mp4", durationMs: 30000, verification: "passed" },
        checks: [{ code: "MEDIA_PROBE", passed: true, detail: "H.264/AAC 1920x1080 at 30 fps" }],
      });
      const html = await readFile(output, "utf8");
      const tokens = await readFile(join(root, "tokens.css"), "utf8");

      expect(html).toContain("Release Replay");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain('<video controls preload="metadata"');
      expect(html).toContain("MEDIA_PROBE");
      expect(tokens).toContain("--color-paper");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links the current revision output when no render override is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-report-output-"));
    try {
      const source = createProject({
        projectId: "report-output-project",
        brief: { audience: "Founders", message: "Show filtering", targetDurationMs: 30000 },
        environment: normalEnvironment("http://127.0.0.1:4173"),
        flow: normalFlow("http://127.0.0.1:4173"),
        captures: ["open-demo", "open-filter", "apply-filter"].map((sceneKey, index) => ({ id: `capture-${index}`, sceneKey, path: `captures/${index}.mp4`, durationMs: 10000, sha256: String(index + 1).repeat(64) })),
      });
      const output = { id: "render-output-revision-0", revisionId: source.currentRevisionId, renderJobSha256: "a".repeat(64), path: "renders/revision-0.mp4", ffprobe: { durationMs: 30000, width: 1920, height: 1080, fps: 30 as const, videoCodec: "h264", audioCodec: "aac" }, verificationId: "verification-revision-0" };
      const report = generateReport({ ...source, outputs: [output] }, root);
      expect(await readFile(report, "utf8")).toContain('src="renders/revision-0.mp4"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
