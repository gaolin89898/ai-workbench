# CodeHub AI

CodeHub AI 是一个面向本地项目的多 AI Agent 工作台。它把真正的 AI CLI 运行留在你的电脑上，同时提供桌面端主工作区、移动端远程控制和一个轻量的云端中转服务。

目标体验很直接：在桌面端选择一个本地项目，创建 AI 会话，让 Codex、Claude Code、OpenCode、DeepSeek 或后续自定义 CLI 在你的项目目录里工作；你也可以在移动端查看项目、发起任务、响应审批，并跟随桌面端看到同一轮会话状态。

## 为什么做这个

很多 AI 编码工具都运行在本机，但跨设备查看、远程发起任务、保留完整项目上下文和同步会话状态并不顺手。CodeHub AI 希望把这些能力组合到一个清晰的产品里：

- **本机执行**：AI CLI 在桌面端运行，能访问你的本地项目、Git 状态和 shell 环境。
- **跨端控制**：移动端通过云端中转连接桌面端，可以查看项目、创建会话、发送消息和处理审批。
- **隐私优先**：完整聊天历史默认保存在桌面端本机，云端只保存账号、设备、项目和会话元信息。
- **多 Provider**：Codex 是当前重点体验，Claude Code、OpenCode、DeepSeek 和后续自定义 CLI 可以逐步接入。
- **过程可见**：AI 回复不是只有最终文本，还会展示思考、命令执行、文件修改、审批和错误等过程。

## 当前状态

项目仍处于原型和快速迭代阶段，适合试用、二次开发和参与设计讨论。当前已经具备桌面端、移动端、后端中转服务和用户管理后台，但安装流程、发版流程和多 Provider 体验还在持续完善。

当前重点体验是 Codex：

- 桌面端运行 Codex。
- 移动端同步桌面端的 Codex 会话状态。
- 一轮回复稳定展示为“用户问题 / 执行过程 / 最终回答”。
- 执行过程和最终回答不会在移动端拆成两条 assistant 消息。

## 产品体验

### 桌面端

桌面端是主要工作区，负责真正运行 AI 工具。

你可以：

- 添加本机项目目录。
- 查看项目 Git 分支和未提交状态。
- 创建 AI 会话并选择 Provider。
- 在项目目录中使用独立 shell。
- 查看完整聊天历史。
- 响应 Codex 的命令执行和文件修改审批。
- 检查应用更新并安装新版本。

完整聊天历史默认保存在：

```text
~/.ai-workbench/history.db
```

也可以通过环境变量指定其他位置：

```text
AI_WORKBENCH_DB
```

### 移动端

移动端用于远程查看和控制桌面端。

你可以：

- 登录账号。
- 查看在线桌面设备。
- 查看桌面端登记的项目。
- 创建或进入 AI 会话。
- 发送消息给桌面端运行的 AI。
- 查看执行过程和最终回答。
- 响应 Codex 审批。
- 查看活动日志和基础设置。
- 检查移动端 APK 更新；如果服务端标记当前版本不兼容，会提示必须更新。

移动端查看完整历史时，需要对应桌面端在线。移动端不会直接读取桌面数据库，而是通过云端请求桌面端读取本机历史后返回。

### 云端中转

云端服务负责账号、同账号自动绑定、设备在线状态、项目元信息、会话元信息和 WebSocket 消息转发。

云端不保存完整聊天内容。完整对话和 AI 执行记录默认保存在桌面端本机。

### 用户管理后台

用户管理后台用于管理账号、设备状态和软件版本发布，适合自托管部署时查看用户、在线设备、重置密码和通知客户端更新。

版本发布页可以分别配置桌面端和移动端的最新版本、最低可用版本、下载地址、Release 页面和更新说明。桌面端下载地址按 Windows/Linux 分开填写，移动端填写 APK 下载地址。保存后，在线客户端会收到更新通知。

“最低可用版本”用于处理不兼容老版本：如果客户端当前版本低于这个值，服务端会返回必须更新，客户端提示用户更新后继续使用。

## 跨端会话模型

CodeHub AI 把会话显示拆成两个层次：

- **会话外壳**：用户问题、Provider、标题、状态、最终回答。
- **执行过程**：不同 Provider 自己的运行记录，例如 Codex 的思考、命令、文件修改、审批和错误。

这样做是为了保证桌面端和移动端看到的是同一轮对话，而不是两端各自把日志重新拼成聊天消息。

以 Codex 为例，一轮回复会稳定展示为：

```text
用户问题

执行过程
  思考、命令执行、文件修改、审批、错误等过程

最终回答
  本轮 Codex 给出的最终回复
```

移动端不会重新猜测哪些内容是“执行过程”、哪些内容是“最终回答”。桌面端负责整理本机 Codex 的真实运行状态，移动端只同步并展示同一份结果。

## 项目结构

