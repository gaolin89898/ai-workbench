# Desktop E2E Tests

CodeHub AI desktop E2E tests, powered by Playwright + Electron. Test lanes are
organized by surface area, borrowed from pi-gui's lane approach.

## Prerequisites

- The desktop app must be built: `pnpm build` in `apps/desktop`
- `@playwright/test` installed as devDependency
- `ELECTRON_RUN_AS_NODE` must NOT be set — if your shell environment sets it
  (common in VS Code integrated terminal, CI runners), the test harness
  automatically removes it. If running Playwright manually outside the harness,
  run `unset ELECTRON_RUN_AS_NODE` first.

The `test:e2e` script builds the app automatically before running tests.

## Test Lanes

Use the smallest lane that matches the changed surface.

### `core` — background-friendly in-window UI

Deterministic Electron UI coverage. This is the default lane. Covers renderer,
login page, form persistence, and settings UI behavior. Does not require a real
backend or provider auth.

```bash
pnpm --filter ai-workbench-desktop run test:e2e
pnpm --filter ai-workbench-desktop run test:e2e:core
```

### `live` — real runtime/provider coverage

Real agent runtime and provider auth coverage. Use this when the change depends
on an actual AI run, transcript item, tool call, or approval flow. Requires a
running backend and valid provider credentials.

```bash
pnpm --filter ai-workbench-desktop run test:e2e:live
```

### `production` — packaged-app smoke

Opt-in higher-fidelity tests that run against a packaged `.exe` / `.AppImage`.
Use these for release readiness checks: app launches, can navigate, persists
state across relaunch.

```bash
pnpm --filter ai-workbench-desktop run test:e2e:production
```

### Run all lanes

```bash
pnpm --filter ai-workbench-desktop run test:e2e:all
```

## Conventions

- **Shared helpers** live in `tests/helpers/electron-app.ts`. Extend them instead
  of adding another Electron harness.
- **Prefer real interactions** — clicks, typing, keyboard shortcuts, and visible
  assertions. Avoid direct IPC shortcuts unless the user surface does not exist
  yet. If you must use one, document why the surface gap exists.
- **Isolation** — each test gets a fresh temp user-data directory and SQLite
  database via `launchTestApp()`. Tests never touch the user's real data.
- **Cleanup** — always call `testApp.cleanup()` in `afterEach` to close the
  Electron process and remove the temp directory.
- **Lane placement** — `tests/core/` for deterministic UI, `tests/live/` for
  real runtime, `tests/production/` for packaged smoke. Don't mix lanes.

## Lane Map

- `tests/core/` — deterministic in-window behavior (login, forms, persistence)
- `tests/live/` — real agent/runtime behavior (requires auth + backend)
- `tests/production/` — packaged app smoke tests (requires built installer)

## Adding a New Test

1. Pick the right lane directory (`core/`, `live/`, or `production/`).
2. Import the shared harness:
   ```typescript
   import { launchTestApp, waitForAppReady, type TestApp } from "../helpers/electron-app";
   ```
3. Use `test.beforeEach` to launch and `test.afterEach` to clean up.
4. Write assertions against visible DOM elements, not internal state.
