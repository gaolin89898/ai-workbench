# AI 工作台

AI 工作台是一个多 AI Agent 桌面工作台原型，目标体验类似 Codex 桌面端，但可以同时集成 `Codex`、`Claude Code`、`Gemini`、`DeepSeek` 和后续自定义 CLI。

项目当前包含三端：

- `crates/server`：Rust Axum 云端中转服务，负责账号、配对、设备、Provider 状态、项目元信息、AI 会话元信息、WebSocket 转发和高危内容检查。
- `apps/desktop`：Tauri 桌面主应用，负责本机 AI 工具检测、项目登记、tmux AI 会话创建、Git 状态读取、本地 SQLite 历史能力和配对入口。
- `apps/mobile`：Flutter 移动端，负责登录、设备列表、项目、AI 工具状态、AI 会话、聊天式控制、日志和设置。
- `crates/desktop-agent`：旧的命令行桌面代理，保留为 tmux/screen 兼容和调试路径。

## 当前定位

主路径已经从“远程终端控制器”转为“AI 工作台”：

- 用户主路径是：选择本地项目，然后创建新的 AI 会话，或者接管已有 tmux/screen 会话。
- `tmux` / `screen` 仍是底层承载层，只在调试入口中暴露。
- 云端只保存元信息、摘要、状态和活动日志，不保存完整聊天内容。
- 完整 AI 聊天历史计划保存在桌面端本机 SQLite，默认路径为 `~/.ai-workbench/history.db`，也可以用 `AI_WORKBENCH_DB` 环境变量覆盖。
- 移动端查看完整历史需要对应桌面在线，由云端转发 `ai.history.request` 到桌面端读取本地 SQLite。

## 已实现能力

后端云端：

- 账号注册和登录。
- 桌面设备配对。
- 设备列表、设备详情、活动日志、用户设置。
- Provider 定义和每台桌面的 Provider 状态。
- 每台桌面的项目列表和 AI 会话元信息。
- AI 会话创建请求转发给在线桌面。
- `ai.message.send`、`ai.history.request` 等 AI 协议的 WebSocket 转发。
- 继续保留 `terminal.*` 协议作为底层兼容层。

桌面端：

- AI 工作台中文界面。
- 检测本机 `codex --version`、`claude --version`、`gemini --version`、`deepseek --version`。
- 添加本机项目目录并读取 `git branch --show-current`、`git status --short`。
- 自动创建 tmux AI 会话：`tmux new-session -d -s <name> -c <project_path> <provider_command>`。
- 接管已有 tmux/screen 会话的界面入口。
- 本地 SQLite 表：`local_ai_sessions`、`local_ai_messages`。
- 桌面配对入口。

移动端：

- 登录 / 自动注册。
- 桌面设备列表和设备详情。
- 项目列表、项目详情，并从项目入口创建或接管 AI 会话。
- AI 工具状态页。
- AI 会话列表、新建 AI 会话、聊天页。
- 通过 WebSocket 发送 `ai.message.send`，接收 `ai.message.delta` 和 `ai.history.response`。
- 日志页和设置页。
- 底层终端调试页仍可打开 tmux/screen 会话。

## 启动后端

先启动 PostgreSQL：

```bash
docker compose up -d postgres
```

运行云端中转服务：

```bash
export DATABASE_URL=postgres://remote_term:remote_term@127.0.0.1:5432/remote_term
export JWT_SECRET=change-this-in-production
cargo run -p remote-term-server
```

默认监听：

```text
http://127.0.0.1:8080
```

服务启动时会自动执行 `crates/server/migrations` 里的数据库迁移。

## 启动桌面端

Linux 上首次编译 Tauri 可能需要系统依赖，例如 GTK / WebKit / pkg-config。依赖装好后运行：

```bash
cd apps/desktop
npm install
npm run dev
```

如果 1420 端口被占用，修改 [apps/desktop/src-tauri/tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json) 里的 `devUrl`，同时修改 [apps/desktop/package.json](apps/desktop/package.json) 里的 `vite:dev` 端口。

桌面端本机历史数据库默认在：

```text
~/.ai-workbench/history.db
```

