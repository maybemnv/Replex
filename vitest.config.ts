import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These functional tests launch Chromium and FFmpeg. Keep file-level CPU/process use bounded;
    // explicit concurrent-operation tests still exercise application races within each suite.
    maxWorkers: 1,
  },
});
