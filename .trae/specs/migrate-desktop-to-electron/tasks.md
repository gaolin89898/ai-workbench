# Tasks

## 阶段一：清理与骨架

- [x] Task 1: 删除旧 CLI Agent
  - [x] SubTask 1.1: 删除 `crates/desktop-agent/` 整个目录
  - [x] SubTask 1.2: 从根 `Cargo.toml` 的 `[workspace] members` 移除 `crates/desktop-agent`
  - [x] SubTask 1.3: 从 `crates/shared/src/lib.rs` 的 `RealtimeMessage` 枚举中移除仅旧 agent 使用的底层终端变体（`SessionsSnapshot` / `TerminalInput` / `TerminalControl` / `TerminalOutput` / `TerminalError`），保留主协议变体
  - [x] SubTask 1.4: 检查 `crates/server/src/ws/` 是否存在仅服务旧 agent 的转发逻辑，存在则移除
  - [x] SubTask 1.5: 删除 `docs/protocol.md` 中"底层终端兼容协议"小节
  - [x] SubTask 1.6: `cargo build -p remote-term-server` 验证云端服务仍可编译

- [x] Task 2: 删除 Tauri 后端目录
  - [x] SubTask 2.1: 删除 `apps/desktop/src-tauri/` 整个目录
  - [x] SubTask 2.2: 从根 `Cargo.toml` 的 `[workspace] members` 移除 `apps/desktop/src-tauri`

- [x] Task 3: 搭建 Electron 工程骨架
  - [x] SubTask 3.1: 重写 `apps/desktop/package.json`：移除 `@tauri-apps/*` 依赖，新增 `electron`、`electron-builder`、`electron-updater`、`electron-vite`、`node-pty`、`better-sqlite3`、`ws`、`simple-git`、`typescript`、`@types/node`、`@types/ws` 等
  - [x] SubTask 3.2: 新增 `apps/desktop/electron.vite.config.ts`（main / preload / renderer 三入口，renderer 复用现有 Vue 配置）
  - [x] SubTask 3.3: 新增 `apps/desktop/electron-builder.yml`：appId、productName、Linux deb/AppImage 配置、publish 指向 GitHub Releases（owner: gaolin89898, repo: ai-workbench）
  - [x] SubTask 3.4: 新增 `apps/desktop/tsconfig.json` 及 `tsconfig.node.json`（main/preload 子配置）
  - [x] SubTask 3.5: 新增 `apps/desktop/src/main/index.ts`：创建 BrowserWindow（1440×900 / 最小 1024×640）+ dev server / dist/index.html 加载 + 注册所有 IPC
  - [x] SubTask 3.6: 新增 `apps/desktop/src/preload/index.ts`：通过 `contextBridge` 暴露 `window.desktop.ipc.*` 与 `window.desktop.on.*` API

## 阶段二：主进程模块实现

- [x] Task 4: 实现 SQLite 模块（`apps/desktop/src/main/db.ts`）
  - [x] SubTask 4.1: 路径解析（`AI_WORKBENCH_DB` 覆盖，默认 `~/.ai-workbench/history.db`，使用 `os.homedir()`）
  - [x] SubTask 4.2: 建表 `local_projects` / `local_ai_sessions`（含 `provider_session_id`、`archived_at` 列）/ `local_ai_messages`，schema 与原 Rust 实现完全一致
  - [x] SubTask 4.3: 暴露 upsert / query / archive / list 等 helper 函数

- [x] Task 5: 实现 PTY 模块（`apps/desktop/src/main/pty.ts`）
  - [x] SubTask 5.1: 使用 `node-pty` spawn shell（默认 `$SHELL` 或 bash），初始 30 行 100 列
  - [x] SubTask 5.2: 维护每会话 handle 表（id → IPty），等价原 `ShellPtySessionHandle`
  - [x] SubTask 5.3: 通过 `webContents.send('shell-terminal-output', ...)` 推送输出，`shell-session-status` 推送退出/状态变更
  - [x] SubTask 5.4: 暴露 create / write / resize / kill / dispose 接口

- [x] Task 6: 实现 Provider 检测（`apps/desktop/src/main/providers.ts`）
  - [x] SubTask 6.1: 复刻 `detect_ai_tool` 逻辑：检测 `codex` / `claude` 命令是否存在（`which` / `where`）、版本输出、登录状态
  - [x] SubTask 6.2: 暴露 detectProviders() 返回 `ProviderStatus[]`

