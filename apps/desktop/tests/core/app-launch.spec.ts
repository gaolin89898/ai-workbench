import { test, expect } from "@playwright/test";
import { launchTestApp, waitForAppReady, type TestApp } from "../helpers/electron-app";

test.describe("app launch", () => {
  let testApp: TestApp;

  test.afterEach(async () => {
    await testApp?.cleanup();
  });

  test("shows boot loading screen then settles", async () => {
    testApp = await launchTestApp();
    const { window } = testApp;

    // The app should open a window.
    expect(window).toBeDefined();

    // Wait for the boot screen to clear and the app to settle.
    await waitForAppReady(window);
  });

  test("window has the expected title", async () => {
    testApp = await launchTestApp();
    const { window } = testApp;

    const title = await window.title();
    expect(title).toContain("CodeHub AI");
  });

  test("app process is running", async () => {
    testApp = await launchTestApp();
    const { app } = testApp;

    // The Electron process should still be running after launch.
    expect(app.process().pid).toBeDefined();
  });
});
