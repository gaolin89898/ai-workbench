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

桌面端可以用 `ai.chat.output` 推送结构化执行过程。这个消息仍用于非 Codex provider 和旧历史兼容。Codex 新会话优先使用下面的 `ai.trace.update`，避免移动端和桌面端各自重新合并 `process/final/delta`。

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

### Provider 执行记录

Codex 执行过程按 provider trace 单独同步。统一会话外壳仍由 `ai.sessions.snapshot`、`ai.history.response.messages` 和本地消息历史负责；Codex 的执行过程由 `ai.trace.update` 和 `ai.history.response.trace` 负责。

产品展示固定为：

```text
用户问题

执行过程
  trace.segments / trace.snapshot.items

最终回答
  trace.finalText / trace.snapshot.finalText
```

运行中桌面端推送：

```json
{
  "type": "ai.trace.update",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "trace": {
    "aiSessionId": "22222222-2222-2222-2222-222222222222",
    "providerId": "codex",
    "traceKind": "codex",
    "status": "running",
    "finalText": "",
    "snapshot": {
      "provider": "codex",
      "status": "running",
      "threadId": "thread_abc",
      "turnId": "turn_abc",
      "startedAt": "2026-07-03T06:00:00Z",
      "updatedAt": "2026-07-03T06:00:02Z",
      "completedAt": null,
      "items": [
        {
          "id": "reasoning-1",
          "type": "thinking",
          "title": "正在思考",
          "status": "running",
          "text": "",
          "startedAt": "2026-07-03T06:00:01Z",
          "completedAt": null,
          "rawItemType": "reasoning"
        }
      ],
      "approvals": [],
      "errors": [],
      "finalText": ""
    },
    "segments": [
      {
        "type": "status",
        "stepId": "runtime-status",
        "label": "Codex 正在执行",
        "icon": "think"
      },
      {
        "type": "status",
        "stepId": "reasoning-1",
        "label": "正在思考",
        "icon": "think"
      }
    ]
  }
}
```

完成后同一条 trace 更新为：

```json
{
  "type": "ai.trace.update",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "aiSessionId": "22222222-2222-2222-2222-222222222222",
  "trace": {
    "aiSessionId": "22222222-2222-2222-2222-222222222222",
    "providerId": "codex",
    "traceKind": "codex",
    "status": "completed",
    "finalText": "已完成修改。",
    "snapshot": {
      "provider": "codex",
      "status": "completed",
      "items": [],
      "approvals": [],
      "errors": [],
      "finalText": "已完成修改。",
      "updatedAt": "2026-07-03T06:00:10Z",
      "completedAt": "2026-07-03T06:00:10Z"
    },
    "segments": [
      {
        "type": "status",
        "stepId": "final-summary",
        "label": "已处理"
      }
    ]
  }
}
```

移动端处理规则：

- `ai.trace.update` 不追加第二条 assistant 消息，只替换当前会话最后一个 assistant 外壳。
- `status: "running"` 时 assistant 保持 pending。
- `status: "completed" | "failed" | "canceled"` 时 assistant 结束 pending。
- 如果没有 trace，继续使用 `ai.chat.output` / 旧 `segments` 兼容路径。

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

### 应用更新通知

管理员在后台保存桌面端或移动端版本配置后，服务端会向对应平台的在线客户端广播 `app.update.available`。

客户端也可以通过 HTTP 主动检查：

```text
GET /app/releases?platform=desktop|mobile&currentVersion=<currentVersion>&os=win32|linux
```

WebSocket 消息示例：

```json
{
  "type": "app.update.available",
  "platform": "desktop",
  "currentVersion": "0.1.68",
  "latestVersion": "0.1.69",
  "minSupportedVersion": "0.1.69",
  "available": true,
  "required": true,
  "force": false,
  "downloadUrl": "https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.69/AI-Workbench-Setup.exe",
  "windowsDownloadUrl": "https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.69/AI-Workbench-Setup.exe",
  "linuxDownloadUrl": "https://github.com/gaolin89898/ai-workbench/releases/download/v0.1.69/AI-Workbench.AppImage",
  "releaseUrl": "https://github.com/gaolin89898/ai-workbench/releases/tag/v0.1.69",
  "releaseNotes": "修复登录和更新提示",
  "source": "manual"
}
```

字段含义：

- `platform`：`desktop` 或 `mobile`。
- `latestVersion`：后台配置或 GitHub Releases 检测到的最新版本。
- `minSupportedVersion`：最低可用版本，低于该版本表示当前客户端不兼容，需要更新。
- `available`：当前版本低于最新版本。
- `required`：当前版本必须更新。低于最低可用版本时为 true；后台启用强制更新且当前版本落后时也为 true。
- `force`：后台是否启用强制更新提示。
- `downloadUrl`：当前客户端系统对应的下载地址；移动端为 APK，桌面端会按系统返回 Windows 或 Linux 地址。
- `windowsDownloadUrl`：桌面端 Windows 安装包下载地址。
- `linuxDownloadUrl`：桌面端 Linux 安装包下载地址。
- `releaseUrl`：Release 页面地址。
- `releaseNotes`：展示给用户的更新说明。
- `source`：`manual` 表示后台配置，`github` 表示 GitHub Releases 兜底。

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
  ],
  "trace": {
    "aiSessionId": "22222222-2222-2222-2222-222222222222",
    "providerId": "codex",
    "traceKind": "codex",
    "status": "completed",
    "finalText": "登录流程检查完成。",
    "snapshot": {
      "provider": "codex",
      "status": "completed",
      "items": [],
      "approvals": [],
      "errors": [],
      "finalText": "登录流程检查完成。",
      "updatedAt": "2026-05-26T00:00:10Z"
    },
    "segments": [
      {
        "type": "status",
        "stepId": "final-summary",
        "label": "已处理"
      }
    ]
  }
}
```

`trace` 是可选字段。只有桌面端本地存在 provider trace 时返回；没有 trace 的旧会话或非 Codex 会话继续只返回 `messages`。

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
