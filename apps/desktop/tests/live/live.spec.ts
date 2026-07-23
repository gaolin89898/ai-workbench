import { test } from "@playwright/test";

// Live lane tests require a running backend server and valid provider auth.
// They are skipped by default — set AI_WORKBENCH_LIVE_AUTH=1 to opt in.
//
// Prerequisites:
//   1. Start the Go backend: cd backend && go run ./cmd/server
//   2. Have at least one provider installed and authenticated (codex / claude / opencode / mimo)
//   3. Set AI_WORKBENCH_LIVE_AUTH=1 before running: pnpm test:e2e:live

test.describe("live — real runtime/provider", () => {
  test.skip(!process.env.AI_WORKBENCH_LIVE_AUTH, "Set AI_WORKBENCH_LIVE_AUTH=1 to run live tests");

  test("placeholder — replace with real live specs", async () => {
    // Add real live specs here:
    // - Create a session and send a prompt through a real provider
    // - Verify transcript items, tool calls, and approval flows
    // - Verify session resume after restart
  });
});