- [x] Task 7: 实现项目/Git 模块（`apps/desktop/src/main/projects.ts`）
  - [x] SubTask 7.1: 文件夹选择对话框（Electron `dialog.showOpenDialog`）
  - [x] SubTask 7.2: 使用 `simple-git` 或 spawn `git` 读取分支、dirty 状态、文件列表
  - [x] SubTask 7.3: 暴露 listProjects / addProject / getGitStatus 接口

- [x] Task 8: 实现 Codex 集成（`apps/desktop/src/main/codex.ts`）
  - [x] SubTask 8.1: spawn `codex app-server --stdio` 子进程，建立 stdin/stdout JSON-RPC 通道
  - [x] SubTask 8.2: 实现客户端：initialize → thread/start（失败回退 thread/resume）→ turn/start
  - [x] SubTask 8.3: 监听并解析 thread/started / turn/started / item/started / item/agentMessage/delta / item/commandExecution/outputDelta / item/completed / turn/completed / error
  - [x] SubTask 8.4: 60s 超时机制
  - [x] SubTask 8.5: 注入 `codex_desktop_developer_instructions` 等价系统指令（中文回复 + 必须实际执行读取命令）

- [x] Task 9: 实现 Claude 集成（`apps/desktop/src/main/claude.ts`）
  - [x] SubTask 9.1: spawn `claude --print --output-format stream-json --verbose --include-partial-messages --permission-mode plan --append-system-prompt ... [--resume|--session-id]`
  - [x] SubTask 9.2: 按行解析 stream-json
  - [x] SubTask 9.3: 120s 超时机制
  - [x] SubTask 9.4: `--resume` 失败回退到新 session
  - [x] SubTask 9.5: 注入 `claude_desktop_prompt` 等价系统指令

- [x] Task 10: 实现 WebSocket 同步（`apps/desktop/src/main/sync.ts`）
  - [x] SubTask 10.1: `ws` 连接 `${serverUrl}/ws/desktop?token=<desktopAccessToken>`
  - [x] SubTask 10.2: 复刻 `DesktopCloudSync` 含 generation 计数器（每次重连递增，回调中比较 generation 后丢弃过期事件）
  - [x] SubTask 10.3: 10s 周期推送 providers/projects/ai-sessions 快照
  - [x] SubTask 10.4: 处理来自移动端的 `ai.session.create` / `ai.message.send` / `ai.history.request` / `ai.session.archive`
  - [x] SubTask 10.5: `desktop.heartbeat` 心跳上报

- [x] Task 11: 实现风险命令评估（`apps/desktop/src/main/risk.ts`）
  - [x] SubTask 11.1: 用 TypeScript 复刻 `assess_command_risk` 15 条规则
  - [x] SubTask 11.2: 暴露 assessCommandRisk(input) 返回 `{ risky, reason, code }`

- [x] Task 12: 实现自动更新（`apps/desktop/src/main/updater.ts`）
  - [x] SubTask 12.1: 集成 `electron-updater`，配置 autoDownload=false
  - [x] SubTask 12.2: 暴露 checkForUpdates / downloadUpdate / installUpdate IPC
  - [x] SubTask 12.3: 通过 `webContents.send` 推送 update-available / download-progress / update-downloaded 事件

- [x] Task 13: 注册所有 IPC handler（`apps/desktop/src/main/index.ts`）
  - [x] SubTask 13.1: 列出原 Tauri command 清单（参考原 `lib.rs` 中所有 `#[tauri::command]`）
  - [x] SubTask 13.2: 逐一对应用 `ipcMain.handle('<channel>', ...)` 注册
  - [x] SubTask 13.3: 确保返回值结构（含 `ChatSegment` 联合类型）与原 Rust 实现一致

## 阶段三：前端改造

- [x] Task 14: 重写 `apps/desktop/src/services/tauri.ts` 为 `apps/desktop/src/services/desktop.ts`
  - [x] SubTask 14.1: 所有 `invoke('xxx', args)` 替换为 `window.desktop.ipc.xxx(args)`
  - [x] SubTask 14.2: `listen('xxx', cb)` 替换为 `window.desktop.on.xxx(cb)`（基于 `ipcRenderer.on`），返回 unlisten 函数
  - [x] SubTask 14.3: `ChatSegment` 联合类型与所有类型导出保持不变
  - [x] SubTask 14.4: 删除原 `tauri.ts` 文件

