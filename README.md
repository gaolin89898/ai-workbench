# AI 工作台

AI 工作台是一个多 AI Agent 桌面工作台原型，目标体验类似 Codex Desktop，但可以同时集成 `Codex`、`Claude Code`、`OpenCode`、`DeepSeek` 和后续自定义 CLI。

它的核心思路是：**桌面端负责真正运行本机 AI CLI，后端负责账号、配对和消息转发，移动端负责远程查看和控制桌面上的项目与 AI 会话。**

项目当前包含三端：

- `backend`：Go 云端中转服务（`net/http` + `pgx`），负责账号、配对、设备、Provider 状态、项目元信息、AI 会话元信息、WebSocket 转发和高危内容检查。
- `apps/desktop`：Electron 桌面主应用，负责本机 AI 工具检测、项目登记、Git 状态读取、本地 SQLite 历史能力、本地 AI 会话、shell pty 调试终端和配对入口。
- `apps/mobile`：Flutter 移动端，负责登录、设备列表、项目、AI 工具状态、AI 会话、聊天式控制、日志和设置。

## 项目速览

```text
.
├── apps/
│   ├── desktop/              # Vue 3 + Electron 桌面端
│   │   ├── src/              # 桌面端前端页面、路由和渲染进程逻辑
│   │   ├── src/main/         # Electron 主进程（本地 SQLite、pty、本地 AI 会话、自动更新）
│   │   └── src/preload/      # Electron preload 脚本
│   └── mobile/               # Flutter 移动端
├── backend/                  # Go 后端服务和数据库迁移
├── docs/protocol.md          # WebSocket 协议说明
├── docker-compose.yml        # 本地 PostgreSQL
└── Dockerfile                # 后端容器镜像
```

主要入口：

- 后端入口：[backend/cmd/server/main.go](backend/cmd/server/main.go)
- 后端路由：[backend/internal/routes/router.go](backend/internal/routes/router.go)
- 桌面前端入口：[apps/desktop/src/main.ts](apps/desktop/src/main.ts)
- 桌面路由：[apps/desktop/src/router.ts](apps/desktop/src/router.ts)
- 桌面主进程：[apps/desktop/src/main/index.ts](apps/desktop/src/main/index.ts)
- 移动端入口：[apps/mobile/lib/main.dart](apps/mobile/lib/main.dart)

## 当前定位

项目当前定位为 **AI 工作台**。

核心使用路径是：用户先选择一个本地项目，然后创建新的 AI 会话，或接管已有的 `tmux` / `screen` 会话继续工作。

桌面端负责承载主要工作流，包括本地 Shell PTY、本地 AI 会话、本地项目管理和完整 AI 聊天历史。`tmux` / `screen` 仍然保留，用于兼容已有工作环境、接管历史会话和调试。

云端只作为账号、设备配对、状态同步和消息转发层使用。它保存设备、项目、会话元信息、摘要、状态和活动日志，不保存完整聊天内容。

完整 AI 聊天历史默认保存在桌面端本机 SQLite 数据库：

```text
~/.ai-workbench/history.db
```

也可以通过环境变量覆盖：

```text
AI_WORKBENCH_DB
```

移动端查看完整历史时，需要对应桌面端在线。移动端会通过云端发送 `ai.history.request`，由桌面端读取本机 SQLite 后再通过云端转发返回。这样可以让完整聊天内容留在用户本机，同时移动端仍然能在桌面在线时查看和接续会话。

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
- 检测本机 `codex --version`、`claude --version`、`opencode --version`、`deepseek --version`。
- 添加本机项目目录并读取 `git branch --show-current`、`git status --short`。
- 创建本地 AI 会话记录，并保存 provider、项目路径、标题、状态、摘要、归档状态和更新时间。
- 本地 AI 会话可预热会话、记录 provider thread id，并在后续消息中 resume。
- 支持 shell pty 调试终端：启动、输入、resize、读取缓冲、停止，并通过主进程事件推送输出。
- 接管已有 tmux/screen 会话的界面入口。
- 本地 SQLite 表：`local_ai_sessions`、`local_ai_messages`。
- 支持本地 AI 会话归档 / 取消归档。
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

后端基于 Go 1.22+，使用标准库 `net/http` 路由和 `pgx` 连接 PostgreSQL。需要先准备：

- Go 1.22+
- PostgreSQL（通过 docker-compose 启动）

先启动 PostgreSQL：

```bash
docker compose up -d postgres
```

运行云端中转服务：

```bash
export DATABASE_URL=postgres://remote_term:remote_term@127.0.0.1:5432/remote_term
export JWT_SECRET=change-this-in-production
cd backend && go run ./cmd/server
```

默认监听：

```text
http://127.0.0.1:3000
```

服务启动时会自动执行 `backend/migrations` 里的数据库迁移。

