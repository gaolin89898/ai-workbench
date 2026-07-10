# MiMo Code 集成方案

## 1. 概述

本文档描述将 MiMo Code（`mimo` CLI）集成到 AI Workbench 桌面端的技术方案。MiMo Code 是小米 MiMo 团队开发的 AI 编程助手，支持多种运行模式。

> 当前实现（2026-07-10）：OpenCode 继续使用独立 ACP 传输；MiMo Code 已切换为本地 `mimo serve` HTTP/SSE 传输。桌面端监听 `permission.asked`，通过 `/permission/{requestID}/reply` 完成允许或拒绝，不再使用无法交互审批的 `mimo run --format json` 作为聊天主链路。

## 2. MiMo Code 运行模式分析

### 2.1 ACP 协议模式（`mimo acp`）

基于 JSON-RPC 2.0 的 Agent Client Protocol，通过 stdio 通信。

**初始化请求：**
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"AI Workbench","version":"0.1.0"}}}
```

**初始化响应：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "mcpCapabilities": {"http": true, "sse": true},
      "promptCapabilities": {"embeddedContext": true, "image": true},
      "sessionCapabilities": {"fork": {}, "list": {}, "resume": {}}
    },
    "authMethods": [...],
    "agentInfo": {"name": "OpenCode", "version": "0.1.0"}
  }
}
```

**已知方法：**
| 方法 | 说明 | 参数 |
|---|---|---|
| `initialize` | 初始化连接 | `protocolVersion`, `clientInfo` |
| `session/list` | 列出会话 | `{}` |
| `session/fork` | 分叉会话 | `sessionId`, `cwd` |
| `session/resume` | 恢复会话 | `sessionId`, `cwd` |

**问题：** 发送消息的方法名未确定（不同于 Codex 的 `turn/start`）。

### 2.2 CLI 流式模式（`mimo run --format json`）

一次性执行，输出流式 JSON 事件。与 Claude Code 的 `--output-format stream-json` 类似。

**命令：**
```bash
mimo run --format json "你的问题"
```

**输出事件类型：**
```json
{"type":"step_start","timestamp":1782985665390,"sessionID":"ses_xxx","part":{"id":"prt_xxx","type":"step-start"}}
{"type":"text","timestamp":1782985665934,"sessionID":"ses_xxx","part":{"id":"prt_xxx","type":"text","text":"回复内容","time":{"start":...,"end":...}}}
{"type":"step_finish","timestamp":1782985665944,"sessionID":"ses_xxx","part":{"id":"prt_xxx","type":"step-finish","reason":"stop","tokens":{"total":28345,"input":1703,"output":4},"cost":0.0008523114}}
```

**会话续接：**
```bash
mimo run --format json --session ses_xxx "继续对话"
```

### 2.3 HTTP 服务器模式（`mimo serve`）

启动无头 HTTP 服务器，支持远程访问。

```bash
mimo serve --port 4096
```

当前桌面端为每轮 MiMo 会话启动仅监听 `127.0.0.1` 的随机端口，使用：

- `GET /event`：订阅 SSE 工具、文本、状态和审批事件
- `POST /session/{id}/message`：发送消息并等待本轮结果
- `POST /permission/{requestID}/reply`：回复 `once` 或 `reject`
- `POST /session/{id}/abort`：停止当前执行并清理待审批

这种模式保留 MiMo 自己的权限规则，同时支持桌面端和移动端共用审批卡片。

## 3. 与 Codex app-server 协议对比

| 特性 | Codex app-server | MiMo Code (ACP) | MiMo Code (run) |
|---|---|---|---|
| 启动方式 | `codex app-server --stdio` | `mimo acp` | `mimo run --format json` |
| 通信协议 | JSON-RPC 2.0 | JSON-RPC 2.0 | 流式 JSON（逐行） |
| 初始化 | `initialize` | `initialize` (需 protocolVersion) | N/A |
| 会话管理 | `thread/start`, `thread/resume` | `session/fork`, `session/resume` | `--session` 参数 |
| 发送消息 | `turn/start` | 未知 | 命令行参数 |
| 审批机制 | 支持 | 未知 | 不支持 |
| 会话持久化 | threadId | sessionId | sessionID |
| 超时控制 | 30 分钟 | 未知 | 进程级 |

## 4. 推荐集成方案

### 方案 A：本地 HTTP/SSE 模式（当前实现）

使用 `mimo serve` 的会话、事件与 permission API。该方案支持会话续接、实时工具状态和交互审批，也是当前桌面端采用的实现。

### 方案 B：CLI 流式模式（历史方案）

参照 `claude.ts` 的实现，使用 `mimo run --format json` 作为集成方式。

**优势：**
- 与 Claude Code 集成方式一致，代码复用度高
- 流式输出，用户体验好
- 支持会话续接（`--session`）
- 实现简单，风险低

**劣势：**
- 无审批机制（一次性执行）
- 无增量流式文本（整段返回）

**实现步骤：**

1. **创建 `apps/desktop/src/main/mimo.ts`**

