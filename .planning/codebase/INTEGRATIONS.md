# Integrations

## Overview

AI Workbench integrates local AI CLI tools, a cloud relay server, third-party OAuth, and version control — all orchestrated across desktop, backend, and mobile tiers.

---

## 1. Local AI CLI Integrations

The desktop app spawns and communicates with locally-installed AI CLI tools as child processes.

### Codex CLI
- **Integration type:** Child process via JSON-RPC 2.0 over stdio
- **File:** `apps/desktop/src/main/codex.ts`
- **Protocol:** `codex app-server --stdio` — bidirectional JSON-RPC messages
- **Capabilities:**
  - Session creation, message send, turn management
  - Approval workflow (command/file-change approval with `pending`/`approved`/`denied` states)
  - Structured output parsing (text, status, thought, tool, approval, error segments)
  - Thread resume via `threadId`
- **Session management:** `apps/desktop/src/main/codex_sessions.ts` — imports native Codex session files from `~/.codex/sessions/`, parses session index + history JSONL files

### Claude Code
- **Integration type:** Child process with `--output-format stream-json`
- **File:** `apps/desktop/src/main/claude.ts`
- **Protocol:** Streaming JSON lines on stdout
- **Capabilities:**
  - Streaming delta output, structured step events
  - System prompt injection (Chinese-language instructions for workbench context)
  - Interrupt handling and timeout (120s default)
  - Windows support via `cmd.exe /d /s /c claude.cmd`

### OpenCode
- **Integration type:** Detected via `which opencode` / `opencode --version`
- **File:** `apps/desktop/src/main/providers.ts`
- **Status:** Detection-only in current codebase; no active chat integration yet

### Provider Detection
- **File:** `apps/desktop/src/main/providers.ts`
- **Mechanism:** Synchronous `child_process.spawnSync` calls to detect installed CLIs
- **Checks:** Binary existence (`which`/`where`), version output, auth status files (e.g., `~/.codex/auth.json`, `~/.claude.json`)

---

## 2. Cloud Relay Server (Go Backend)

### HTTP API
- **Base URL:** `http://127.0.0.1:3000` (default)
- **Router:** `backend/internal/routes/router.go` — Go 1.22+ `http.ServeMux` with path parameters
- **Auth:** JWT Bearer tokens via `Authorization` header middleware (`backend/internal/auth/auth.go`)

