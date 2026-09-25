import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateMediaEvidence } from "../src/media-evidence.js";

describe("media evidence source binding", () => {
  it("rejects bytes that no longer match the authorized asset handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "replex-evidence-source-"));
    const sourcePath = join(root, "source.mp4");
    const evidenceRoot = join(root, "project", "evidence");
    const authorizedBytes = Buffer.from("original source bytes");
    await writeFile(sourcePath, "changed source bytes");

    try {
      await expect(generateMediaEvidence({
        asset: {
          assetId: "asset-evidence",
          sha256: createHash("sha256").update(authorizedBytes).digest("hex"),
          ref: "media/source.mp4",
        },
        evidenceRoot,
        resolveSource: async () => sourcePath,
      })).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
