import { defineConfig } from "vitest/config";

/**
 * Unit tests for main-process pure modules (trace parsers, protocol helpers).
 * These modules import no Electron/DOM APIs, so the node environment suffices
 * and the tests run fast without a browser or packaged app.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