```text
.
├── apps/
│   ├── desktop/              # Electron + Vue 桌面端
│   └── mobile/               # Flutter 移动端
├── backend/                  # Go 云端中转服务和数据库迁移
├── user-admin-system/        # Web 用户管理后台
├── docs/                     # 协议、更新和运维文档
├── docker-compose.yml        # 本地 PostgreSQL
└── docker-compose.prod.yml   # 生产 PostgreSQL + 后端编排
```

主要技术栈：

- 桌面端：Electron、Vue 3、electron-vite、SQLite。
- 移动端：Flutter。
- 后端：Go、PostgreSQL、WebSocket。
- 管理后台：Vue 3、Vite、Arco Design。

## 快速开始

### 1. 启动后端

准备 Go 1.22+ 和 Docker。

启动 PostgreSQL：

```bash
docker compose up -d postgres
```

启动后端服务：

```bash
export DATABASE_URL=postgres://remote_term:remote_term@127.0.0.1:5432/remote_term
export JWT_SECRET=change-this-in-production
cd backend
go run ./cmd/server
```

默认地址：

```text
http://127.0.0.1:3000
```

服务启动时会自动执行 `backend/migrations` 里的数据库迁移。

### 2. 启动桌面端

准备 Node.js 22 和 pnpm 10。

```bash
cd apps/desktop
pnpm install
pnpm dev
```

桌面端会启动 Electron 应用，并在本机运行 AI CLI。使用 Codex 前，请先确认本机可以正常运行：

```bash
codex --version
```

桌面端登录页需要填写服务器地址。项目不再内置默认服务器地址；第一次登录成功后，服务器地址会保存在本地。

### 3. 启动移动端

准备 Flutter SDK。

```bash
cd apps/mobile
flutter pub get
flutter run
```

移动端登录页需要填写服务器地址。项目不再内置默认服务器地址；第一次登录成功后，服务器地址会保存在本地。

模拟器访问本机后端可以填写：

```text
http://127.0.0.1:3000
```

真机访问时，请把 `127.0.0.1` 换成电脑在局域网里的 IP，并确保防火墙允许访问。

### 4. 启动用户管理后台

```bash
cd user-admin-system
pnpm install
pnpm dev
```

开发服务器默认把 `/api` 代理到当前配置的后端地址，可在 [user-admin-system/vite.config.ts](user-admin-system/vite.config.ts) 中调整。

## 桌面和移动端自动绑定

1. 在桌面端登录账号。
2. 在移动端使用同一个账号登录。
3. 移动端会自动看到同账号下的桌面设备、项目和 AI 会话。

## 开发命令

后端测试：

```bash
cd backend
go test ./...
```

桌面端构建：

```bash
cd apps/desktop
pnpm run build
```

桌面端打包 Linux 安装包：

```bash
cd apps/desktop
pnpm package:linux
```

移动端静态检查：

```bash
cd apps/mobile
flutter analyze
```

移动端测试：

```bash
cd apps/mobile
flutter test
```

用户管理后台构建：

```bash
cd user-admin-system
pnpm run build
```

## 文档

- WebSocket 和消息协议：[docs/protocol.md](docs/protocol.md)
- 桌面端自动更新：[docs/desktop-auto-update.md](docs/desktop-auto-update.md)
- 服务器部署和运维：[docs/server-ops.md](docs/server-ops.md)

## 自动更新

软件更新现在采用“服务端版本策略优先，GitHub Releases 兜底”的方式。

后台管理员在用户管理系统的“版本发布”里配置桌面端和移动端版本。客户端检查更新时会先请求当前登录服务器：

```text
GET /app/releases?platform=desktop|mobile&currentVersion=当前版本
```

服务端会判断：

- 当前版本是否低于最新版本。
- 当前版本是否低于最低可用版本。
- 是否启用了强制更新提示。

如果低于最低可用版本，客户端会显示必须更新。保存版本配置后，服务端还会通过 WebSocket 向在线客户端推送 `app.update.available`。

桌面端仍保留 electron-updater/GitHub Releases 作为兜底。发布 `v*` 标签后，GitHub Actions 会构建 Electron 安装包并上传更新元信息，桌面端可在“设置 -> 应用更新”里检查、下载并重启安装。

桌面端版本配置可以分别维护 Windows 和 Linux 安装包地址。移动端会优先使用服务端配置的 APK 下载地址；服务端没有配置或请求失败时，再尝试从 GitHub Releases 查找 APK。

客户端不会静默安装更新。用户点击更新后才会下载或打开安装包；如果桌面端有 AI 会话正在运行，会先提示停止当前会话后再更新。

配置细节见 [docs/desktop-auto-update.md](docs/desktop-auto-update.md)。

## 适合参与的方向

这个项目后续可以继续扩展：

- 更完整的 Codex 桌面体验。
- Claude Code、OpenCode、DeepSeek 等 Provider 的专属执行记录。
- 更稳定的移动端远程控制体验。
- 更简单的自托管部署流程。
- 更完善的权限、审批和风险提示。
- 面向插件或自定义 CLI 的 Provider 接入机制。

欢迎围绕产品体验、跨端同步、Provider 接入和本地优先架构继续改进。
