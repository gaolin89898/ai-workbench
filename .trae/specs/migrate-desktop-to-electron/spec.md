# 桌面端迁移至 Electron 并清理旧 CLI Agent Spec

## Why
当前桌面端基于 Tauri 2.0 + Rust，构建/调试链路相对小众，且与 Node.js 生态集成度低。迁移到 Electron 可统一前后端到 JavaScript/TypeScript 生态，降低维护成本；同时旧 CLI Agent（`crates/desktop-agent`）已被桌面端原生 PTY 路径完全替代，不再有用户使用，应彻底删除以减少代码包袱。

## What Changes
- **BREAKING** 移除 `apps/desktop/src-tauri/` 整个 Rust 后端目录
- **BREAKING** 新增 `apps/desktop/src/main/`（Electron 主进程，TypeScript）+ `apps/desktop/src/preload/`（预加载脚本）
- **BREAKING** 替换 `apps/desktop/src-tauri/tauri.conf.json` 为 `apps/desktop/electron-builder.yml` + `apps/desktop/electron.vite.config.ts`
- 重写所有 Tauri command 为 Electron IPC handler（`ipcMain.handle`）
- PTY 后端从 `portable-pty` 迁移到 `node-pty`
- 本地 SQLite 从 `rusqlite` 迁移到 `better-sqlite3`
- WebSocket 客户端（`DesktopCloudSync`）从 tokio-tungstenite 迁移到 `ws`
- Codex app-server JSON-RPC 客户端、Claude Code stream-json 解析器从 Rust 重写为 TypeScript
- 自动更新从 `tauri-plugin-updater` 迁移到 `electron-updater` + `electron-builder`
- 前端 `services/tauri.ts` 重命名为 `services/desktop.ts`，所有 `invoke()` 调用替换为 `window.desktop.ipc.*`，`listen()` 替换为 `window.desktop.on.*`
- **BREAKING** 移除 `crates/desktop-agent/` 整个目录，并从根 `Cargo.toml` 的 `[workspace] members` 中移除
- 重写 `.github/workflows/release-desktop.yml` 为 Electron 构建/签名/发布流程
- 更新 `README.md`：启动说明、依赖说明、目录结构
- 更新 `docs/protocol.md`：删除"底层终端兼容协议"小节
- 重写 `docs/desktop-auto-update.md`：Tauri updater → electron-updater
- 保留：Vue 3 + vue-router + xterm.js + qrcode 等前端依赖
- 保留：所有 Vue 组件（`ChatView.vue` / `TerminalView.vue` 等）业务逻辑不做改动
- 保留：本地 SQLite schema（`local_projects` / `local_ai_sessions` / `local_ai_messages`）完全一致
- 保留：DB 路径 `~/.ai-workbench/history.db`（可由 `AI_WORKBENCH_DB` 覆盖）
- 保留：所有原 Tauri event 名（`shell-terminal-output` / `shell-session-status` / `ai-chat-output` / `workspace-changed` / `ai-history-changed`）作为 Electron `webContents.send` 同名事件
- 保留：Codex/Claude 系统指令注入逻辑（中文回复 + 必须实际执行读取命令）
- 保留：`crates/shared` 与 `crates/server` 不变（云端中转服务仍是 Rust）
- 保留：`docs/mobile-release-signing.md` 不变

## Impact
- Affected specs: 桌面端整体架构、CLI Agent、桌面端自动更新
- Affected code:
  - 删除：`apps/desktop/src-tauri/`（约 3390 行 Rust）、`crates/desktop-agent/`（整个 crate）、`apps/desktop/src/services/tauri.ts`
  - 修改：根 `Cargo.toml`（移除 src-tauri 和 desktop-agent 两个 members）
  - 修改：`apps/desktop/package.json`（依赖从 Tauri 切换到 Electron 生态）
  - 修改：`crates/shared/src/lib.rs`（`RealtimeMessage` 移除仅旧 agent 使用的底层终端变体）
  - 新增：`apps/desktop/src/main/index.ts`、`pty.ts`、`db.ts`、`sync.ts`、`codex.ts`、`claude.ts`、`providers.ts`、`projects.ts`、`updater.ts`、`risk.ts`
  - 新增：`apps/desktop/src/preload/index.ts`
  - 新增：`apps/desktop/electron-builder.yml`、`apps/desktop/electron.vite.config.ts`、`apps/desktop/tsconfig.json`
  - 修改：`apps/desktop/src/services/tauri.ts` → `apps/desktop/src/services/desktop.ts`
  - 修改：`apps/desktop/src/composables/useWorkspace.ts`（仅 import 路径变更）
  - 修改：所有 Vue 组件 import 路径（仅路径变更，业务逻辑不变）
  - 重写：`.github/workflows/release-desktop.yml`
  - 重写：`README.md` 相关章节
  - 修改：`docs/protocol.md`、`docs/desktop-auto-update.md`
- 受影响 CI：`release-desktop.yml` 完全重写（不再需要 Rust 工具链）
- 受影响发布：桌面端安装包格式从 Tauri 产物（deb/AppImage，含签名 `latest.json`）切换为 electron-builder 产物（deb/AppImage + `latest.yml`）

## ADDED Requirements

