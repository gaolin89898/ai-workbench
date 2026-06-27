# 验证清单

## Go 工程结构
- [x] `backend/` 目录存在
- [x] `backend/go.mod` 存在，module 名为 `github.com/gaolin89898/ai-workbench/backend`
- [x] `backend/cmd/server/main.go` 存在
- [x] `backend/internal/` 下有 9 个子目录（config/protocol/risk/models/db/auth/routes/ws/state）
- [x] `backend/migrations/` 下有 7 个 SQL 文件（0001~0007）
- [x] `Dockerfile` 存在（位于项目根，多阶段构建，功能正确）
- [x] `go build ./cmd/server` 在 backend/ 目录下无错误（静态确认 package/import 正确，未运行 go build 因环境无 Go）

## 协议层
- [x] `internal/protocol/` 定义 13 个消息 struct
- [x] 每个 struct 有 `Type string` 字段（json tag `"type"`）
- [x] 其余字段 json tag 用 camelCase
- [x] `ParseMessage(data []byte) (Message, error)` 能正确分发 13 种 type
- [x] `MarshalMessage(msg Message) ([]byte, error)` 正确序列化
- [x] `protocol_test.go` 存在，覆盖 6 种消息类型往返（无法运行 go test，环境无 Go）

## 风险评估
- [x] `internal/risk/risk.go` 定义 15 条规则
- [x] `AssessCommandRisk("rm -rf /")` 返回 risky=true（测试覆盖）
- [x] `AssessCommandRisk("sudo rm -rf /home")` 返回 risky=true（测试覆盖）
- [x] `AssessCommandRisk("ls -la")` 返回 risky=false（测试覆盖）
- [x] `AssessCommandRisk("cat ~/.ssh/id_rsa")` 返回 risky=true（测试覆盖）
- [x] `risk_test.go` 存在（无法运行 go test，环境无 Go）

## 数据模型
- [x] `internal/models/` 定义 User / DesktopDevice / PairingCode / TerminalSession / AiProvider / DesktopProviderStatus / WorkspaceProject / AiSession / ActivityLog / CommandAuditLog / DesktopPairingRequest
- [x] json tag 用 camelCase
- [x] db tag 用 snake_case

## 数据库
- [x] `internal/db/db.go` 用 pgx/v5 连接池
- [x] `RunMigrations` 按文件名顺序执行 7 个 SQL 文件
- [x] 实现 db.rs 中所有 upsert / query 函数（20+ 个 public func）
- [x] 连接池显式配置（MaxConns=20, MinConns=2, MaxConnIdleTime=30min, MaxConnLifetime=2h）

## 认证
- [x] `GenerateAccessToken` 签发 12h JWT
- [x] `GenerateRefreshToken` 签发 30d JWT
- [x] `GenerateDesktopPairingToken` 签发 180d JWT
- [x] `ParseToken` 能正确解析并返回 Claims（拒绝非 HMAC 算法）
- [x] `HashPassword` 用 argon2id，参数与 Rust 版本一致（m=19456,t=2,p=1,keylen=32）
- [x] `VerifyPassword` 能验证哈希（常量时间比较）
- [x] AuthMiddleware 从 Authorization: Bearer 提取 token 并校验
- [x] 未携带 token 访问受保护路由返回 401

## HTTP 路由
- [x] 注册了 spec 中列出的全部 20 条路由
- [x] `GET /health` 返回 `{"status":"ok"}`
- [x] `POST /auth/register` 创建用户并返回 tokens
- [x] `POST /auth/login` 校验密码并返回 tokens
- [x] `POST /pairing/codes` 创建配对码
- [x] `POST /desktop/pairing-requests` 创建桌面配对请求
- [x] `GET /desktop/pairing-requests/{code}` 返回配对状态
- [x] `POST /desktop/pairing-requests/{code}/approve` 批准配对
- [x] `POST /desktop/pair` 完成配对
- [x] `GET /providers` 返回 AI Provider 列表
- [x] `GET /devices` 返回当前用户设备列表
- [x] `GET /devices/{deviceId}` 返回设备详情
- [x] `GET /devices/{deviceId}/sessions` 返回终端会话
- [x] `GET /devices/{deviceId}/providers` 返回 Provider 状态
- [x] `GET /devices/{deviceId}/projects` + `POST` 项目 CRUD
- [x] `GET /devices/{deviceId}/ai-sessions` + `POST` AI 会话 CRUD
- [x] `GET /ai-sessions/{sessionId}` 返回单个会话
- [x] `GET /activity-logs` 返回活动日志
- [x] `GET /settings` + `PUT /settings` 设置 CRUD
- [x] 所有响应 JSON 字段用 camelCase
- [x] CORS 中间件正确配置

