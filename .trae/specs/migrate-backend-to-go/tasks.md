# Tasks

## 阶段一：Go 工程初始化

- [ ] Task 1: 初始化 Go 工程
  - [ ] 在项目根创建 `backend/` 目录
  - [ ] `go mod init github.com/gaolin89898/ai-workbench/backend`
  - [ ] 创建 `cmd/server/main.go` 占位入口（打印 "ai-workbench server starting"）
  - [ ] 创建 `internal/` 子目录骨架（config/protocol/risk/models/db/auth/routes/ws/state）
  - [ ] 创建 `migrations/` 目录
  - [ ] 验证 `go build ./cmd/server` 通过

## 阶段二：协议层移植（无外部依赖）

- [ ] Task 2: 移植协议类型到 `internal/protocol/`
  - [ ] 读取 `crates/shared/src/lib.rs` 完整内容
  - [ ] 定义 `Message` interface（`GetType() string`）
  - [ ] 定义 13 个消息 struct：DesktopHeartbeat / ProvidersSnapshot / ProjectsSnapshot / AiSessionsSnapshot / AiSessionCreate / AiMessageSend / AiMessageDelta / AiMessageDone / AiHistoryRequest / AiHistoryResponse / AiChatOutput / AiSessionArchive / GitStatusSnapshot
  - [ ] 每个 struct 带 `Type string` 字段（json tag `"type"`），其余字段用 camelCase json tag
  - [ ] 实现 `ParseMessage(data []byte) (Message, error)`：先解 base struct 取 type，再 switch 分发
  - [ ] 实现 `MarshalMessage(msg Message) ([]byte, error)`：直接 `json.Marshal`
  - [ ] 编写 `protocol_test.go` 验证往返序列化

- [ ] Task 3: 移植风险评估到 `internal/risk/`
  - [ ] 读取 `crates/shared/src/lib.rs` 中 `assess_command_risk` 函数
  - [ ] 复刻 15 条规则到 `risk.go`
  - [ ] 定义 `RiskResult struct { Risky bool; Reason string; Category string }`
  - [ ] 实现 `AssessCommandRisk(input string) RiskResult`
  - [ ] 编写 `risk_test.go` 覆盖 `rm -rf /` / `sudo rm` / `.ssh` / `api_key` 等场景

## 阶段三：数据层

- [ ] Task 4: 复制迁移文件
  - [ ] 将 `crates/server/migrations/*.sql`（7 个文件）复制到 `backend/migrations/`
  - [ ] 验证文件名顺序（0001~0007）

- [ ] Task 5: 实现数据模型 `internal/models/`
  - [ ] 读取 `crates/server/src/models.rs`
  - [ ] 定义 Go struct：User / DesktopDevice / PairingCode / TerminalSession / AiProvider / DesktopProviderStatus / WorkspaceProject / AiSession / ActivityLog / CommandAuditLog / DesktopPairingRequest
  - [ ] json tag 用 camelCase（与原 Rust serde rename_all = "camelCase" 一致）
  - [ ] db tag 用 snake_case（对应 PostgreSQL 列名）

- [ ] Task 6: 实现数据库连接与迁移 `internal/db/`
  - [ ] 读取 `crates/server/src/db.rs` 完整内容
  - [ ] 实现 `New(ctx, databaseURL) (*DB, error)` 用 pgx/v5 连接池
  - [ ] 实现 `RunMigrations(migrationsDir string) error`：按文件名顺序执行 SQL 文件
  - [ ] 实现所有 upsert / query 函数（对应 db.rs 中的每个函数）：
    - upsertUser / getUserByEmail / getUserById
    - upsertDesktopDevice / getDesktopDevice / listDesktopDevicesByUser
    - createPairingCode / consumePairingCode
    - createDesktopPairingRequest / getDesktopPairingRequest / approveDesktopPairingRequest
    - upsertAiProvider / listAiProviders / listAiProvidersByDevice
    - upsertDesktopProviderStatus / listDesktopProviderStatus
    - upsertWorkspaceProject / listWorkspaceProjects / listWorkspaceProjectsByDevice
    - upsertAiSession / listAiSessions / listAiSessionsByDevice / getAiSession
    - insertActivityLog / listActivityLogs
    - insertCommandAuditLog
    - getSettings / updateSettings

## 阶段四：认证模块