```typescript
// MiMo Code integration for the Electron main process.
// Spawns `mimo run --format json`, parses streaming JSON output,
// and emits AiChatOutputEvent to the renderer.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { RunAiChatRequest, AiChatOutputEvent } from "../services/desktop";

type Sender = { send: (channel: string, ...args: unknown[]) => void };

const MIMO_TIMEOUT_MS = 30 * 60_000;
const activeMimoRuns = new Map<string, { stop: () => void; sender: Sender }>();

function spawnMimo(args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn("mimo", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function mimoDesktopPrompt(): string {
  return [
    "你是 AI Workbench 桌面端的编程助手。",
    "请严格遵守以下规则：",
    "1. 必须使用中文回复用户。",
    "2. 必须实际执行读取命令来了解项目结构和文件内容。",
    "3. 在执行任何修改性命令前，先告知用户你打算做什么。",
    "4. 命令执行结果要如实地反馈给用户。",
  ].join("\n");
}

// 解析 mimo run --format json 的输出事件
function handleLine(line: string, aiSessionId: string, sender: Sender): { sessionId?: string; done?: boolean; error?: string } {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return {}; }
  if (!event || typeof event !== "object") return {};
  const e = event as Record<string, unknown>;
  const type = e["type"] as string;
  const sessionID = e["sessionID"] as string | undefined;
  const part = e["part"] as Record<string, unknown> | undefined;

  switch (type) {
    case "text": {
      const text = part?.["text"] as string | undefined;
      if (text) {
        emit(sender, { aiSessionId, kind: "delta", text, segment: { type: "text", text } });
      }
      return { sessionId: sessionID };
    }
    case "step_finish": {
      const reason = part?.["reason"] as string;
      if (reason === "stop") {
        emit(sender, { aiSessionId, kind: "done" });
        return { sessionId: sessionID, done: true };
      }
      return { sessionId: sessionID };
    }
    default:
      return { sessionId: sessionID };
  }
}
```

2. **注册 IPC 处理器**

在 `ipc.ts` 中添加 `run_mimo_chat` 和 `stop_mimo_chat` 处理器。

3. **更新路由逻辑**

在 `useWorkspace.ts` 中将 `mimo` 添加到 `supportedChatProviders`。

### 方案 C：ACP 协议模式（后续评估）

使用 `mimo acp` 实现类似 Codex 的持久 JSON-RPC 会话。

**优势：**
- 持久会话，性能更好
- 可能支持审批机制
- 与 Codex 架构一致

**劣势：**
- ACP 方法名未完全确定，需要进一步逆向
- 实现复杂度高

**待确认事项：**
- [ ] ACP 发送消息的方法名（可能是 `turn/create` 或其他）
- [ ] ACP 审批请求机制
- [ ] ACP 会话恢复的完整流程

## 5. 文件变更清单

### 已完成（Provider 注册）

| 文件 | 变更 |
|---|---|
| `apps/desktop/src/main/providers.ts` | 添加 `mimo` 到 `BUILTIN_PROVIDERS`，auth 检测 |
| `apps/desktop/src/composables/useWorkspace.ts` | 添加到 `supportedChatProviders` 和显示名映射 |
| `apps/desktop/src/components/ChatView.vue` | 添加 mimo 图标 |
| `apps/desktop/src/components/SidebarProjectTree.vue` | 添加 mimo 图标 |
| `apps/desktop/src/assets/icons/provider-mimo.svg` | 新增图标文件 |
| `apps/mobile/lib/pages/providers_page.dart` | 添加 `_ProviderInfo` |
| `apps/mobile/lib/pages/mobile_shell_page.dart` | 添加到 `_builtInProviders` |

### 已完成（聊天与审批集成）

| 文件 | 变更 |
|---|---|
| `apps/desktop/src/main/mimo.ts` | 独立 HTTP/SSE 会话、工具事件、审批与停止处理 |
| `apps/desktop/src/main/ipc.ts` | MiMo 聊天、停止、配置和统一审批 IPC 路由 |
| `apps/desktop/src/main/sync.ts` | 移动端聊天、停止和审批响应路由 |
| `apps/desktop/src/components/ChatSegment.vue` | 共用审批卡片并显示真实 Provider |

## 6. 测试验证

### 6.1 基础验证

```bash
# 检查 mimo 安装
which mimo && mimo --version

# 启动本地服务
mimo serve --hostname 127.0.0.1 --port 4096

# 检查服务和待审批列表
curl "http://127.0.0.1:4096/path?directory=/path/to/project"
curl "http://127.0.0.1:4096/permission?directory=/path/to/project"
```

### 6.2 集成验证

1. 启动桌面端，检查 Settings → AI 工具 中 MiMo Code 状态
2. 创建新会话，选择 MiMo Code 作为 Provider
3. 发送消息，验证 SSE 文本和工具状态
4. 触发权限请求，分别验证允许、拒绝和停止
5. 验证会话续接功能

## 7. 风险与限制

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 本地服务异常退出 | 当前轮次中断 | 监听子进程并中止 HTTP/SSE 请求 |
| MiMo 0.1.5 拒绝后 runner 不结束 | 会话持续等待 | 拒绝后保留 8 秒收尾窗口，随后中止本轮 |
| 审批长期未处理 | 输入框持续锁定 | 停止或 30 分钟超时后将审批标记为失效 |
| 版本兼容性 | CLI 参数可能变化 | 检测版本并适配 |

## 8. 后续计划

1. **已完成**：本地 HTTP/SSE 聊天、会话续接和模型配置
2. **已完成**：桌面端与移动端交互审批
3. **后续**：评估复用常驻 MiMo 服务以降低每轮启动开销
