# CodeHub AI 项目概览

## 1. 项目定位

CodeHub AI（仓库名 `ai-workbench`）是一个本地优先的多 AI 编程工作台。桌面端负责访问项目目录、运行 AI 工具、执行 shell、处理审批并保存完整会话；移动端通过自建服务远程查看和控制桌面端。

核心边界如下：

- AI Provider 和命令实际运行在用户的桌面设备上。
- 项目文件、Git 工作区和本地凭据不在中转服务持久化；文件预览只在用户请求时临时转发。
- 后端负责账号、设备、项目/会话元数据、在线状态和 WebSocket 消息转发。
- 完整聊天历史默认保存在桌面端 SQLite 中，不作为云端聊天备份。
- 移动端读取历史、执行任务或浏览项目文件时，对应桌面端必须在线。

当前桌面端版本为 `0.2.1`，移动端版本为 `0.1.99+99`，管理后台版本为 `0.1.0`。

## 2. 系统组成

| 组件 | 技术栈 | 主要职责 |
| --- | --- | --- |
| 桌面端 | Electron 42、Vue 3、TypeScript、SQLite | 管理本地项目，运行 Provider，保存完整历史，处理终端、文件和审批 |
| 移动端 | Flutter | 查看设备和项目，创建/继续会话，发送任务，查看执行轨迹并响应审批 |
| 中转后端 | Go 1.22、PostgreSQL、WebSocket | 认证、设备绑定、元数据持久化、在线状态和跨端消息转发 |
| 管理后台 | Vue 3、Vite、Arco Design | 管理用户、设备和桌面端/移动端版本发布策略 |

## 3. 架构与数据流

```text
Flutter 移动端
      │ HTTPS / WebSocket
      ▼
Go 中转服务 ───── PostgreSQL
      │ WebSocket      账号、设备、项目/会话元数据、版本策略
      ▼
Electron 桌面端 ─── SQLite
      │                完整会话、执行轨迹
      ├── 本地项目文件 / Git / Shell
      └── Codex / Claude Code / OpenCode / MiMo Code
```

一次移动端任务的主要流程：

1. 移动端通过 HTTP 创建会话元数据，或通过 WebSocket 向已有会话发送消息。
2. 后端校验账号与设备归属，将消息转发给在线桌面端。
3. 桌面端在目标项目目录中调用对应 Provider，并把用户消息和执行结果写入本地 SQLite。
4. 桌面端将状态、增量输出、执行轨迹、审批和最终结果通过后端实时转发给移动端。
5. 移动端进入会话时主动请求历史；桌面端在线读取本地历史后返回。

这套同步协议由 CodeHub AI 自己实现，不依赖 Claude 官方桌面端或移动端的内部同步服务。

## 4. Provider 对接现状

| Provider | 当前接入方式 | 模型选择 | 会话与输出 | 近期功能 |
| --- | --- | --- | --- | --- |
| Codex | 本地 `codex app-server` | 通过 app-server 的模型列表动态获取可用模型及推理强度 | 支持会话恢复、结构化执行轨迹和审批 | 支持 Skills 管理面板、Pipeline 编排、Chatroom 多角色协作模式 |
| Claude Code | `@anthropic-ai/claude-agent-sdk` 的 `query()` | 当前界面使用静态别名；SDK 已提供动态模型信息 | 支持会话恢复、流式消息、Hook 事件和执行轨迹 | - |
| OpenCode | 本地 OpenCode ACP | 当前按客户端配置传递模型和运行参数 | 支持会话恢复和结构化事件 | - |
| MiMo Code | 本地 CLI JSON 协议 | 当前传递 `provider/model` 和 variant | 支持会话恢复、结构化事件和审批 | - |

### Claude Code 为什么当前没有显示具体模型名

这不是 Claude Agent SDK 的能力限制，而是当前项目的对接尚未完成。项目现在在桌面端和同步层维护 `sonnet`、`opus` 等静态选项，调用 `query()` 时只把选中的值传给 `options.model`，没有读取 SDK 初始化阶段返回的模型清单。

当前安装的 `@anthropic-ai/claude-agent-sdk@0.3.203` 已提供以下能力：

- `Query.supportedModels()` 可返回当前账号和运行环境可用的 `ModelInfo[]`。
- `Query.initializationResult()` 的 `models` 字段可返回同一份初始化模型信息。
- `ModelInfo.value` 是传给 SDK 的值，`resolvedModel` 是别名解析后的具体模型 ID，`displayName` 和 `description` 可直接用于界面。
- `supportsEffort` 与 `supportedEffortLevels` 可用于按模型生成正确的推理强度选项。
- Claude 的 `system/init` 事件还包含本次运行的实际 `message.model`，当前执行轨迹已经显示该值。

因此正确的完善方向是：由 Electron 主进程启动 Claude SDK 查询并读取 `supportedModels()`，通过 IPC 返回桌面界面，再纳入 `ai.run.settings.snapshot` 同步到移动端。查询失败时才回退到静态别名和“默认”选项。这样既能显示友好的模型名称，也能保留别名的升级语义。

选择“默认”时仍应不传 `model`，由本机 Claude Code、账号权限和 Anthropic 当前配置决定实际模型；界面可在会话启动后用 `system/init.model` 显示最终解析结果。

Claude 官方桌面端与移动端的跨设备体验属于 Anthropic 自身的账号和云端产品能力，不是 Claude Agent SDK 暴露的同步协议。本项目只使用 Agent SDK 执行本地 Claude Code，会话元数据、历史请求和实时事件均走自己的后端协议。

## 5. 桌面端与移动端同步