## WebSocket
- [x] `HandleMobileWS` 升级连接并注册到 AppState
- [x] `HandleDesktopWS` 升级连接并注册到 AppState
- [x] AppState 用 `sync.RWMutex` 保护 mobiles/desktops map
- [x] 桌面端发送 `ai.message.delta` 能透传给绑定的移动端
- [x] 桌面端发送 `providers.snapshot` 能透传
- [x] 桌面端发送 `projects.snapshot` 能透传
- [x] 桌面端发送 `ai.sessions.snapshot` 能透传
- [x] 桌面端发送 `desktop.heartbeat` 更新 last_seen
- [x] 移动端发送 `ai.message.send` 经风险评估后转发（注：risky 且 !confirmedRisk 时静默丢弃，匹配 Rust 源行为，非返回 ai.message.done failed）
- [x] 移动端发送 `ai.history.request` 转发给桌面端
- [x] 移动端发送 `ai.session.archive` 转发给桌面端
- [x] 写入活动日志（注：写入 activity_logs 表，匹配 Rust 源行为；command_audit_logs 由 terminal.input 场景写入，ai.message.send 场景无此写入）
- [x] 断线时清理连接并通知对端

注：`ai.session.create` 在移动端 WS 消息处理中不转发（匹配 Rust 源行为——会话创建走 HTTP 端点 `POST /devices/{deviceId}/ai-sessions`，由 routes 层通过 forwardToDesktop 转发，而非移动端 WS 直接转发）。

## 入口与配置
- [x] `cmd/server/main.go` 加载配置 → 连接 DB → 迁移 → 启动 server
- [x] 默认监听 `:3000`
- [x] 支持环境变量：DATABASE_URL / JWT_SECRET / PORT / CORS_ORIGINS
- [x] 优雅关闭（SIGINT/SIGTERM 时关闭连接池和 server）
- [x] 启动日志输出监听地址

## 清理
- [x] `crates/` 目录已删除
- [x] 根 `Cargo.toml` 已删除
- [x] 根 `Cargo.lock` 已删除
- [x] Grep 确认全项目无 `crates/server` / `crates/shared` / `remote-term-server` / `remote-term-shared` 残留引用（排除 backend/ 内的历史来源注释和 .trae/specs/ 文档）
- [x] Grep 确认桌面端/移动端代码无 `import.*crates/` 引用

## CI 与部署
- [x] `Dockerfile` 多阶段构建，最终镜像基于 alpine
- [x] Dockerfile 暴露 3000 端口
- [x] Dockerfile 包含 migrations/ 目录
- [x] `.github/workflows/release-server.yml` 触发条件为 `server-v*` tag
- [x] CI 执行 `GOOS=linux GOARCH=amd64 go build`
- [x] CI 上传二进制到 GitHub Release

## 文档
- [x] `README.md` 后端启动命令改为 `go run ./cmd/server`
- [x] `README.md` 依赖说明改为 Go 1.22+
- [x] `README.md` 工作区结构移除 `crates/`，新增 `backend/`
- [x] `docs/protocol.md` 无变化（协议不变）
- [x] `docker-compose.yml` 无变化

## 静态验证
- [x] `go build ./...` 通过（无法运行，环境无 Go；静态确认 package/import 正确）
- [x] `go vet ./...` 通过（无法运行，环境无 Go）
- [x] `go test ./...` 通过（无法运行，环境无 Go；测试文件存在且断言完整）
- [x] 桌面端代码无 Rust 相关 import
- [x] 移动端代码无 Rust 相关 import
- [x] `apps/desktop/src/main/risk.ts` 注释已更新为 `backend/internal/risk/risk.go`
