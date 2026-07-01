# Architecture

## Overview

AI Workbench follows a **three-tier distributed architecture** with clear separation of concerns:

```
┌──────────────┐     HTTP/WS      ┌──────────────────┐     WS      ┌──────────────┐
│   Desktop    │◄───────────────► │  Cloud Relay      │◄───────────►│   Mobile     │
│  (Electron)  │                  │  (Go Backend)     │             │  (Flutter)   │
│              │                  │                    │             │              │
│  SQLite DB   │                  │  PostgreSQL        │             │  SharedPrefs │
│  Local AI    │                  │  Account/Pairing   │             │  Chat UI     │
│  PTY Shell   │                  │  Message Forward   │             │              │
│  Git         │                  │  Activity Logs     │             │              │
└──────────────┘                  └──────────────────┘             └──────────────┘
```

**Core principle:** The desktop runs everything locally (AI CLIs, full chat history, shell PTY). The cloud is a thin relay for account management, device pairing, and message forwarding. The mobile app is a remote viewer/controller.

---

## Layered Architecture

### Desktop (Electron) — 4 Layers

```
┌─────────────────────────────────────────────────┐
│  Renderer Process (Vue 3 + Vite)                │
│  ┌─────────────┐  ┌──────────┐  ┌────────────┐ │
│  │ Components   │  │ Composables│ │ Services   │ │
│  │ (Vue SFCs)   │  │ (useWorkspace)│ (desktop.ts)│ │
│  └─────────────┘  └──────────┘  └────────────┘ │
├─────────────────────────────────────────────────┤
│  Preload Bridge (contextBridge → window.desktop)│
│  ipcRenderer.invoke / ipcRenderer.on            │
├─────────────────────────────────────────────────┤
│  Main Process (Electron / Node.js)              │
│  ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ ipc.ts    │ │ db.ts    │ │ sync.ts        │  │
│  │ (handlers)│ │ (SQLite) │ │ (WebSocket/WS) │  │
│  ├──────────┤ ├──────────┤ ├────────────────┤  │
│  │ codex.ts  │ │ claude.ts│ │ providers.ts   │  │
│  │ (JSON-RPC)│ │ (stream) │ │ (detection)    │  │
│  ├──────────┤ ├──────────┤ ├────────────────┤  │
│  │ pty.ts    │ │ projects │ │ updater.ts     │  │
│  │ (node-pty)│ │ (simple-git)│ │ (auto-update) │  │
│  ├──────────┤ ├──────────┤ ├────────────────┤  │
│  │ risk.ts   │ │ codex_   │ │                │  │
│  │ (rules)   │ │ sessions │ │                │  │
│  └──────────┘ └──────────┘ └────────────────┘  │
└─────────────────────────────────────────────────┘
```

**Data flow:** Vue components → composables (`useWorkspace`) → `desktopApi` service → preload bridge IPC → main process handlers → local DB / CLI processes / cloud WebSocket.

### Backend (Go) — 4 Layers

```
┌──────────────────────────────────────────┐
│  cmd/server/main.go                      │
│  Bootstrap: config → db → migrations →   │
│  AppState → routes + WS handlers → serve │
├──────────────────────────────────────────┤
│  routes/ (HTTP handlers)                 │
│  router.go, auth.go, devices.go,         │
│  meta.go, workspace.go, oauth.go         │
├──────────────────────────────────────────┤
│  ws/ (WebSocket handlers)                │
│  ws.go, desktop.go, mobile.go            │
├──────────────────────────────────────────┤
│  internal/                               │
│  ├── db/db.go        (pgxpool queries)  │
│  ├── models/models.go (data structs)     │
│  ├── protocol/protocol.go (wire types)   │
│  ├── state/state.go  (connection registry)│
│  ├── auth/auth.go    (JWT middleware)     │
│  ├── config/config.go (env loading)      │
│  └── risk/risk.go    (command risk rules)│
└──────────────────────────────────────────┘
```

**Request flow:** HTTP request → CORS middleware → auth middleware (JWT) → route handler → DB queries → JSON response.

**WebSocket flow:** Upgrade → auth query param → register in AppState → read loop → dispatch message by type → forward to desktop/mobile.

---

## Key Architectural Patterns

### 1. Relay/Forwarding Pattern (Cloud)
The backend is a **stateless relay** for AI messages. It does not process AI content — it authenticates, validates ownership, checks risk, and forwards messages between mobile and desktop via WebSocket. The `forwardToDesktop` method in `ws/ws.go` implements the fan-out: look up desktop connection → send JSON → if offline, log activity.

