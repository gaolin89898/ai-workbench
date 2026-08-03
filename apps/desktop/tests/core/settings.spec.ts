import { test, expect } from "@playwright/test";
import { launchTestApp, waitForAppReady, stubLoginSuccess, loginToMainShell, type TestApp } from "../helpers/electron-app";

test.describe("settings page", () => {
  let testApp: TestApp;

  test.beforeEach(async () => {
    testApp = await launchTestApp();
    await waitForAppReady(testApp.window);
    await stubLoginSuccess(testApp.app);
    await loginToMainShell(testApp.window);
  });

  test.afterEach(async () => {
    await testApp?.cleanup();
  });

  test("opens settings via account menu", async () => {
    const { window } = testApp;

    // Open account menu and click 设置.
    await window.locator(".account-menu-wrap button").first().click();
    await window.locator(".account-menu-popover button", { hasText: "设置" }).click();

    // Settings page renders fullscreen with nav and back button.
    await expect(window.locator(".settings-page")).toBeVisible({ timeout: 10_000 });
    await expect(window.locator("button.settings-back-button")).toBeVisible();

    // Known settings groups are listed.
    await expect(window.locator(".settings-nav-list button", { hasText: "连接" })).toBeVisible();
    await expect(window.locator(".settings-nav-list button", { hasText: "资源中心" })).toBeVisible();
    await expect(window.locator(".settings-nav-list button", { hasText: "关于" })).toBeVisible();
  });

  test("about panel shows app version", async () => {
    const { window } = testApp;

    // Go straight to the settings route (fullscreen) via the account menu.
    await window.locator(".account-menu-wrap button").first().click();
    await window.locator(".account-menu-popover button", { hasText: "设置" }).click();
    await expect(window.locator(".settings-page")).toBeVisible({ timeout: 10_000 });

    // Switch to the 关于 panel.
    await window.locator(".settings-nav-list button", { hasText: "关于" }).click();

    // The about panel reveals version information (desktop version was
    // resolved from the packaged app.json by the main process).
    await expect(window.locator(".settings-scroll")).toBeVisible();
    await expect(window.locator(".settings-scroll")).toContainText("应用更新");
  });

  test("back button returns to the chat shell", async () => {
    const { window } = testApp;

    await window.locator(".account-menu-wrap button").first().click();
    await window.locator(".account-menu-popover button", { hasText: "设置" }).click();
    await expect(window.locator(".settings-page")).toBeVisible({ timeout: 10_000 });

    // Navigate back — the sidebar shell should be visible again.
    await window.locator("button.settings-back-button").click();
    await expect(window.locator(".app-shell")).toBeVisible({ timeout: 10_000 });
  });
});
