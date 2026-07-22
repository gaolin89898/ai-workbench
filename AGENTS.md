# Repo Guidelines

These rules apply for the full session. All AI agents working in this repo must follow them.

## Workflow

- Define success criteria before coding; if unclear, stop and clarify.
- Commit in small focused checkpoints; don't batch unrelated changes.
- After non-trivial work, run the matching verification command (see Verification below).
- Don't create or switch to new branches unless the user explicitly asks.
- Prefer clean reimplementation over patching around local complexity.

## Product

- This repo is building **CodeHub AI** — a local-first multi-AI-agent workbench with four ends: Electron desktop, Flutter mobile, Go relay backend, and a Vue admin panel.
- **Local-first**: AI CLI runs on the desktop; full chat history stays in desktop SQLite; the backend only stores account/device/session metadata and relays WebSocket messages.
- Desktop work is not done until it is verified on the real Electron surface, not only by unit tests.
- Cross-end protocol changes are product features, not polish — a field added in one end must be propagated to all others (see Structure below).
- The current priority provider is Codex; Claude Code, OpenCode, and MiMo are progressively supported.

## Safety

- Never delete user session history, the SQLite database (`~/.ai-workbench/history.db`), cached transcripts, or temp artifacts without explicit approval.
- Treat files you didn't edit as read-only when multiple agents may be working.
- Ask before destructive git commands (`reset --hard`, `push --force`, `rebase -i`) or history rewrites.
- Provider credentials and local CLI auth state live on the desktop device; never read, log, or transmit secrets.

## Structure

### Architecture boundaries

- Keep the desktop **renderer / main / preload** boundary tight; avoid broad Node exposure to the renderer.
- Provider adaptation logic (`codex.ts`, `claude.ts`, `acp.ts`, `mimo.ts`) should stay separate from main-process orchestration (`ipc.ts`, `sync.ts`). Long-term goal: migrate to per-provider driver packages under `packages/`.
- The Go backend never executes AI directly and never reads desktop files; it only relays messages and stores metadata.

### Cross-end protocol sync

When adding or changing a protocol field, update **all** of these in the same change:

| Layer | File |
|-------|------|
| Desktop sender | `apps/desktop/src/main/sync.ts` |
| Desktop handler | `apps/desktop/src/main/ipc.ts` |
| Mobile client | `apps/mobile/lib/services/realtime_client.dart` |
| Backend protocol | `backend/internal/protocol/protocol.go` |
| Backend WebSocket | `backend/internal/ws/` |
| Protocol doc | `docs/protocol.md` |

Keep backward-compatible handling for older clients when removing or renaming fields.

### Key file locations

```
apps/desktop/src/main/
├── index.ts              # Electron main entry; calls applyUtf8ProcessEnv() at startup
├── providers.ts          # Provider detection, install/update, npm registry management
├── codex.ts              # Codex app-server adapter
├── claude.ts             # Claude Agent SDK adapter
├── acp.ts                # OpenCode ACP adapter
├── mimo.ts               # MiMo CLI JSON adapter
├── sync.ts               # Desktop cloud connection and cross-end message handling
├── db.ts                 # Local session and execution record (SQLite)
├── ipc.ts                # IPC handler registration
├── windows-utf8-env.ts   # UTF-8 env setup for child CLI processes (Windows)
├── codex_trace.ts        # Codex execution trace parsing
├── claude_trace.ts       # Claude execution trace parsing
└── pty.ts                # Integrated terminal (node-pty)

backend/
├── cmd/server/           # Go server entry
├── internal/ws/          # WebSocket routes (desktop + mobile)
├── internal/protocol/    # Protocol struct definitions
└── migrations/           # PostgreSQL migrations (auto-run on startup)

apps/mobile/lib/services/
└── realtime_client.dart  # Mobile WebSocket client

user-admin-system/        # Vue 3 admin panel (Arco Design)
```

### Environment conventions

- `applyUtf8ProcessEnv()` is called at desktop startup to set UTF-8 env vars (`PYTHONUTF8`, `PYTHONIOENCODING`, `LANG`, `LC_ALL`, `PATHEXT`) on `process.env`. All child CLI processes inherit these automatically — don't set them per-spawn.
- When building a custom env for `spawn()`, spread `process.env` first: `{ ...process.env, MY_VAR: "x" }`.
- npm registry mirrors are managed in `providers.ts` (`NPM_REGISTRY_OPTIONS`); the desktop auto-probes the fastest mirror on startup.

## Verification

Run the command that matches the surface you changed:

| Surface | Command |
|---------|---------|
| Backend | `cd backend && go test ./...` |
| Desktop build | `cd apps/desktop && pnpm build` |
| Desktop typecheck | `cd apps/desktop && npx tsc -p tsconfig.node.json --noEmit` |
| Desktop E2E | `cd apps/desktop && pnpm test:e2e:core` |
| Mobile | `cd apps/mobile && flutter analyze && flutter test` |
| Admin panel | `cd user-admin-system && pnpm build` |

For protocol changes, verify at least the backend test and desktop build together.

## Source Of Truth

- Root `AGENTS.md` is the repo instruction source of truth.
- Sub-directories may place a local `AGENTS.md` to add path-scoped rules without growing this file.
- `docs/protocol.md` is the WebSocket protocol source of truth.
- `docs/pi-gui-improvement-plan.md` tracks improvement items borrowed from pi-gui.