桌面端登录后建立 `/ws/desktop` 连接，移动端建立 `/ws/mobile` 连接。同一账号下的设备自动关联，后端只向有权限的设备转发消息。

当前同步内容包括：

- Provider 安装、版本和登录状态快照。
- 项目名称、路径、Git 分支和工作区状态摘要。
- AI 会话标题、Provider、状态、摘要和 Provider 会话 ID 等元数据。
- 当前模型、推理强度、运行模式等运行设置。
- 用户消息、流式输出、结构化执行轨迹、错误和完成状态。
- Codex 与 MiMo 等 Provider 的审批请求和审批结果。
- 项目文件列表与文件预览请求；文件内容由在线桌面端按需返回。
- 桌面端本地完整历史的按需读取结果。

后端不会直接执行 AI，也不会直接读取桌面端文件。桌面端离线时，移动端仍可看到已持久化的设备、项目和会话元数据，但不能读取完整历史、浏览文件或继续执行任务。

## 6. 数据归属

| 数据 | 保存位置 | 说明 |
| --- | --- | --- |
| 完整聊天历史和执行轨迹 | 桌面端 SQLite，默认 `~/.ai-workbench/history.db` | 可用 `AI_WORKBENCH_DB` 修改路径 |
| 项目文件、Git 状态和 shell 环境 | 桌面设备 | 只在本地访问，文件预览按请求临时转发 |
| Provider 凭据和本地 CLI 登录态 | 桌面设备 | 后端只接收安装/登录状态，不保存密钥 |
| 账号、设备、项目/会话元数据 | 后端 PostgreSQL | 用于设备发现、列表展示和路由 |
| 实时输出与审批事件 | WebSocket 中转 | 用于在线转发，不代替桌面端历史库 |
| 版本策略和用量汇总 | 后端 PostgreSQL | 供客户端更新提示和管理后台展示 |

## 7. 仓库结构

```text
.
├── apps/
│   ├── desktop/             # Electron + Vue 桌面端
│   └── mobile/              # Flutter 移动端
├── backend/                 # Go API、WebSocket 中转和数据库迁移
├── user-admin-system/       # Vue 管理后台
├── docs/                    # 协议、发布和运维文档
├── assets/                  # 品牌资源
├── scripts/                 # 构建与发布脚本
├── docker-compose.yml       # 本地 PostgreSQL
└── docker-compose.prod.yml  # 生产环境编排
```

关键实现位置：

- `apps/desktop/src/main/codex.ts`：Codex app-server 接入。
- `apps/desktop/src/main/claude.ts`：Claude Agent SDK 接入。
- `apps/desktop/src/main/acp.ts`：OpenCode ACP 接入。
- `apps/desktop/src/main/mimo.ts`：MiMo Code 接入。
- `apps/desktop/src/main/sync.ts`：桌面端云连接和跨端消息处理。
- `apps/desktop/src/main/db.ts`：本地会话与执行记录。
- `apps/mobile/lib/services/realtime_client.dart`：移动端实时协议客户端。
- `backend/internal/ws/`：桌面端与移动端 WebSocket 路由。
- `backend/internal/protocol/protocol.go`：后端协议结构。

## 8. 本地开发

环境要求：Node.js 22、pnpm 10、Go 1.22、Flutter SDK 3.4+ 和 Docker。

启动 PostgreSQL 与后端：

```bash
docker compose up -d postgres
cd backend
DATABASE_URL=postgres://remote_term:remote_term@127.0.0.1:5432/remote_term \
JWT_SECRET=change-this-in-production \
go run ./cmd/server
```

启动桌面端：

```bash
cd apps/desktop
pnpm install
pnpm dev
```

启动移动端：

```bash
cd apps/mobile
flutter pub get
flutter run
```

启动管理后台：

```bash
cd user-admin-system
pnpm install
pnpm dev
```

常用验证命令：

```bash
(cd backend && go test ./...)
(cd apps/desktop && pnpm build)
(cd apps/mobile && flutter analyze && flutter test)
(cd user-admin-system && pnpm build)
```

## 9. 最近新增功能（v0.2.x）

桌面端 0.2.x 版本新增以下 Codex 相关能力：

- **Pipeline 编排**：支持多代理流水线任务的创建、模板选择、步骤进度展示和结果汇总（commit 0aecff8, be2d398）。
- **Chatroom 模式**：多角色协作模式，支持 @mention、共享历史和角色管理（commit 9b9a07c）。
- **Skills 管理面板**：已接入 Skills 发现、查看、启停和额外目录管理（`SkillsManagementPanel.vue` 和 `codex_skills.ts`）。

## 10. 当前限制与后续重点

- 移动端远程执行、完整历史和文件浏览依赖桌面端在线，当前不是离线云工作区。
- 云端不保存完整聊天内容，不能作为桌面端数据库损坏或丢失后的恢复来源。
- 各 Provider 的模型发现、推理参数、事件类型和审批能力不同，跨 Provider 界面只能在能力边界内统一。
- Claude Code 模型列表目前仍是静态别名；应接入 SDK 的 `supportedModels()`，同步 `resolvedModel`、显示名称和按模型支持的 effort。
- OpenCode 和 MiMo 的模型列表仍需进一步接入各自可靠的能力发现机制。
- 协议新增字段应同步更新桌面端、移动端、`backend/internal/protocol` 和 `docs/protocol.md`，并保留旧客户端兼容处理。
- 发布前应持续验证桌面端构建、后端测试、Flutter 静态检查/测试以及真实设备的断线重连与审批流程。

更细的消息格式、发布和部署说明见：

- `docs/protocol.md`
- `docs/desktop-auto-update.md`
- `docs/mobile-release-signing.md`
- `docs/server-ops.md`
