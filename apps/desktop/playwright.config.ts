import { defineConfig } from "@playwright/test";

/**
 * Playwright config for CodeHub AI desktop E2E tests.
 *
 * Tests are organized into lanes (projects) borrowed from pi-gui's approach:
 *
 *   core       — background-friendly in-window UI behavior (default)
 *   live       — real runtime/provider coverage (requires provider auth)
 *   production — packaged-app smoke tests (requires built installer)
 *
 * Prerequisite: run `pnpm build` before executing tests so that
 * `out/main/index.js` exists. The test:e2e script does this automatically.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "core",
      testMatch: "core/**/*.spec.ts",
      metadata: { lane: "core" },
    },
    {
      name: "live",
      testMatch: "live/**/*.spec.ts",
      metadata: { lane: "live" },
    },
    {
      name: "production",
      testMatch: "production/**/*.spec.ts",
      metadata: { lane: "production" },
    },
  ],
});