### 2. Local-First Data (Desktop)
Full chat history, session data, and project metadata live in **local SQLite** (`~/.ai-workbench/history.db`). The cloud stores only metadata (session titles, status, summaries). Mobile clients request history via WebSocket from the desktop when it's online.

### 3. Connection Registry (AppState)
`backend/internal/state/state.go` maintains in-memory maps:
- `Mobiles: map[userID]map[deviceID]*MobileConnection` — indexed by user then device
- `Desktops: map[deviceID]*DesktopConnection` — indexed by device ID
- Each connection has a buffered `Outbound` channel (256 messages) with a dedicated write goroutine

### 4. Provider Abstraction
AI tools are abstracted as `AiProvider` objects with `id`, `name`, `command`. Each has a detection module (`providers.ts`) and an execution module (`codex.ts`, `claude.ts`). The system can detect which CLIs are installed and route AI sessions to the appropriate handler.

### 5. Structured Chat Segments
AI output is not plain text — it's parsed into **typed segments**: `text`, `status`, `thought`, `tool`, `approval`, `error`. Each segment carries metadata (duration, additions/deletions, tool name, approval state). This enables rich rendering in both desktop and mobile chat views.

### 6. IPC Bridge Pattern (Desktop)
The renderer process cannot access Node.js APIs directly. A preload script (`src/preload/index.ts`) exposes `window.desktop.invoke()` and `window.desktop.on()` via `contextBridge`. All main-process capabilities are accessed through typed IPC channels defined in `services/desktop.ts`.

---

## Component Relationships

### Desktop Internal
```
Vue Components
  └── useWorkspace (composable — central state store)
        └── desktopApi (service — typed IPC wrapper)
              └── preload/index.ts (bridge)
                    └── main/ipc.ts (handlers)
                          ├── db.ts (SQLite CRUD)
                          ├── codex.ts (Codex CLI)
                          ├── claude.ts (Claude CLI)
                          ├── providers.ts (CLI detection)
                          ├── projects.ts (git operations)
                          ├── pty.ts (shell PTY)
                          ├── risk.ts (risk rules)
                          ├── sync.ts (cloud WebSocket)
                          ├── updater.ts (auto-update)
                          └── codex_sessions.ts (session import)
```

### Backend Internal
```
cmd/server/main.go
  ├── config.Load()
  ├── db.New() + RunMigrations()
  ├── state.NewAppState(db)
  ├── routes.NewHandler(db, state, secret)
  │     ├── public routes (register, login, pairing)
  │     ├── authed routes (devices, projects, AI sessions)
  │     └── oauth routes (DingTalk)
  ├── ws.NewHandler(db, state, secret)
  │     ├── HandleMobileWS
  │     └── HandleDesktopWS
  └── http.Server.ListenAndServe()
```

### Cloud Communication Flow
```
Mobile                    Desktop
  │                         │
  │──── HTTP POST ─────────►│ Cloud REST API
  │     (create AI session) │
  │                         │
  │                         │◄── WS forward: ai.session.create
  │                         │    (desktop spawns CLI)
  │◄── WS push ────────────│
  │    ai.message.delta     │
  │    (streaming output)   │
  │                         │
  │──── WS send ───────────►│
  │    ai.message.send      │
  │    (user prompt)        │
```

---

## Data Storage Strategy

| Data Type | Storage | Location | Rationale |
|-----------|---------|----------|-----------|
| User accounts, devices, sessions (metadata) | PostgreSQL | Cloud server | Multi-device sync |
| Full AI chat history | SQLite | `~/.ai-workbench/history.db` | Privacy — stays on user's machine |
| Cloud config (server URL, tokens) | JSON file | Electron `userData` dir | Desktop-only config |
| User preferences (mobile) | SharedPreferences | Device storage | Mobile-only |
| Pairing codes | PostgreSQL | Cloud server | Temporary, server-managed |
| Activity logs | PostgreSQL | Cloud server | Audit trail |

---

## Migration History

Database migrations in `backend/migrations/` show the evolution:
1. `0001_init.sql` — Core tables (users, devices, sessions)
2. `0002_activity_settings.sql` — Activity logs and user settings
3. `0003_ai_workbench.sql` — AI workbench tables (providers, projects, AI sessions)
4. `0004_archive_ai_sessions.sql` — Session archival support
5. `0005_provider_session_id.sql` — Provider session ID tracking
6. `0006_desktop_pairing_requests.sql` — Desktop pairing request flow
7. `0007_replace_gemini_with_opencode.sql` — Provider change (Gemini → OpenCode)
8. `0008_oauth_login.sql` — DingTalk OAuth support
9. `0009_managed_users.sql` — Admin user management
