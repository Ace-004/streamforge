import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/tests/setup.ts"],
    fileParallelism: false, // tests share one DB; run files serially to avoid cross-test interference
  },
});