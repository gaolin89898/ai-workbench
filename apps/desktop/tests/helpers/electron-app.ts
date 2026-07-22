import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Shared Electron test harness for CodeHub AI desktop E2E tests.
 *
 * Each test gets a fresh app instance with an isolated temp user-data directory
 * and a temp SQLite database, so tests never pollute the user's real data.
 *
 * Prerequisite: the app must be built (`pnpm build`) so that `out/main/index.js`
 * exists. The `test:e2e` script handles this automatically.
 */

export type TestApp = {
  app: ElectronApplication;
  window: Page;
  cleanup: () => Promise<void>;
};

/**
 * Launches the desktop app in an isolated test environment.
 *
 * @param options.env — extra env vars to pass to the Electron process
 */
export async function launchTestApp(options?: { env?: Record<string, string> }): Promise<TestApp> {
  const cwd = path.resolve(__dirname, "..", "..");
  const mainEntry = path.join(cwd, "out", "main", "index.js");

  if (!fs.existsSync(mainEntry)) {
    throw new Error(
      `Desktop app is not built. Expected "${mainEntry}".\n` +
        'Run "pnpm build" in apps/desktop before running E2E tests.',
    );
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-workbench-e2e-"));
  const dbPath = path.join(userDataDir, "test-history.db");

  // Build the env for the Electron process. We must remove ELECTRON_RUN_AS_NODE
  // because some shell environments (e.g. VS Code integrated terminal, CI runners)
  // set it, which forces Electron into plain Node.js mode and breaks
  // require("electron") — the app crashes with "Cannot read properties of
  // undefined (reading 'getPath')".
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    // First arg is the app directory — Electron reads package.json → main field.
    // --user-data-dir isolates the Electron profile (cookies, cache, etc.).
    args: [cwd, "--user-data-dir=" + userDataDir],
    cwd,
    env: {
      ...childEnv,
      // Signal to the app that it's running in test mode.
      AI_WORKBENCH_TEST_MODE: "background",
      // Isolate the SQLite database to the temp user-data dir.
      AI_WORKBENCH_DB: dbPath,
      ...options?.env,
    },
    timeout: 30_000,
  });

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  return {
    app,
    window,
    cleanup: async () => {
      try {
        await app.close();
      } catch {
        // ignore close errors
      }
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

/**
 * Waits for the app to finish its initial auth check and settle on either the
 * login page or the main shell. Returns the page for further assertions.
 */
export async function waitForAppReady(window: Page): Promise<void> {
  // The boot loading screen shows "正在启动 CodeHub AI..." — wait for it to
  // disappear (v-if="checkingAuth" becomes false).
  await window.waitForSelector("text=正在启动 CodeHub AI", { state: "detached", timeout: 15_000 });
}