- [x] Task 15: 改造 `apps/desktop/src/composables/useWorkspace.ts`
  - [x] SubTask 15.1: import 路径从 `../services/tauri` 改为 `../services/desktop`
  - [x] SubTask 15.2: 验证所有调用签名不变（仅入口切换）

- [x] Task 16: 改造所有 Vue 组件 import
  - [x] SubTask 16.1: 全局将 `from "../services/tauri"` 改为 `from "../services/desktop"`
  - [x] SubTask 16.2: 不修改组件业务逻辑

- [x] Task 17: xterm.js 适配
  - [x] SubTask 17.1: 确认 `TerminalView.vue` 事件订阅改为 `window.desktop.on.shellTerminalOutput(...)`
  - [x] SubTask 17.2: 主题色 `#202424`、30 行 100 列初始 PTY 保持不变

## 阶段四：CI 与文档

- [x] Task 18: 重写 `.github/workflows/release-desktop.yml`
  - [x] SubTask 18.1: 触发条件保持 `v*` tag
  - [x] SubTask 18.2: 步骤改为 Node 22 + pnpm 10 + `pnpm install --frozen-lockfile` + `pnpm build` + `electron-builder --publish always`
  - [x] SubTask 18.3: 移除 Rust 工具链与 Tauri Linux 依赖安装
  - [x] SubTask 18.4: 配置 Secrets：`GH_TOKEN`（自动从 `GITHUB_TOKEN` 来），如需 Linux 代码签名则补充证书 secrets

- [x] Task 19: 更新 `README.md`
  - [x] SubTask 19.1: 启动桌面端命令改为 `pnpm dev`（electron-vite dev）
  - [x] SubTask 19.2: 依赖说明移除 Rust 桌面端依赖，加入 Node 22 / pnpm 10 / Electron
  - [x] SubTask 19.3: 删除旧 CLI Agent 启动章节
  - [x] SubTask 19.4: 工作区结构图更新（移除 `crates/desktop-agent`、`apps/desktop/src-tauri`，新增 `apps/desktop/src/main`、`apps/desktop/src/preload`）

- [x] Task 20: 更新 `docs/protocol.md`
  - [x] SubTask 20.1: 删除"底层终端兼容协议"整节
  - [x] SubTask 20.2: 顶部说明改为只描述主协议

- [x] Task 21: 重写 `docs/desktop-auto-update.md`
  - [x] SubTask 21.1: Tauri updater → electron-updater
  - [x] SubTask 21.2: 私钥/签名说明改为 electron-builder 代码签名证书
  - [x] SubTask 21.3: 发版流程更新（`pnpm build` + `electron-builder` + tag push）
  - [x] SubTask 21.4: `latest.json` → `latest.yml` 说明

- [x] Task 22: 验证与回归
  - [x] SubTask 22.1: 本地 `pnpm dev` 启动桌面端，验证窗口、菜单、路由
  - [x] SubTask 22.2: 验证 PTY 终端创建/输出/退出
  - [x] SubTask 22.3: 验证 Codex 与 Claude 各跑一次会话
  - [x] SubTask 22.4: 验证移动端配对、AI 会话创建、消息收发、历史拉取
  - [x] SubTask 22.5: 验证 Provider 检测、项目添加、Git 状态
  - [x] SubTask 22.6: 验证应用更新检查（不实际发布，仅触发 `checkForUpdates`）
  - [x] SubTask 22.7: `cargo build` 验证 Rust workspace 仅剩 `shared` + `server` 且编译通过

# Task Dependencies

- Task 1 与 Task 2 可并行（均属清理）
- Task 3 是 Task 4-12 的前置（主进程骨架先行）
- Task 4-12 在 Task 3 完成后可并行实现
- Task 13 依赖 Task 4-12 全部完成
- Task 14-17 依赖 Task 13 完成（前端调用 IPC 接口）
- Task 18-21 依赖 Task 14-17 完成（CI/文档需与最终实现一致）
- Task 22 依赖 Task 18-21 完成