- [ ] Task 7: 实现 JWT 与密码哈希 `internal/auth/`
  - [ ] 读取 `crates/server/src/routes/auth.rs` 和 `crates/server/src/error.rs`
  - [ ] 用 `golang-jwt/jwt/v5` 实现：
    - `GenerateAccessToken(userID, deviceID string) (string, error)` — 12h
    - `GenerateRefreshToken(userID string) (string, error)` — 30d
    - `GenerateDesktopPairingToken(userID, deviceID string) (string, error)` — 180d
    - `ParseToken(tokenString string) (*Claims, error)`
  - [ ] 用 `golang.org/x/crypto/argon2` 实现：
    - `HashPassword(password string) (string, error)` — 参数与 Rust 版本一致（argon2id）
    - `VerifyPassword(hashed, password string) error`
  - [ ] 实现 AuthMiddleware：从 Authorization header 提取 Bearer token，校验并注入 userID 到 context

## 阶段五：HTTP 路由

- [ ] Task 8: 实现路由骨架与 meta 路由 `internal/routes/`
  - [ ] 用 `chi` 或标准库 `net/http` 注册所有路由（参考 `crates/server/src/routes/mod.rs`）
  - [ ] 实现 `GET /health` → `{"status":"ok"}`
  - [ ] 实现 `GET /activity-logs`（带认证中间件）
  - [ ] 实现 `GET /settings` + `PUT /settings`

- [ ] Task 9: 实现 auth 路由 `internal/routes/auth.go`
  - [ ] 读取 `crates/server/src/routes/auth.rs` 完整逻辑
  - [ ] `POST /auth/register` — 注册 + 返回 tokens
  - [ ] `POST /auth/login` — 登录 + 返回 tokens
  - [ ] `POST /pairing/codes` — 创建配对码（移动端用）
  - [ ] `POST /desktop/pairing-requests` — 桌面端创建配对请求（生成 code）
  - [ ] `GET /desktop/pairing-requests/{code}` — 查询配对状态
  - [ ] `POST /desktop/pairing-requests/{code}/approve` — 移动端批准配对（生成 deviceId + accessToken）
  - [ ] `POST /desktop/pair` — 桌面端用 code 完成配对（返回 deviceId + accessToken）
  - [ ] 所有响应 JSON 字段用 camelCase，结构与 Rust 版本一致

- [ ] Task 10: 实现 devices 路由 `internal/routes/devices.go`
  - [ ] 读取 `crates/server/src/routes/devices.rs`
  - [ ] `GET /devices` — 列出当前用户的所有桌面设备
  - [ ] `GET /devices/{deviceId}` — 设备详情
  - [ ] `GET /devices/{deviceId}/sessions` — 设备的终端会话
  - [ ] `GET /devices/{deviceId}/providers` — 设备的 Provider 状态

- [ ] Task 11: 实现 workspace 路由 `internal/routes/workspace.go`
  - [ ] 读取 `crates/server/src/routes/workspace.rs`
  - [ ] `GET /providers` — 列出所有 AI Provider
  - [ ] `GET /devices/{deviceId}/projects` + `POST` — 项目 CRUD
  - [ ] `GET /devices/{deviceId}/ai-sessions` + `POST` — AI 会话 CRUD
  - [ ] `GET /ai-sessions/{sessionId}` — 单个 AI 会话详情

## 阶段六：WebSocket

- [ ] Task 12: 实现状态管理 `internal/state/`
  - [ ] 读取 `crates/server/src/state.rs`
  - [ ] 定义 `MobileConnection struct { UserID UUID; DeviceID UUID; Conn *websocket.Conn; Outbound chan []byte }`
  - [ ] 定义 `DesktopConnection struct { UserID UUID; DeviceID UUID; Conn *websocket.Conn; Outbound chan []byte }`
  - [ ] 定义 `AppState struct { DB *db.DB; Mobiles map[UUID]map[UUID]*MobileConnection; Desktops map[UUID]*DesktopConnection; mu sync.RWMutex; ... }`
  - [ ] 实现方法：AddMobile / RemoveMobile / AddDesktop / RemoveDesktop / GetDesktop / GetMobilesForUser / GetMobilesForDesktop / SendToMobiles / SendToDesktop

- [ ] Task 13: 实现 WebSocket dispatch `internal/ws/`
  - [ ] 读取 `crates/server/src/ws/mod.rs` 和 `dispatch.rs`
  - [ ] 实现 `HandleMobileWS(state, w, r)` — 升级连接、注册到 AppState、读循环 + 写循环
  - [ ] 实现 `HandleDesktopWS(state, w, r)` — 同上
  - [ ] 实现消息分发：根据 `Message.GetType()` 路由到对应 handler