**Key Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/register` | User registration |
| POST | `/auth/login` | Email/password login |
| POST | `/desktop/login` | Desktop-specific login |
| POST | `/desktop/pair` | Desktop device pairing |
| POST | `/desktop/pairing-requests` | Create pairing request |
| GET | `/desktop/pairing-requests/{code}` | Check pairing status |
| POST | `/desktop/pairing-requests/{code}/approve` | Approve pairing |
| GET | `/devices` | List user's desktop devices |
| GET | `/devices/{deviceId}` | Device detail |
| GET | `/devices/{deviceId}/providers` | Device AI provider status |
| GET | `/devices/{deviceId}/projects` | Device project list |
| POST | `/devices/{deviceId}/projects` | Register/update project |
| GET | `/devices/{deviceId}/ai-sessions` | Device AI session list |
| POST | `/devices/{deviceId}/ai-sessions` | Create AI session (forwards to desktop) |
| GET | `/ai-sessions/{sessionId}` | Single AI session detail |
| PATCH | `/ai-sessions/{sessionId}` | Rename AI session |
| GET | `/providers` | Built-in provider definitions |
| GET | `/activity-logs` | Activity log list |
| GET | `/settings` / `PUT /settings` | User settings |
| GET | `/admin/users` | Admin: managed users |

### WebSocket Transport
- **Desktop endpoint:** `GET /ws/desktop?token=<desktopAccessToken>`
- **Mobile endpoint:** `GET /ws/mobile?token=<accessToken>`
- **Files:** `backend/internal/ws/desktop.go`, `backend/internal/ws/mobile.go`
- **Protocol:** JSON messages with `type` discriminator field (`backend/internal/protocol/protocol.go`)

**Message Types (AI protocol):**

| Type | Direction | Purpose |
|------|-----------|---------|
| `desktop.heartbeat` | Desktop → Server → Mobile | Device online status |
| `providers.snapshot` | Desktop → Server → Mobile | AI tool install status |
| `projects.snapshot` | Desktop → Server → Mobile | Project metadata |
| `ai.sessions.snapshot` | Desktop → Server → Mobile | AI session list |
| `ai.session.create` | Mobile → Server → Desktop | Create AI session |
| `ai.message.send` | Mobile → Server → Desktop | Send prompt to AI |
| `ai.message.delta` | Desktop → Server → Mobile | Streaming AI output |
| `ai.message.done` | Desktop → Server → Mobile | AI output complete |
| `ai.history.request` | Mobile → Server → Desktop | Request chat history |
| `ai.history.response` | Desktop → Server → Mobile | Chat history reply |
| `ai.chat.output` | Desktop → Server → Mobile | Structured chat events |
| `ai.approval.respond` | Mobile → Server → Desktop | Codex approval decision |
| `ai.session.archive` | Desktop → Server → Mobile | Archive/unarchive session |
| `ai.session.rename` | Server → Desktop | Sync session title |
| `project.created` | Server → Desktop | New project registered via mobile |
| `git.status.snapshot` | Desktop → Server → Mobile | Git branch/dirty status |

---

## 3. DingTalk OAuth

- **Files:** `backend/internal/routes/oauth.go`, `apps/desktop/src/services/desktop.ts` (OAuth HTTP helpers)
- **Flow:**
  1. Client calls `GET /oauth/dingtalk/start` → server returns DingTalk auth URL
  2. User scans QR / authorizes in browser
  3. DingTalk redirects to `GET /oauth/dingtalk/callback` with `code`
  4. Server exchanges code for DingTalk user identity, creates/finds local account, issues JWT
  5. Client polls `GET /oauth/dingtalk/poll?state=<state>` until result is ready
- **Config:** `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET`, `DINGTALK_REDIRECT_URL` environment variables
- **Desktop renderer calls OAuth endpoints directly via `fetch()` (not through IPC)**

---

## 4. Local SQLite Database

- **File:** `apps/desktop/src/main/db.ts`
- **Location:** `~/.ai-workbench/history.db` (override via `AI_WORKBENCH_DB` env var)
- **Engine:** `better-sqlite3` with WAL mode
- **Tables:**
  - `local_projects` — registered local project paths with git state
  - `local_ai_sessions` — AI session metadata (provider, title, status, summary, archive state)
  - `local_ai_messages` — full chat history (role, content, timestamp)
- **Purpose:** Complete AI chat history stays on the user's machine; cloud only stores metadata

---

## 5. Git Integration

- **File:** `apps/desktop/src/main/projects.ts`
- **Library:** `simple-git` (Node.js)
- **Operations:**
  - `git.checkIsRepo()` — validate project directory
  - `git.revparse(["--abbrev-ref", "HEAD"])` — current branch
  - `git.status()` — changed files list
- **Exposure:** Branch name, dirty flag, file list synced to cloud via `projects.snapshot` and `git.status.snapshot` WebSocket messages

---

## 6. PTY / Shell Integration

- **File:** `apps/desktop/src/main/pty.ts`
- **Library:** `node-pty` (native binding)
- **Capabilities:**
  - Spawn interactive shell sessions (`bash` / `powershell.exe`)
  - Stream output to renderer via `WebContents.send("shell-terminal-output", ...)`
  - Resize, input forwarding, buffer readback
  - Session lifecycle management (start/stop/status)
- **Use cases:** Debug terminal, shell-based AI interaction, tmux/screen session attachment

---

## 7. Auto-Update (Desktop)

- **File:** `apps/desktop/src/main/updater.ts`
- **Library:** `electron-updater`
- **Source:** GitHub Releases (`gaolin89898/ai-workbench`)
- **Flow:**
  1. User clicks "Check for updates" in Settings
  2. Desktop downloads `latest.yml` from GitHub Releases
  3. Compares versions, offers download if newer
  4. User confirms → download → restart to install
- **Events:** `update-available`, `download-progress`, `update-downloaded`, `error`

---

## 8. Device Pairing

- **Mechanism:** One-time pairing code + QR code
- **Mobile generates** a pairing code via `POST /pairing/codes`
- **Desktop enters code** or scans QR (generated via `qrcode` library in `buildDesktopPairingQrPayload`)
- **Backend approves** and returns `deviceId` + `accessToken`
- **Pairing request polling:** Desktop polls `GET /desktop/pairing-requests/{code}` until approved/expired

---

## 9. CI/CD (GitHub Actions)

| Workflow | Trigger | Output |
|----------|---------|--------|
| `release-desktop.yml` | Push `v*` tag | Builds Electron packages (Linux, Windows), uploads to GitHub Releases |
| `release-server.yml` | Push `v*` tag | Builds Go server Docker image, pushes to registry |
