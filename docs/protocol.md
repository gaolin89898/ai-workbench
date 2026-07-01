# AI 工作台实时协议

所有 WebSocket 消息都是 JSON 对象，并使用 `type` 字段区分消息类型。

移动端连接：

```text
/ws/mobile?token=<accessToken>
```

桌面端连接：

```text
/ws/desktop?token=<desktopAccessToken>
```

## AI 工作台主协议

### 桌面心跳

桌面端连接后上报心跳。服务端会把设备标记为在线，并通知同账号移动端。

```json
{
  "type": "desktop.heartbeat",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "timestamp": "2026-05-26T00:00:00Z"
}
```

### Provider 状态快照

桌面端检测本机 AI CLI 后上报。云端只保存安装状态、版本和登录状态，不保存本机密钥。

```json
{
  "type": "providers.snapshot",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "providers": [
    {
      "providerId": "codex",
      "installed": true,
      "version": "codex 0.1.0",
      "authStatus": "unknown",
      "lastCheckedAt": "2026-05-26T00:00:00Z"
    }
  ]
}
```

### 项目快照

桌面端上报项目元信息和 Git 摘要。v1 只同步 branch、dirty 状态和路径，不同步完整 diff。

```json
{
  "type": "projects.snapshot",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "projects": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "deviceId": "00000000-0000-0000-0000-000000000000",
      "name": "my-app",
      "path": "/home/gl/my-app",
      "gitBranch": "main",
      "gitDirty": true,
      "updatedAt": "2026-05-26T00:00:00Z"
    }
  ]
}
```

### AI 会话快照

桌面端上报 AI 会话元信息。完整聊天历史不在云端保存。

```json
{
  "type": "ai.sessions.snapshot",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "sessions": [
    {
      "id": "22222222-2222-2222-2222-222222222222",
      "userId": "33333333-3333-3333-3333-333333333333",
      "deviceId": "00000000-0000-0000-0000-000000000000",
      "projectId": "11111111-1111-1111-1111-111111111111",
      "providerId": "codex",
      "terminalSessionId": "tmux:ai-codex-22222222",
      "title": "检查登录模块",
      "status": "running",
      "summary": "正在分析项目结构",
      "updatedAt": "2026-05-26T00:00:00Z"
    }
  ]
}
```

### 创建 AI 会话

移动端通过 HTTP `POST /devices/:deviceId/ai-sessions` 创建元信息。服务端校验设备归属后，向在线桌面端转发以下 WebSocket 消息。

```json
{
  "type": "ai.session.create",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "requestId": "44444444-4444-4444-8444-444444444444",
  "providerId": "codex",
  "projectId": "11111111-1111-1111-1111-111111111111",
  "projectPath": "/home/gl/my-app",
  "title": "检查登录模块",
  "creationMode": "auto",
  "terminalSessionId": null
}
```

`creationMode`：

- `auto`：桌面端自动创建 tmux 会话并启动 Provider CLI。
- `attach`：桌面端接管已有 tmux/screen 会话。

### 发送 AI 消息

移动端发送 prompt。服务端会校验账号、设备和会话归属，并执行高危内容检测。

```json
{
  "type": "ai.message.send",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "content": "帮我检查这个项目的登录流程",
  "confirmedRisk": false
}
```

桌面端收到后负责：

- 把用户消息写入本机 SQLite。
- 把文本发送到底层 AI CLI。
- 捕获 AI 输出并写入本机 SQLite。
- 通过云端推送增量输出。

### AI 输出增量

```json
{
  "type": "ai.message.delta",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "content": "我先查看项目结构...\n",
  "sequence": 1024
}
```

### 结构化 AI 输出

桌面端可以用 `ai.chat.output` 推送结构化执行过程。移动端和桌面端本地 UI 都会把 `segment` / `segments` 渲染为状态、工具调用、审批卡片、错误或最终文本。

```json
{
  "type": "ai.chat.output",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "kind": "step-start",
  "text": "正在执行命令",
  "stepId": "tool-1",
  "segment": {
    "type": "tool",
    "stepId": "tool-1",
    "toolName": "shell",
    "command": "pnpm run build",
    "status": "running"
  },
  "segments": []
}
```

常见 `kind`：

- `status`：运行状态更新。
- `step-start` / `step-update`：工具调用或审批状态变化。
- `delta`：文本增量。
- `done`：本轮完成。
- `error`：本轮失败。

常见 `segment.type`：

- `text`
- `status`
- `thought`
- `tool`
- `approval`
- `error`

### 审批响应

当 Codex 请求执行命令或应用文件修改时，桌面端会通过 `ai.chat.output` 推送 `approval` segment。移动端或桌面端用户选择后，通过 `ai.approval.respond` 返回一次性审批结果。

```json
{
  "type": "ai.approval.respond",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "approvalId": "approval-1",
  "decision": "approved"
}
```

`decision` 目前只接受：

- `approved`
- `denied`

服务端会校验账号、设备和会话归属，然后把消息转发给在线桌面端；真正响应 Codex 审批的是桌面端本地进程。

### AI 输出结束

```json
{
  "type": "ai.message.done",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "status": "idle",
  "summary": "已完成登录流程检查"
}
```

### 归档 / 恢复 AI 会话

移动端可请求归档或恢复某个 AI 会话。服务端只校验归属并转发给桌面端，桌面端更新本机 SQLite 后再通过快照同步给移动端。

```json
{
  "type": "ai.session.archive",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "archived": true
}
```

### 重命名 AI 会话

HTTP `PATCH /ai-sessions/:sessionId` 持久化云端标题后，会向桌面端转发 `ai.session.rename`，让本机 SQLite 的标题保持一致。

```json
{
  "type": "ai.session.rename",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "title": "检查登录模块"
}
```

### 拉取本地历史

移动端打开聊天页时向桌面端请求历史。云端只转发，不落库保存完整内容。

```json
{
  "type": "ai.history.request",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "requestId": "55555555-5555-4555-8555-555555555555"
}
```

桌面端从本机 SQLite 返回：

```json
{
  "type": "ai.history.response",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "requestId": "55555555-5555-4555-8555-555555555555",
  "messages": [
    {
      "role": "user",
      "content": "帮我检查这个项目的登录流程",
      "createdAt": "2026-05-26T00:00:00Z"
    },
    {
      "role": "assistant",
      "content": "我先查看项目结构...",
      "createdAt": "2026-05-26T00:00:02Z"
    }
  ]
}
```

### Git 状态快照

```json
{
  "type": "git.status.snapshot",
  "snapshot": {
    "deviceId": "00000000-0000-0000-0000-000000000000",
    "projectId": "11111111-1111-1111-1111-111111111111",
    "branch": "main",
    "dirty": true,
    "files": [
      " M apps/mobile/lib/main.dart",
      "?? docs/protocol.md"
    ]
  }
}
```
