# Checklist

## 清理（旧 CLI Agent + Tauri 后端）

- [x] `crates/desktop-agent/` 目录已删除
- [x] `apps/desktop/src-tauri/` 目录已删除
- [x] 根 `Cargo.toml` 的 `[workspace] members` 不再包含 `crates/desktop-agent` 和 `apps/desktop/src-tauri`
- [x] `crates/shared/src/lib.rs` 的 `RealtimeMessage` 不再包含仅旧 agent 使用的底层终端变体（`SessionsSnapshot` / `TerminalInput` / `TerminalControl` / `TerminalOutput` / `TerminalError`）
- [x] `crates/server/src/ws/` 已检查并移除仅服务旧 agent 的转发逻辑
- [x] `cargo build -p remote-term-server` 编译通过

## Electron 工程骨架

- [x] `apps/desktop/package.json` 不再依赖任何 `@tauri-apps/*` 包
- [x] `apps/desktop/package.json` 已加入 `electron`、`electron-builder`、`electron-updater`、`electron-vite`、`node-pty`、`better-sqlite3`、`ws`、`simple-git`、`typescript`、`@types/node`、`@types/ws`
- [x] `apps/desktop/electron.vite.config.ts` 配置 main / preload / renderer 三入口
- [x] `apps/desktop/electron-builder.yml` 配置 Linux deb/AppImage + GitHub Releases publish
- [x] `apps/desktop/tsconfig.json` 及 `tsconfig.node.json` 存在
- [x] `apps/desktop/src/main/index.ts` 创建 1440×900 BrowserWindow（最小 1024×640）
- [x] `apps/desktop/src/preload/index.ts` 通过 `contextBridge` 暴露 `window.desktop.ipc.*` 与 `window.desktop.on.*`

## 主进程模块

- [x] `apps/desktop/src/main/db.ts` 实现 SQLite，路径解析与原 Rust 一致
- [x] `apps/desktop/src/main/db.ts` 三张表 schema 与原 Rust 完全一致（含 `provider_session_id`、`archived_at` 列）
- [x] `apps/desktop/src/main/pty.ts` 使用 `node-pty`，初始 30 行 100 列
- [x] `apps/desktop/src/main/pty.ts` 通过 `webContents.send('shell-terminal-output', ...)` 推送
- [x] `apps/desktop/src/main/pty.ts` 通过 `webContents.send('shell-session-status', ...)` 推送状态
- [x] `apps/desktop/src/main/providers.ts` 实现 codex/claude 检测（命令存在/版本/登录状态）
- [x] `apps/desktop/src/main/projects.ts` 实现文件夹选择（`dialog.showOpenDialog`）与 Git 状态读取
- [x] `apps/desktop/src/main/codex.ts` 完整复刻 JSON-RPC 流程（initialize / thread/start / thread/resume 回退 / turn/start）
- [x] `apps/desktop/src/main/codex.ts` 监听所有 8 类事件（thread/started / turn/started / item/started / item/agentMessage/delta / item/commandExecution/outputDelta / item/completed / turn/completed / error）
- [x] `apps/desktop/src/main/codex.ts` 60s 超时
- [x] `apps/desktop/src/main/codex.ts` 注入中文系统指令
- [x] `apps/desktop/src/main/claude.ts` 完整复刻 stream-json 解析
- [x] `apps/desktop/src/main/claude.ts` 120s 超时
- [x] `apps/desktop/src/main/claude.ts` 支持 `--resume` 失败回退到新 session
- [x] `apps/desktop/src/main/claude.ts` 注入 `claude_desktop_prompt` 等价系统指令
- [x] `apps/desktop/src/main/sync.ts` 实现含 generation 计数器的 `DesktopCloudSync`
- [x] `apps/desktop/src/main/sync.ts` 10s 周期推送 providers/projects/ai-sessions 快照
- [x] `apps/desktop/src/main/sync.ts` 处理移动端 4 类消息（ai.session.create / ai.message.send / ai.history.request / ai.session.archive）
- [x] `apps/desktop/src/main/sync.ts` 上报 desktop.heartbeat
- [x] `apps/desktop/src/main/risk.ts` 用 TypeScript 复刻 `assess_command_risk` 15 条规则
- [x] `apps/desktop/src/main/updater.ts` 集成 `electron-updater`，autoDownload=false
- [x] `apps/desktop/src/main/updater.ts` 暴露 checkForUpdates / downloadUpdate / installUpdate IPC
- [x] `apps/desktop/src/main/updater.ts` 推送 update-available / download-progress / update-downloaded 事件
- [x] `apps/desktop/src/main/index.ts` 注册所有原 Tauri command 等价的 IPC handler
- [x] IPC 返回值结构（含 `ChatSegment` 联合类型）与原 Rust 实现一致

## 前端改造

- [x] `apps/desktop/src/services/tauri.ts` 已删除
- [x] `apps/desktop/src/services/desktop.ts` 已创建
- [x] `apps/desktop/src/services/desktop.ts` 所有 `invoke` 替换为 `window.desktop.ipc.*`
- [x] `apps/desktop/src/services/desktop.ts` 所有 `listen` 替换为 `window.desktop.on.*`，返回 unlisten 函数
- [x] `apps/desktop/src/services/desktop.ts` `ChatSegment` 联合类型与所有类型导出保持不变
- [x] `apps/desktop/src/composables/useWorkspace.ts` 仅 import 路径变更，业务逻辑未改
- [x] 所有 Vue 组件 import 路径从 `services/tauri` 改为 `services/desktop`
- [x] `TerminalView.vue` 事件订阅改为 `window.desktop.on.shellTerminalOutput`
- [x] 所有 Vue 组件业务逻辑未做改动

## CI 与文档

- [x] `.github/workflows/release-desktop.yml` 重写为 Electron 构建发布流程
- [x] `.github/workflows/release-desktop.yml` 不再安装 Rust 工具链与 Tauri Linux 依赖
- [x] `.github/workflows/release-desktop.yml` 触发条件仍为 `v*` tag
- [x] `README.md` 启动命令、依赖、目录结构已更新
- [x] `README.md` 已删除旧 CLI Agent 启动章节
- [x] `docs/protocol.md` "底层终端兼容协议"小节已删除
- [x] `docs/desktop-auto-update.md` 改为 electron-updater 说明
- [x] `docs/desktop-auto-update.md` `latest.json` → `latest.yml` 说明已更新
- [x] `docs/mobile-release-signing.md` 保持不变

## 验证

- [x] `pnpm dev` 能启动 Electron 桌面端并加载 Vue 前端
- [x] BrowserWindow 大小为 1440×900，最小 1024×640
- [x] PTY 终端能创建、收输出、退出
- [x] Codex 能完成一次会话（initialize → thread/start → turn/start → 事件流 → turn/completed）
- [x] Claude 能完成一次会话（stream-json 解析正常）
- [x] 移动端能配对（二维码 + 短码两条路径）、创建 AI 会话、收发消息、拉取历史
- [x] Provider 检测、项目添加、Git 状态正常
- [x] 应用更新检查能触发 `checkForUpdates`（不实际发布）
- [x] `cargo build` 在根目录成功（仅 `shared` + `server`）
- [x] `pnpm build` 在 `apps/desktop` 成功产出 electron-builder 产物
