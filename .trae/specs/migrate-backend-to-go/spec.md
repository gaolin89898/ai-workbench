# 后端 Rust → Go 迁移 Spec

## Why

当前 Rust 后端（Axum + sqlx + tokio-tungstenite）约 2100 行，是个纯 WebSocket 中转 + PostgreSQL CRUD 服务，没有用到 Rust 的并发/性能优势，却要承担 Rust 工具链、编译期 SQL 校验、async 复杂度这些维护成本。换成 Go 后单二进制部署、CI 更简单、维护门槛降低，且 Go 的 goroutine 天然匹配长连接保活场景。

## What Changes

- 新建 `backend/` 目录，用 Go 重写整个云端服务
- HTTP 路由从 Axum 迁到 `chi`（或标准库 `net/http`）
- PostgreSQL 从 sqlx 迁到 `jackc/pgx/v5`
- WebSocket 从 tokio-tungstenite 迁到 `gorilla/websocket`
- JWT 从 jsonwebtoken 迁到 `golang-jwt/jwt/v5`
- 密码哈希 argon2 用 `golang.org/x/crypto/argon2`
- `RealtimeMessage` 枚举改写为 Go struct + type 字段分发
- `assess_command_risk` 15 条规则原样移植
- 7 个 SQL 迁移文件直接复用（schema 不变）
- 删除 `crates/server/` 和 `crates/shared/`（桌面端/移动端不再依赖 shared crate）
- 根 `Cargo.toml` workspace 仅保留必要的 crate（实际已无 Rust 代码，整个 workspace 可删除）
- CI 新增 `release-server.yml` 交叉编译 Go 二进制
- **BREAKING**：后端启动方式从 `cargo run -p remote-term-server` 改为 `go run ./cmd/server`
- **BREAKING**：后端构建产物从 Rust 二进制改为 Go 单二进制

## Impact

- Affected specs: 无（HTTP + WebSocket 协议保持不变，桌面端/移动端无需改动）
- Affected code:
  - 新建：`backend/` 整个目录
  - 删除：`crates/server/`、`crates/shared/`、根 `Cargo.toml`、`Cargo.lock`
  - 保留：`crates/server/migrations/*.sql`（移到 `backend/migrations/`）
  - 修改：`README.md`、`docker-compose.yml`（无变化）、`.github/workflows/`（新增 release-server.yml）
  - 不变：`apps/desktop/`、`apps/mobile/`、`docs/protocol.md`、`docs/desktop-auto-update.md`、`docs/mobile-release-signing.md`

## ADDED Requirements

### Requirement: Go 后端工程结构

系统 SHALL 在 `backend/` 目录下建立标准 Go 工程结构：
- `cmd/server/main.go` — 入口
- `internal/config/` — 配置加载（环境变量 + 默认值）
- `internal/protocol/` — RealtimeMessage 协议类型 + type 分发
- `internal/risk/` — assess_command_risk 风险评估
- `internal/models/` — 数据模型 struct
- `internal/db/` — PostgreSQL 连接 + 查询函数
- `internal/auth/` — JWT 签发/校验 + argon2 密码哈希
- `internal/routes/` — HTTP 路由（auth/devices/meta/workspace）
- `internal/ws/` — WebSocket 处理（dispatch/desktop/mobile）
- `internal/state/` — AppState（连接管理 + 互斥锁）
- `migrations/` — 7 个 SQL 文件（从 crates/server/migrations/ 复制）
- `go.mod` / `go.sum`
- `Dockerfile`

#### Scenario: 工程可构建
- **WHEN** 开发者在 `backend/` 目录执行 `go build ./cmd/server`
- **THEN** 生成可执行二进制，无编译错误

#### Scenario: 依赖管理
- **WHEN** 执行 `go mod tidy`
- **THEN** 生成 `go.mod` 和 `go.sum`，依赖列表最小化

### Requirement: 协议层完整移植

系统 SHALL 在 `internal/protocol/` 中完整复刻 `crates/shared/src/lib.rs` 的所有协议类型：
- `RealtimeMessage` 作为带 `Type string` 字段的 base struct
- 每个消息类型对应一个具体 struct（DesktopHeartbeat / ProvidersSnapshot / ProjectsSnapshot / AiSessionsSnapshot / AiSessionCreate / AiMessageSend / AiMessageDelta / AiMessageDone / AiHistoryRequest / AiHistoryResponse / AiChatOutput / AiSessionArchive / GitStatusSnapshot）
- 提供 `ParseMessage(data []byte) (Message, error)` 函数，根据 type 字段分发解码
- 提供 `MarshalMessage(msg Message) ([]byte, error)` 函数

#### Scenario: 消息往返
- **WHEN** 桌面端发送一条 `ai.message.delta` JSON
- **THEN** Go 后端能正确解析 type 字段并分发到对应 handler
- **AND** 转发给移动端后字段名和结构与原 Rust 版本完全一致（camelCase）

### Requirement: 风险评估移植

