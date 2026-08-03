import { _electron as electron, test, expect } from "@playwright/test";

/**
 * Production lane: packaged-app smoke tests.
 *
 * Opt-in via environment variables:
 *   AI_WORKBENCH_PRODUCTION=1                     enable this lane
 *   AI_WORKBENCH_PACKAGED_APP=<path\to\app.exe>    path to the packaged executable
 *
 * Verifies the packaged app launches, shows its window, and settles on the
 * login page. Skipped by default — used for release readiness checks.
 */
const prodEnabled = process.env.AI_WORKBENCH_PRODUCTION === "1";
const packagedApp = process.env.AI_WORKBENCH_PACKAGED_APP ?? "";

test.describe("packaged app smoke", () => {
  test.skip(
    !prodEnabled,
    "set AI_WORKBENCH_PRODUCTION=1 and AI_WORKBENCH_PACKAGED_APP to enable (requires a built installer)",
  );

  test("packaged app launches and shows the login page", async () => {
    test.skip(!packagedApp, "AI_WORKBENCH_PACKAGED_APP is not set");

    const app = await electron.launch({
      executablePath: packagedApp,
      args: [],
      env: { ...process.env, AI_WORKBENCH_TEST_MODE: "background" },
      timeout: 60_000,
    });

    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");

      // Window title carries the brand.
      const title = await window.title();
      expect(title).toContain("CodeHub AI");

      // The login page (or the boot screen while auth is checked) settles on
      // the login form — brand heading + server address field.
      await expect(window.locator("h1", { hasText: "CodeHub AI" })).toBeVisible({ timeout: 20_000 });
      await expect(window.locator('input[placeholder="请输入服务器地址"]')).toBeVisible({ timeout: 10_000 });
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
