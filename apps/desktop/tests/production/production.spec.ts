import { test } from "@playwright/test";

// Production lane tests run against a packaged installer (.exe / .AppImage).
// They are skipped by default — set AI_WORKBENCH_PRODUCTION=1 to opt in.
//
// Prerequisites:
//   1. Build a packaged app: pnpm package:win  (or package:linux)
//   2. Set AI_WORKBENCH_PRODUCTION=1 before running: pnpm test:e2e:production

test.describe("production — packaged app smoke", () => {
  test.skip(!process.env.AI_WORKBENCH_PRODUCTION, "Set AI_WORKBENCH_PRODUCTION=1 to run production tests");

  test("placeholder — replace with real production specs", async () => {
    // Add real production specs here:
    // - Launch the packaged .exe / .AppImage
    // - Verify the app starts and shows the login page
    // - Verify state persists across relaunch of the installed app
  });
});