### Requirement: Electron 主进程架构
系统 SHALL 提供 Electron 主进程（TypeScript 实现），承担原 Tauri Rust 后端的所有职责：PTY 管理、本地 SQLite、云端 WebSocket 同步、Codex/Claude CLI 集成、自动更新、Provider 检测、项目/Git 状态读取。

#### Scenario: 主进程启动
- **WHEN** 用户启动桌面应用
- **THEN** Electron 主进程加载 `apps/desktop/src/main/index.ts`，初始化 SQLite、注册所有 IPC handler、创建 BrowserWindow 加载 Vue 前端

#### Scenario: IPC 调用
- **WHEN** 前端通过 `window.desktop.ipc.<channel>(...)` 调用
- **THEN** 主进程对应 `ipcMain.handle('<channel>', ...)` 返回 Promise 结果，签名与原 Tauri command 保持一致

### Requirement: 本地 PTY 集成
系统 SHALL 使用 `node-pty` 创建每会话 PTY，通过 `shell-terminal-output` / `shell-session-status` 事件推送到前端。

#### Scenario: 创建终端会话
- **WHEN** 前端调用创建 shell 会话
- **THEN** 主进程通过 `node-pty` spawn 进程，初始 30 行 100 列，输出通过 `webContents.send('shell-terminal-output', ...)` 推送

### Requirement: 本地 SQLite 持久化
系统 SHALL 使用 `better-sqlite3` 维护 `local_projects` / `local_ai_sessions` / `local_ai_messages` 三张表，DB 路径默认 `~/.ai-workbench/history.db`，可由 `AI_WORKBENCH_DB` 环境变量覆盖。

#### Scenario: 路径解析
- **WHEN** 主进程启动且 `AI_WORKBENCH_DB` 未设置
- **THEN** SQLite 文件路径为 `~/.ai-workbench/history.db`；否则使用环境变量值

### Requirement: 云端 WebSocket 同步
系统 SHALL 通过 `ws` 库连接 `/ws/desktop?token=<desktopAccessToken>`，维护 `DesktopCloudSync` 等价逻辑（含 generation 计数器防止旧连接事件污染），每 10s 推送 providers/projects/ai-sessions 快照。

#### Scenario: 旧连接事件隔离
- **WHEN** WS 连接断线重连
- **THEN** 新连接递增 generation 计数器，旧连接回调中比较 generation 后丢弃过期事件

### Requirement: Codex app-server 集成
系统 SHALL spawn `codex app-server --stdio` 子进程并通过 JSON-RPC 通信，完整复刻原 Rust 实现的 initialize → thread/start（失败回退 thread/resume）→ turn/start 流程，处理 thread/started / turn/started / item/started / item/agentMessage/delta / item/commandExecution/outputDelta / item/completed / turn/completed / error 事件，60s 超时。

### Requirement: Claude Code 集成
系统 SHALL spawn `claude --print --output-format stream-json --verbose --include-partial-messages --permission-mode plan --append-system-prompt ... [--resume|--session-id]`，120s 超时，支持 `--resume` 失败回退到新 session。

### Requirement: 风险命令评估
系统 SHALL 在 TypeScript 中复刻 `crates/shared/src/lib.rs` 的 `assess_command_risk` 15 条规则（`rm -rf` / `sudo rm` / `mkfs` / `shutdown` / `.ssh` / `api_key` 等），命中后返回 `RISK_CONFIRMATION_REQUIRED`。

### Requirement: Electron 自动更新
系统 SHALL 使用 `electron-updater` 从 GitHub Releases 拉取更新，签名通过 electron-builder 配置。

#### Scenario: 检查更新
- **WHEN** 用户在"设置 -> 应用更新"点击检查更新
- **THEN** `electron-updater` 拉取 `latest.yml`，校验签名后下载并提示重启安装

## REMOVED Requirements

### Requirement: 旧 CLI Agent
**Reason**: `crates/desktop-agent` 的 tmux/screen 兼容路径已被桌面端原生 PTY 完全替代，不再有用户使用。
**Migration**:
- 删除 `crates/desktop-agent/` 整个目录
- 从根 `Cargo.toml` 的 `[workspace] members` 移除 `crates/desktop-agent`
- `docs/protocol.md` 删除"底层终端兼容协议"小节（`sessions.snapshot` / `terminal.input` / `terminal.control` / `terminal.output` / `terminal.error`）
- `crates/shared/src/lib.rs` 的 `RealtimeMessage` 枚举中移除仅旧 agent 使用的底层终端变体
- `README.md` 中删除旧 agent 启动说明

### Requirement: Tauri 后端
**Reason**: 整体迁移到 Electron，所有 Rust 后端代码不再需要。
**Migration**:
- 删除 `apps/desktop/src-tauri/` 整个目录
- 从根 `Cargo.toml` 的 `[workspace] members` 移除 `apps/desktop/src-tauri`
- 所有原 Tauri command 在 Electron 主进程以 TypeScript 重新实现
- `tauri.conf.json` 配置（窗口 1440×900 / 最小 1024×640）迁移到 `electron-builder.yml` + 主进程 BrowserWindow 选项
- Tauri updater 公钥/endpoint 配置替换为 electron-updater + 代码签名证书
