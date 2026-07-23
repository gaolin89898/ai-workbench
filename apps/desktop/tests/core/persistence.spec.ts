import { test, expect } from "@playwright/test";
import { launchTestApp, waitForAppReady, stubLoginFailure, type TestApp } from "../helpers/electron-app";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test.describe("login form persistence", () => {
  let testApp: TestApp;

  test.beforeEach(async () => {
    testApp = await launchTestApp();
    await waitForAppReady(testApp.window);
  });

  test.afterEach(async () => {
    await testApp?.cleanup();
  });

  test("server URL is persisted to localStorage on input", async () => {
    const { window } = testApp;

    const serverInput = window.locator('input[placeholder="请输入服务器地址"]');
    await serverInput.fill("http://192.168.1.100:3000");

    // The watch on serverInput should persist to localStorage.
    const stored = await window.evaluate(() => {
      return window.localStorage.getItem("ai-workbench.serverUrl");
    });
    expect(stored).toBe("http://192.168.1.100:3000");
  });

  test("form submits on Enter key", async () => {
    const { window } = testApp;

    // Stub login IPC so the loading state persists long enough to assert.
    await stubLoginFailure(testApp.app, "连接服务器失败", 500);

    const serverInput = window.locator('input[placeholder="请输入服务器地址"]');
    const emailInput = window.locator('input[autocomplete="username"]');
    const passwordInput = window.locator('input[autocomplete="current-password"]');

    await serverInput.fill("http://127.0.0.1:3000");
    await emailInput.fill("user@test.com");
    await passwordInput.fill("pass123");

    // Pressing Enter in the password field should submit the form.
    await passwordInput.press("Enter");

    // Loading state must appear — hard assertion, not .catch().
    await expect(window.locator("text=登录中...")).toBeVisible({ timeout: 2_000 });

    // After the stub rejects, the error message must appear.
    await expect(window.locator(".desktop-login-error")).toBeVisible({ timeout: 5_000 });
  });

  test("password toggle has correct aria-label", async () => {
    const { window } = testApp;

    const toggle = window.locator(".desktop-login-password-toggle");
    await expect(toggle).toHaveAttribute("aria-label", "显示密码");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "隐藏密码");
  });

  test("server URL survives app relaunch", async () => {
    // This test verifies persistence across a real relaunch, not just
    // localStorage within the same window.
    const { window, app, userDataDir } = testApp;

    // Type a server URL in the first launch.
    const serverInput = window.locator('input[placeholder="请输入服务器地址"]');
    await serverInput.fill("http://10.0.0.5:3000");
    await expect(serverInput).toHaveValue("http://10.0.0.5:3000");

    // Close the app but keep the temp profile dir for relaunch.
    await app.close();

    // Relaunch with the same user-data dir.
    const relaunched = await launchTestApp({ userDataDir });
    await waitForAppReady(relaunched.window);

    // The server URL should be restored from the persisted profile.
    const restoredInput = relaunched.window.locator('input[placeholder="请输入服务器地址"]');
    await expect(restoredInput).toHaveValue("http://10.0.0.5:3000", { timeout: 5_000 });

    // Clean up the relaunched instance (won't delete dir since it was reused).
    await relaunched.cleanup();
    // afterEach's testApp.cleanup() will close (no-op, already closed) and
    // delete the temp dir.
  });
});