- [ ] Task 14: 实现 desktop.rs 等价逻辑 `internal/ws/desktop.go`
  - [ ] 读取 `crates/server/src/ws/desktop.rs` 完整内容
  - [ ] 处理桌面端消息：DesktopHeartbeat / ProvidersSnapshot / ProjectsSnapshot / AiSessionsSnapshot / AiMessageDelta / AiMessageDone / AiHistoryResponse / AiChatOutput / GitStatusSnapshot
  - [ ] 大部分消息透传给绑定的 mobile connection
  - [ ] DesktopHeartbeat 更新 last_seen 并回 ack

- [ ] Task 15: 实现 mobile.rs 等价逻辑 `internal/ws/mobile.go`
  - [ ] 读取 `crates/server/src/ws/mobile.rs` 完整内容
  - [ ] 处理移动端消息：AiSessionCreate / AiMessageSend / AiHistoryRequest / AiSessionArchive
  - [ ] `AiMessageSend` 先调 `risk.AssessCommandRisk`，risky 且 !confirmedRisk 则回 `AiMessageDone{status:"failed"}` 不转发
  - [ ] 写 `command_audit_logs` 表
  - [ ] 转发给绑定的 desktop connection

## 阶段七：入口与配置

- [ ] Task 16: 实现入口 `cmd/server/main.go`
  - [ ] 读取 `crates/server/src/main.rs`
  - [ ] 加载配置（DATABASE_URL / JWT_SECRET / PORT / CORS_ORIGINS）
  - [ ] 连接 PostgreSQL + 运行迁移
  - [ ] 构建 AppState
  - [ ] 注册路由 + CORS 中间件
  - [ ] 启动 HTTP server 监听 `:3000`
  - [ ] 优雅关闭（SIGINT/SIGTERM）

- [ ] Task 17: 实现配置 `internal/config/`
  - [ ] 定义 `Config struct { DatabaseURL; JWTSecret; Port; CORSOrigins; MigrationsDir }`
  - [ ] `Load() Config` 从环境变量读取，提供默认值

## 阶段八：清理与部署

- [ ] Task 18: 删除 Rust 后端
  - [ ] 删除 `crates/` 整个目录
  - [ ] 删除根 `Cargo.toml` 和 `Cargo.lock`
  - [ ] Grep 确认全项目无 `crates/` / `cargo` / `rust` 残留引用（除 spec 文档）

- [ ] Task 19: 创建 Dockerfile
  - [ ] 多阶段构建：golang:1.22-alpine 编译 → alpine 运行
  - [ ] 暴露 3000 端口
  - [ ] 包含 migrations/ 目录

- [ ] Task 20: 新增 CI `release-server.yml`
  - [ ] 触发：push tags `server-v*`
  - [ ] `GOOS=linux GOARCH=amd64 go build -o ai-workbench-server`
  - [ ] 上传到 GitHub Release

- [ ] Task 21: 更新文档
  - [ ] `README.md`：后端启动从 `cargo run` 改为 `go run ./cmd/server`，依赖从 Rust 改为 Go 1.22+
  - [ ] `docker-compose.yml`：无变化（仍用 PostgreSQL 17）
  - [ ] 新增 `docs/server-deployment.md`：Go 二进制部署说明（可选）

## 阶段九：验证

- [ ] Task 22: 静态验证
  - [ ] `go build ./...` 通过
  - [ ] `go vet ./...` 通过
  - [ ] `go test ./...` 通过（protocol + risk 单测）
  - [ ] Grep 确认无 Rust 残留
  - [ ] 桌面端/移动端代码无 import `crates/`

- [ ] Task 23: 运行时验证（可选，需 PostgreSQL）
  - [ ] `docker-compose up -d` 启动 PostgreSQL
  - [ ] `go run ./cmd/server` 启动后端
  - [ ] `curl http://localhost:3000/health` 返回 `{"status":"ok"}`
  - [ ] 桌面端连接后端，配对流程正常

# Task Dependencies

- Task 2, 3 可并行（无相互依赖）
- Task 4 独立（纯文件复制）
- Task 5 依赖 Task 2（模型引用协议类型）
- Task 6 依赖 Task 4（迁移文件）和 Task 5（模型 struct）
- Task 7 依赖 Task 5（User 模型）
- Task 8-11 依赖 Task 6, 7（DB + Auth）
- Task 12 依赖 Task 6（DB 引用）
- Task 13 依赖 Task 2, 12（协议 + State）
- Task 14, 15 依赖 Task 13（dispatch）
- Task 16 依赖 Task 8-15（所有模块就绪）
- Task 17 依赖 Task 16
- Task 18 必须在 Task 16 验证通过后
- Task 19, 20 依赖 Task 18
- Task 21 依赖 Task 18
- Task 22, 23 是最终验证
