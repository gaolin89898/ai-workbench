import { test, expect } from "@playwright/test";
import { launchTestApp, waitForAppReady, stubLoginSuccess, loginToMainShell, type TestApp } from "../helpers/electron-app";

test.describe("composer", () => {
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

  test("composer textarea accepts input", async () => {
    const { window } = testApp;

    const composer = window.locator('textarea[placeholder="输入你想做的事"]');
    await expect(composer).toBeVisible();

    await composer.fill("帮我看看这个项目");
    await expect(composer).toHaveValue("帮我看看这个项目");
  });

  test("composer tool menu opens", async () => {
    const { window } = testApp;

    // The add-tools button opens the composer tools menu (Codex mode controls).
    const addButton = window.locator("button.codex-composer-add");
    if (await addButton.count()) {
      await addButton.first().click();
      await expect(window.locator(".codex-composer-add-menu")).toBeVisible();
    } else {
      // Non-Codex providers don't show the add menu — nothing to assert.
      test.skip(true, "composer add menu not rendered for the default provider");
    }
  });
});