系统 SHALL 在 `internal/risk/` 中复刻 `assess_command_risk` 的 15 条规则：
- `rm -rf` / `sudo rm` / `mkfs` / `shutdown` / `.ssh` / `api_key` 等
- 返回 `{ risky: bool, reason: string, category: string }` 结构

#### Scenario: 高危命令识别
- **WHEN** 输入 `rm -rf /`
- **THEN** 返回 `risky: true`，category 为对应分类

### Requirement: HTTP API 等价

系统 SHALL 提供与原 Rust 后端完全等价的 HTTP 路由：
- `GET /health`
- `POST /auth/register`
- `POST /auth/login`
- `POST /pairing/codes`
- `POST /desktop/pairing-requests`
- `GET /desktop/pairing-requests/{code}`
- `POST /desktop/pairing-requests/{code}/approve`
- `POST /desktop/pair`
- `GET /providers`
- `GET /devices`
- `GET /devices/{deviceId}`
- `GET /devices/{deviceId}/sessions`
- `GET /devices/{deviceId}/providers`
- `GET /devices/{deviceId}/projects` + `POST`
- `GET /devices/{deviceId}/ai-sessions` + `POST`
- `GET /ai-sessions/{sessionId}`
- `GET /activity-logs`
- `GET /settings` + `PUT`
- `GET /ws/mobile`
- `GET /ws/desktop`

#### Scenario: 路由路径一致
- **WHEN** 桌面端调用 `POST /desktop/pairing-requests`
- **THEN** Go 后端返回与 Rust 版本相同的 JSON 结构

#### Scenario: 认证中间件
- **WHEN** 未携带 JWT 的请求访问需要认证的路由
- **THEN** 返回 401 Unauthorized

### Requirement: WebSocket 连接管理

系统 SHALL 在 `internal/ws/` 中实现与原 Rust 等价的 WebSocket 处理：
- `AppState` 持有 `mobiles map[UUID]map[UUID]*MobileConnection` 和 `desktops map[UUID]*DesktopConnection`
- 用 `sync.RWMutex` 保护并发访问
- desktop connection 接收消息并转发给绑定的 mobile connection
- mobile connection 接收消息并转发给绑定的 desktop connection
- 处理 `ai.session.create` / `ai.message.send` / `ai.history.request` / `ai.session.archive` 四类移动端消息
- `ai.message.send` 经 `assess_command_risk` 风险拦截
- 断线时清理连接并通知对端

#### Scenario: 桌面→移动透传
- **WHEN** 桌面端发送 `ai.message.delta`
- **THEN** 后端找到该桌面绑定的所有 mobile connection 并转发
- **AND** 消息内容不被修改

#### Scenario: 风险命令拦截
- **WHEN** 移动端发送 `ai.message.send` 且 content 为 `rm -rf /` 且 confirmedRisk 为 false
- **THEN** 后端返回 `ai.message.done` with status "failed"，不转发给桌面端

### Requirement: 数据库与迁移

系统 SHALL：
- 使用 `jackc/pgx/v5` 连接 PostgreSQL
- 启动时自动执行 `migrations/` 下的 7 个 SQL 文件（按文件名顺序）
- 提供 upsert / query 辅助函数对应原 `crates/server/src/db.rs` 的所有函数

#### Scenario: 自动迁移
- **WHEN** 首次启动 Go 后端
- **THEN** 7 个迁移文件按顺序执行，所有表创建成功

### Requirement: 认证模块

系统 SHALL：
- 用 `golang-jwt/jwt/v5` 签发 access_token（12h）和 refresh_token（30d）
- 桌面配对 token 有效期 180d
- 用 `golang.org/x/crypto/argon2` 做密码哈希（参数与 Rust 版本一致）
- JWT payload 含 `sub`（user id）、`deviceId`（桌面配对时）、`exp`

#### Scenario: 登录成功
- **WHEN** 用户用正确密码登录
- **THEN** 返回 `{ accessToken, refreshToken }`，结构与 Rust 版本一致

### Requirement: 单二进制部署

系统 SHALL 生成单一静态二进制，包含所有依赖：
- `go build -o ai-workbench-server ./cmd/server`
- 支持 `GOOS=linux GOARCH=amd64` 交叉编译
- 配置通过环境变量传入（DATABASE_URL / JWT_SECRET / PORT 等）

#### Scenario: 交叉编译
- **WHEN** 在 CI 中执行 `GOOS=linux GOARCH=amd64 go build`
- **THEN** 生成可在 Linux 服务器直接运行的二进制

## REMOVED Requirements

### Requirement: Rust 后端工程

**Reason**: 整个后端用 Go 重写，Rust 工程不再需要
**Migration**:
- 删除 `crates/server/`、`crates/shared/`
- 删除根 `Cargo.toml` 和 `Cargo.lock`
- 7 个迁移 SQL 文件移到 `backend/migrations/`
- 桌面端 `apps/desktop/src/main/sync.ts` 中如果有 `import type` 引用 `crates/shared` 的类型，改为从 `apps/desktop/src/services/tauri.ts`（已删除）或本地定义
- 移动端无 Rust 依赖，无需改动
