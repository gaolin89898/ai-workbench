# Project Structure

## Root Layout

```
ai-workbench/
├── apps/
│   ├── desktop/          # Electron + Vue 3 desktop application
│   └── mobile/           # Flutter mobile application
├── backend/              # Go cloud relay server
├── docs/                 # Documentation
├── scripts/              # Build/deploy scripts
├── releases/             # Release artifacts
├── assets/               # Shared assets
├── .github/workflows/    # CI/CD pipelines
├── .planning/            # Project planning docs
├── docker-compose.yml    # Local PostgreSQL setup
├── docker-compose.prod.yml  # Production compose
├── Dockerfile            # Backend container image
├── README.md             # Project overview (Chinese)
├── gap-analysis.md       # Gap analysis document
├── icon.pen              # Icon design file
├── pencil-new.pen        # UI design file
└── *.pen                 # Other design files
```

---

## Backend (`backend/`)

```
backend/
├── cmd/
│   └── server/
│       └── main.go              # Entry point: config → db → migrations → AppState → serve
├── internal/
│   ├── auth/
│   │   └── auth.go              # JWT middleware, token parsing, password hashing
│   ├── config/
│   │   └── config.go            # Environment variable loading (DATABASE_URL, JWT_SECRET, etc.)
│   ├── db/
│   │   └── db.go                # pgxpool wrapper, migrations, ownership guards, row scanners, upserts
│   ├── models/
│   │   └── models.go            # All data structs (User, DesktopDevice, AiSession, etc.)
│   ├── protocol/
│   │   ├── protocol.go          # Wire protocol types, ParseMessage/MarshalMessage dispatcher
│   │   └── protocol_test.go     # Protocol tests
│   ├── risk/
│   │   ├── risk.go              # Command risk assessment rules
│   │   └── risk_test.go         # Risk rule tests
│   ├── routes/
│   │   ├── router.go            # HTTP mux setup, CORS middleware, public + authed route mounting
│   │   ├── auth.go              # Register/login handlers
│   │   ├── devices.go           # Device listing and detail
│   │   ├── meta.go              # Providers, sessions, activity logs, settings
│   │   ├── workspace.go         # Projects CRUD
│   │   ├── oauth.go             # DingTalk OAuth start/callback/poll
│   │   └── oauth_test.go        # OAuth tests
│   ├── state/
│   │   └── state.go             # AppState: WebSocket connection registry (Mobiles, Desktops maps)
│   └── ws/
│       ├── ws.go                # WebSocket handler base, auth, read loop, dispatch
│       ├── desktop.go           # Desktop message handlers (heartbeat, snapshots, AI events)
│       └── mobile.go            # Mobile message handlers (AI send, history request)
├── migrations/
│   ├── 0001_init.sql            # Users, devices, sessions, pairing codes
│   ├── 0002_activity_settings.sql
│   ├── 0003_ai_workbench.sql    # Providers, projects, AI sessions
│   ├── 0004_archive_ai_sessions.sql
│   ├── 0005_provider_session_id.sql
│   ├── 0006_desktop_pairing_requests.sql
│   ├── 0007_replace_gemini_with_opencode.sql
│   ├── 0008_oauth_login.sql
│   └── 0009_managed_users.sql
├── go.mod
├── go.sum
├── docker-compose.prod.yml
└── Dockerfile.runtime
```

**Key entry points:**
- Server: `cmd/server/main.go`
- Router: `internal/routes/router.go`
- WebSocket: `internal/ws/ws.go`

---

## Desktop (`apps/desktop/`)