如果要启用钉钉登录，还需要在钉钉开放平台创建应用，并把回调地址配置为：

```text
https://你的服务域名/oauth/dingtalk/callback
```

后端启动时注入这 3 个环境变量：

```bash
export DINGTALK_CLIENT_ID=你的钉钉应用ClientID
export DINGTALK_CLIENT_SECRET=你的钉钉应用ClientSecret
export DINGTALK_REDIRECT_URL=https://你的服务域名/oauth/dingtalk/callback
```

产品流程是：桌面端或移动端请求 `/oauth/dingtalk/start`，后端返回钉钉授权地址；用户在浏览器里扫码确认后，钉钉回调 `/oauth/dingtalk/callback`；后端用回调里的 `code` 换取钉钉用户身份，查找或创建本地账号，再返回本系统登录 token；客户端通过 `/oauth/dingtalk/poll` 轮询拿到结果。

## 启动桌面端

桌面端基于 Electron + Vue 3，使用 electron-vite 构建。需要先准备：

- Node.js 22
- pnpm 10
- Electron 33（首次 `pnpm install` 时自动拉取）

依赖装好后运行：

```bash
cd apps/desktop
pnpm install
pnpm dev
```

`pnpm dev` 等价于 `electron-vite dev`，会同时启动渲染进程的 Vite dev server 和 Electron 主进程。如果 dev server 端口被占用，修改 [apps/desktop/electron.vite.config.ts](apps/desktop/electron.vite.config.ts) 中的配置。默认窗口为 1440×900，最小 1024×640，可在主进程中调整。

桌面端本机历史数据库默认在：

```text
~/.ai-workbench/history.db
```

也可以这样指定：

```bash
export AI_WORKBENCH_DB=/path/to/history.db
pnpm dev
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
http://127.0.0.1:3000
```

如果手机真机访问本机服务，需要把 `127.0.0.1` 换成电脑在局域网里的 IP，并确保防火墙允许访问。

## 配对桌面

1. 先在移动端登录，进入配对页生成一次性配对码。
2. 在桌面端“配对”页填写服务器地址和配对码。
3. 配对成功后，云端会返回 `deviceId` 和桌面访问 token。

## 核心 HTTP API

账号和设备：

- `POST /auth/register`
- `POST /auth/login`
- `GET /oauth/dingtalk/start`
- `GET /oauth/dingtalk/callback`
- `GET /oauth/dingtalk/poll`
- `POST /pairing/codes`
- `POST /desktop/pair`
- `POST /desktop/register-device`
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

更完整的消息示例见 [docs/protocol.md](docs/protocol.md)。

## 验证

Go 后端：

```bash
cd backend
go test ./...
```

桌面端构建：

```bash
cd apps/desktop
pnpm build
```

打包 Linux 安装包：

```bash
cd apps/desktop
pnpm package:linux
```

移动端静态检查：

```bash
cd apps/mobile
flutter analyze
```

当前环境如果没有 Flutter SDK，会看到 `flutter: command not found`，需要先安装 Flutter 后再执行。

## 桌面端自动更新

桌面端使用 electron-updater 从 GitHub Releases 拉取更新。发布 `v*` 标签后，GitHub Actions 会构建 Electron 安装包并上传 `latest.yml`，桌面端可在“设置 -> 应用更新”里检查、下载并重启安装。

发版流程和配置细节见 [docs/desktop-auto-update.md](docs/desktop-auto-update.md)。

## 设计稿

`.pen` 设计稿位于仓库根目录：

- `icon.pen`：图标设计稿。
- `pencil-new.pen`：整体 UI 设计稿（桌面端 + 移动端），包含工作台首页、AI 工具、新建 AI 会话、聊天会话、项目详情、设置，以及移动端工作台、项目、新建会话、AI 聊天、AI 工具、日志/设置等页面。

设计稿导出的临时资源可能不会全部保留在仓库中，实际应用图标以 `apps/desktop/src/assets/icons/` 为准。

## v1 边界

- v1 不直接接管任意图形终端窗口。主路径优先走桌面端本地 AI 会话；`tmux` / `screen` 作为兼容和调试路径保留。
- “接管已有会话”指接管已有 `tmux` / `screen` 的 window/pane；Codex、Claude Code 等工具内部自己的项目/对话历史不属于系统会话列表，只有当它们运行在某个 tmux/screen pane 里时才能被接管。
- Windows v1 优先走 WSL + tmux。
- 云端不保存完整聊天内容，只保存元信息和摘要。
- Git 能力先展示 branch、dirty 状态和文件列表，不做完整 diff 和内置编辑器。
- 自定义 Provider 后续会做成配置能力；当前内置 Provider 为 Codex、Claude Code、OpenCode、DeepSeek。
