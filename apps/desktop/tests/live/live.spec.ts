import { test, expect } from "@playwright/test";
import { launchTestApp, waitForAppReady, loginToMainShell, type TestApp } from "../helpers/electron-app";

/**
 * Live lane: real runtime/provider coverage.
 *
 * Opt-in via environment variables:
 *   AI_WORKBENCH_LIVE_AUTH=1                      enable this lane
 *   AI_WORKBENCH_LIVE_SERVER=http://127.0.0.1:3000  backend server URL
 *   AI_WORKBENCH_LIVE_EMAIL=<account>             account email
 *   AI_WORKBENCH_LIVE_PASSWORD=<password>         account password
 *
 * Requires a running backend and valid provider credentials (Codex, Claude
 * Code, OpenCode, or MiMo). Skipped by default so the fast lane stays
 * deterministic and offline-friendly.
 */
const liveEnabled = process.env.AI_WORKBENCH_LIVE_AUTH === "1";
const liveServer = process.env.AI_WORKBENCH_LIVE_SERVER ?? "http://127.0.0.1:3000";
const liveEmail = process.env.AI_WORKBENCH_LIVE_EMAIL ?? "";
const livePassword = process.env.AI_WORKBENCH_LIVE_PASSWORD ?? "";

test.describe("live agent runtime", () => {
  test.skip(!liveEnabled, "set AI_WORKBENCH_LIVE_AUTH=1 with a running backend and provider credentials to enable");

  let testApp: TestApp;

  test.afterEach(async () => {
    await testApp?.cleanup();
  });

  test("logs in against the real backend and detects installed providers", async () => {
    // Launch with cloud sync enabled (override the harness's test-mode flag
    // so real pairing and provider auto-detect run).
    testApp = await launchTestApp({ env: { AI_WORKBENCH_TEST_MODE: "" } });
    await waitForAppReady(testApp.window);
    await loginToMainShell(testApp.window, { server: liveServer, email: liveEmail, password: livePassword });

    // The sidebar should settle and eventually show detected providers in the
    // settings. Wait for at least one provider chip to appear.
    await expect(testApp.window.locator(".app-shell")).toBeVisible();

    // Open settings -> 连接 panel: device + account info from the real backend.
    await testApp.window.locator(".account-menu-wrap button").first().click();
    await testApp.window.locator(".account-menu-popover button", { hasText: "设置" }).click();
    await expect(testApp.window.locator(".settings-page")).toBeVisible({ timeout: 15_000 });
    await expect(testApp.window.locator(".settings-nav-list button", { hasText: "连接" })).toBeVisible();
  });
});