```
apps/desktop/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # App entry: creates BrowserWindow, registers IPC, starts cloud sync
│   │   ├── ipc.ts               # All ipcMain.handle registrations (40+ channels)
│   │   ├── db.ts                # SQLite database (better-sqlite3, WAL mode)
│   │   ├── codex.ts             # Codex CLI integration (JSON-RPC 2.0 over stdio)
│   │   ├── codex_sessions.ts    # Native Codex session file parser + importer
│   │   ├── claude.ts            # Claude Code CLI integration (streaming JSON)
│   │   ├── sync.ts              # WebSocket client to cloud relay + cloud config persistence
│   │   ├── providers.ts         # AI CLI detection (codex, claude, opencode)
│   │   ├── projects.ts          # Git operations (branch, status, file manager)
│   │   ├── pty.ts               # PTY shell session management (node-pty)
│   │   ├── risk.ts              # Command risk assessment rules
│   │   ├── updater.ts           # Auto-update via electron-updater
│   │   └── providers.ts         # CLI version/auth detection
│   ├── preload/
│   │   └── index.ts             # contextBridge: window.desktop = { invoke, on }
│   ├── components/              # Vue 3 single-file components
│   │   ├── AppShell.vue         # Layout shell with sidebar navigation
│   │   ├── ChatView.vue         # AI chat session list and chat interface
│   │   ├── ChatMessageRow.vue   # Individual chat message rendering
│   │   ├── ChatSegment.vue      # Structured segment rendering (text/status/thought/tool/approval)
│   │   ├── SessionWindow.vue    # Standalone session window (opens in new BrowserWindow)
│   │   ├── WorkspaceView.vue    # Workspace overview (projects, providers, sessions)
│   │   ├── ProjectsView.vue     # Project management (add/remove/rename)
│   │   ├── ProvidersView.vue    # AI provider status display
│   │   ├── PairingView.vue      # Device pairing (code entry + QR display)
│   │   ├── SettingsView.vue     # App settings and auto-update
│   │   ├── TerminalView.vue     # xterm.js terminal for PTY sessions
│   │   └── SidebarProjectTree.vue  # Project tree in sidebar
│   ├── composables/
│   │   └── useWorkspace.ts      # Central state management composable (1697 lines)
│   ├── services/
│   │   └── desktop.ts           # Typed IPC API wrapper + all TypeScript types
│   ├── utils/
│   │   ├── chat.ts              # Chat message encoding/decoding utilities
│   │   └── chat.js              # JS utilities for chat processing
│   ├── assets/                  # Static assets (icons, images)
│   ├── App.vue                  # Root Vue component
│   ├── main.ts                  # Vue app initialization (createApp, router, mount)
│   ├── router.ts                # Vue Router config (hash history, 5 routes + session window)
│   ├── style.css                # Global styles
│   └── env.d.ts                 # TypeScript environment declarations
├── electron.vite.config.ts      # electron-vite config (main, preload, renderer builds)
├── electron-builder.yml         # electron-builder packaging config
├── index.html                   # Vite entry HTML
├── package.json                 # Dependencies and scripts
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
└── tsconfig.node.json
```

**Key entry points:**
- Vue app: `src/main.ts` → `src/App.vue`
- Main process: `src/main/index.ts`
- IPC registry: `src/main/ipc.ts`
- API types: `src/services/desktop.ts`

---

## Mobile (`apps/mobile/`)

```
apps/mobile/
├── lib/
│   └── main.dart                # Flutter app entry point
├── web/                         # Flutter web build
├── ios/                         # iOS platform code
├── macos/                       # macOS platform code
├── android/                     # Android platform code (if present)
├── pubspec.yaml                 # Flutter dependencies
├── pubspec.lock
└── analysis_options.yaml        # Dart linting rules
```

**Key dependencies:** `http`, `web_socket_channel`, `shared_preferences`, `mobile_scanner`, `url_launcher`

---

## Documentation (`docs/`)

```
docs/
├── protocol.md                  # WebSocket protocol specification (all message types)
├── desktop-auto-update.md       # Auto-update setup and release flow
├── mobile-release-signing.md    # Mobile app signing and release
└── server-ops.md                # Server operations guide
```

---

## CI/CD (`.github/workflows/`)

```
.github/workflows/
├── release-desktop.yml          # Build Electron packages on v* tag, upload to GitHub Releases
└── release-server.yml           # Build Go server Docker image on v* tag
```

---

## Design Files (Root)

```
icon.pen                        # Icon design (Pencil format)
pencil-new.pen                  # Full UI design (desktop + mobile pages)
```

---

## Key File Sizes (for orientation)

| File | Lines | Role |
|------|-------|------|
| `desktop/src/composables/useWorkspace.ts` | ~1697 | Central state store (largest file) |
| `desktop/src/main/codex.ts` | ~1058 | Codex CLI integration |
| `desktop/src/main/sync.ts` | ~955 | Cloud WebSocket client |
| `desktop/src/main/ipc.ts` | ~447 | IPC handler registry |
| `desktop/src/main/db.ts` | ~438 | SQLite database |
| `backend/internal/protocol/protocol.go` | ~382 | Wire protocol types |
| `backend/internal/db/db.go` | ~338 | Database queries |
| `backend/internal/state/state.go` | ~308 | WebSocket connection registry |
| `backend/internal/models/models.go` | ~172 | Data model structs |
| `backend/internal/routes/router.go` | ~152 | HTTP route definitions |
| `desktop/src/services/desktop.ts` | ~446 | TypeScript API types |
| `desktop/src/main/claude.ts` | ~498 | Claude CLI integration |
| `desktop/src/main/codex_sessions.ts` | ~617 | Codex session importer |