也可以这样指定：

```bash
export AI_WORKBENCH_DB=/path/to/history.db
npm run dev
```

## 启动移动端

Flutter SDK 安装后运行：

```bash
cd apps/mobile
flutter pub get
flutter run
```

移动端登录页默认服务器地址可以填：

```text
http://127.0.0.1:8080
```

如果手机真机访问本机服务，需要把 `127.0.0.1` 换成电脑在局域网里的 IP，并确保防火墙允许访问。

## 配对桌面

1. 先在移动端登录，进入配对页生成一次性配对码。
2. 在桌面端“配对”页填写服务器地址和配对码。
3. 配对成功后，云端会返回 `deviceId` 和桌面访问 token。

旧命令行代理仍可作为调试路径：

```bash
cargo run -p remote-term-desktop-agent -- pair \
  --server http://127.0.0.1:8080 \
  --code YOURCODE \
  --name "Workstation"
```

## 核心 HTTP API

账号和设备：

- `POST /auth/register`
- `POST /auth/login`
- `POST /pairing/codes`
- `POST /desktop/pair`
- `GET /devices`
- `GET /devices/:deviceId`

AI 工作台元信息：

- `GET /providers`：获取云端内置 Provider 定义。
- `GET /devices/:deviceId/providers`：获取某台桌面的 Provider 检测状态。
- `GET /devices/:deviceId/projects`：获取某台桌面登记的项目。
- `POST /devices/:deviceId/projects`：登记或更新项目路径。
- `GET /devices/:deviceId/ai-sessions`：获取某台桌面的 AI 会话元信息。
- `POST /devices/:deviceId/ai-sessions`：创建 AI 会话元信息，并向在线桌面转发创建请求。
- `GET /ai-sessions/:sessionId`：获取单个 AI 会话元信息。

兼容 / 调试：

- `GET /devices/:deviceId/sessions`：查看底层 tmux/screen 会话。
- `GET /activity-logs`
- `GET /settings`
- `PUT /settings`

## 核心 WebSocket

移动端连接：

```text
/ws/mobile?token=<accessToken>
```

桌面端连接：

```text
/ws/desktop?token=<desktopAccessToken>
```

AI 主协议包括：

- `providers.snapshot`
- `projects.snapshot`
- `ai.sessions.snapshot`
- `ai.session.create`
- `ai.message.send`
- `ai.message.delta`
- `ai.message.done`
- `ai.history.request`
- `ai.history.response`
- `git.status.snapshot`

底层兼容协议继续保留：

- `sessions.snapshot`
- `terminal.input`
- `terminal.control`
- `terminal.output`
- `terminal.error`

更完整的消息示例见 [docs/protocol.md](docs/protocol.md)。

## 验证

Rust 工作区：

```bash
cargo test --workspace
```

桌面前端：

```bash
cd apps/desktop
npm run vite:build
```

移动端静态检查：

```bash
cd apps/mobile
flutter analyze
```

当前环境如果没有 Flutter SDK，会看到 `flutter: command not found`，需要先安装 Flutter 后再执行。

## 设计稿

新的中文 AI 工作台设计稿已经导出到：

```text
design-exports-agent-cn/
```

包含桌面端工作台首页、AI 工具、新建 AI 会话、聊天会话、项目详情、设置，以及移动端工作台、项目、新建会话、AI 聊天、AI 工具、日志/设置等页面。

## v1 边界

- v1 仍以 `tmux` / `screen` 作为 AI CLI 承载层，不直接接管任意图形终端窗口。
- “接管已有会话”指接管已有 `tmux` / `screen` 的 window/pane；Codex、Claude Code 等工具内部自己的项目/对话历史不属于系统会话列表，只有当它们运行在某个 tmux/screen pane 里时才能被接管。
- Windows v1 优先走 WSL + tmux。
- 云端不保存完整聊天内容，只保存元信息和摘要。
- Git 能力先展示 branch、dirty 状态和文件列表，不做完整 diff 和内置编辑器。
- 自定义 Provider 后续会做成配置能力；当前内置 Provider 为 Codex、Claude Code、Gemini、DeepSeek。
