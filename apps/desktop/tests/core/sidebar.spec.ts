import { test, expect } from "@playwright/test";
import { launchTestApp, waitForAppReady, stubLoginSuccess, loginToMainShell, type TestApp } from "../helpers/electron-app";

test.describe("sidebar", () => {
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

  test("main shell renders with sidebar and session actions", async () => {
    const { window } = testApp;

    // Main shell visible.
    await expect(window.locator(".app-shell")).toBeVisible();

    // Session search button in the sidebar.
    await expect(window.locator('button[title="搜索会话"]')).toBeVisible();

    // Project chooser button.
    await expect(window.locator('button[title="选择本地项目"]')).toBeVisible();

    // Chat view with the composer should be the default route.
    await expect(window.locator('textarea[placeholder="输入你想做的事"]')).toBeVisible();
  });

  test("new chat entry point is visible in the sidebar", async () => {
    const { window } = testApp;

    // The free-session "新建会话" entry exists.
    await expect(window.locator(".sidebar-root, .app-shell")).toBeVisible();
    await expect(window.locator("text=新建会话").first()).toBeVisible();
  });

  test("session search modal opens, searches, and shows empty state", async () => {
    const { window } = testApp;

    await window.locator('button[title="搜索会话"]').click();

    // Modal opens.
    const modal = window.locator(".session-search-modal");
    await expect(modal).toBeVisible();

    // Typing a query on an empty local database yields the empty hint.
    const searchInput = modal.locator("input[type=search], input[type=text]").first();
    await searchInput.fill("不存在的会话关键词");
    await expect(modal.locator("text=没有找到匹配的会话")).toBeVisible({ timeout: 5_000 });
  });

  test("account menu shows settings entry", async () => {
    const { window } = testApp;

    // Open the account menu from the sidebar footer.
    await window.locator(".account-menu-wrap button").first().click();

    const popover = window.locator(".account-menu-popover");
    await expect(popover).toBeVisible();

    // Settings menu item is present.
    await expect(popover.locator("button", { hasText: "设置" })).toBeVisible();
    // Theme toggle item is present.
    await expect(popover.locator("button", { hasText: "切换" }).first()).toBeVisible();
  });
});
