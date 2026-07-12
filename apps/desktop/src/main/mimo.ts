// MiMo Code integration for the Electron main process.
// Uses MiMo's local HTTP/SSE service rather than the OpenCode ACP transport.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fsSync from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexApprovalDecision } from "../services/desktop";
import type { AcpConfigOption, AcpConfigOptions, CodexTraceItem, CodexTraceSnapshot, RunAiChatRequest } from "../services/desktop";
import { appendChatContexts } from "../shared/chat_context";
import { resetLocalAiTrace, upsertLocalAiTrace } from "./db";
import { reportTokenUsage } from "./sync";
import { codexTraceSnapshotToSegments } from "./codex_trace";

type Sender = { send: (channel: string, ...args: unknown[]) => void };

interface MimoSession {
  aiSessionId: string;
  child: ChildProcessWithoutNullStreams;
  baseUrl: string;
  cwd: string;
  sender: Sender;
  snapshot: CodexTraceSnapshot;
  sessionId: string | null;
  cancelled: boolean;
  timedOut: boolean;
  closed: boolean;
  stderrBuffer: string;
  textParts: Map<string, string>;
  textPartOrder: string[];
  anonymousTextPartId: number;
  reportedUsageKeys: Set<string>;
  assistantMessageIds: Set<string>;
  pendingApprovals: Map<string, PendingMimoApproval>;
  promptAbortController: AbortController;
  eventAbortController: AbortController;
  eventTask: Promise<void> | null;
  launchError: string | null;
  eventError: string | null;
  promptSettled: boolean;
  deniedApprovalAbort: boolean;
  denialFallbackTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingMimoApproval {
  id: string;
  requestId: string;
  resolved: boolean;
}

interface MimoSpawnSpec {
  command: string;
  prefixArgs: string[];
}

const MIMO_TURN_TIMEOUT_MS = 30 * 60_000;
const MIMO_LIST_TIMEOUT_MS = 20_000;
const MIMO_SERVER_START_TIMEOUT_MS = 20_000;
const MIMO_DEFAULT_MODEL = "xiaomi/mimo-v2.5-pro";
const activeMimoSessions = new Map<string, MimoSession>();

class MimoHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MimoHttpError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isDirectoryPath(value: string): boolean {
  try {
    return fsSync.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function resolveMimoCwd(cwd: string): string {
  const requested = (cwd || "").trim();
  const candidates = [
    requested ? (path.isAbsolute(requested) ? requested : path.resolve(requested)) : "",
    os.homedir(),
    process.cwd(),
  ].filter(Boolean);
  return candidates.find(isDirectoryPath) ?? os.homedir();
}

function windowsMimoBinaryCandidates(): string[] {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const packageNames = [
    `mimocode-windows-${architecture}`,
    ...(architecture === "x64" ? ["mimocode-windows-x64-baseline"] : []),
  ];
  const npmRoots = [
    process.env["APPDATA"] ? path.join(process.env["APPDATA"], "npm", "node_modules") : "",
    path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules"),
  ].filter(Boolean);
  const packageCandidates = npmRoots.flatMap((root) => packageNames.flatMap((packageName) => [
    path.join(root, "@mimo-ai", "cli", "node_modules", "@mimo-ai", packageName, "bin", "mimo.exe"),
    path.join(root, "@mimo-ai", packageName, "bin", "mimo.exe"),
  ]));
  return [
    process.env["MIMOCODE_BIN_PATH"] ?? "",
    path.join(os.homedir(), ".mimocode", "bin", "mimo.exe"),
    path.join(os.homedir(), ".local", "bin", "mimo.exe"),
    ...(process.env["LOCALAPPDATA"] ? [path.join(process.env["LOCALAPPDATA"], "mimocode", "bin", "mimo.exe")] : []),
    ...packageCandidates,
  ].filter(Boolean);
}

function resolveMimoSpawnSpec(): MimoSpawnSpec {
  if (process.platform !== "win32") return { command: "mimo", prefixArgs: [] };
  const executable = windowsMimoBinaryCandidates().find((candidate) => fsSync.existsSync(candidate));
  if (executable) return { command: executable, prefixArgs: [] };

  const npmWrapper = process.env["APPDATA"]
    ? path.join(process.env["APPDATA"], "npm", "node_modules", "@mimo-ai", "cli", "bin", "mimo")
    : "";
  if (npmWrapper && fsSync.existsSync(npmWrapper)) {
    return { command: process.execPath, prefixArgs: [npmWrapper] };
  }
  return { command: "mimo.exe", prefixArgs: [] };
}

function spawnMimo(args: string[], cwd: string): ChildProcessWithoutNullStreams {
  const spec = resolveMimoSpawnSpec();
  return spawn(spec.command, [...spec.prefixArgs, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function reserveMimoPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法为 MiMo Code 分配本地端口"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function mimoEndpoint(session: MimoSession, pathname: string): string {
  const url = new URL(pathname, `${session.baseUrl}/`);
  url.searchParams.set("directory", session.cwd);
  return url.toString();
}

async function mimoFetch(session: MimoSession, pathname: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(mimoEndpoint(session, pathname), init);
  if (response.ok) return response;
  const detail = (await response.text().catch(() => "")).trim() || response.statusText;
  throw new MimoHttpError(response.status, `MiMo Code HTTP ${response.status}: ${detail}`);
}

async function mimoJson<T>(session: MimoSession, pathname: string, init?: RequestInit): Promise<T> {
  const response = await mimoFetch(session, pathname, init);
  const text = await response.text();
  return (text.trim() ? JSON.parse(text) : undefined) as T;
}

function parseMimoModel(value?: string | null): { providerID: string; modelID: string } | undefined {
  const model = value?.trim();
  if (!model) return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

function snapshotBase(now: string): CodexTraceSnapshot {
  return {
    provider: "mimo",
    status: "running",
    threadId: null,
    turnId: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    items: [],
    approvals: [],
    errors: [],
    finalText: "",
  };
}

function emitTrace(session: MimoSession, rawEvent?: unknown): void {
  const trace = upsertLocalAiTrace({
    aiSessionId: session.aiSessionId,
    providerId: "mimo",
    traceKind: "mimo",
    status: session.snapshot.status,
    rawEvent,
    snapshot: session.snapshot,
    finalText: session.snapshot.finalText,
  });
  session.sender.send("ai-trace-update", {
    aiSessionId: session.aiSessionId,
    trace: {
      ...trace,
      segments: codexTraceSnapshotToSegments(session.snapshot),
    },
  });
}

function upsertItem(snapshot: CodexTraceSnapshot, item: CodexTraceItem): CodexTraceSnapshot {
  const index = snapshot.items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return { ...snapshot, items: [...snapshot.items, item] };
  const items = [...snapshot.items];
  items[index] = { ...items[index], ...item };
  return { ...snapshot, items };
}

function completeRunningItems(snapshot: CodexTraceSnapshot, completedAt: string): CodexTraceSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => item.status === "running"
      ? { ...item, status: "completed" as const, completedAt }
      : item),
  };
}

function eventTimestamp(event: Record<string, unknown>): string {
  const timestamp = num(event["timestamp"]);
  return timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolStatus(value: unknown): CodexTraceItem["status"] {
  const status = str(value)?.toLowerCase();
  if (status === "completed" || status === "success") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "canceled" || status === "cancelled") return "canceled";
  return "running";
}

function updateTextPart(session: MimoSession, part: Record<string, unknown>, text: string): void {
  let id = str(part["id"]);
  if (!id) id = `mimo-text-${++session.anonymousTextPartId}`;
  const previous = session.textParts.get(id) ?? "";
  const next = !previous || text.startsWith(previous) ? text : previous + text;
  if (!session.textParts.has(id)) session.textPartOrder.push(id);
  session.textParts.set(id, next);
  session.snapshot = {
    ...session.snapshot,
    finalText: session.textPartOrder.map((partId) => session.textParts.get(partId) ?? "").join(""),
  };
}

function reportMimoUsage(session: MimoSession, part: Record<string, unknown>): void {
  const tokens = record(part["tokens"]);
  const inputTokens = num(tokens["input"]) ?? num(tokens["inputTokens"]) ?? 0;
  const cachedInputTokens = Math.min(inputTokens, Math.max(0,
    num(tokens["cachedInputTokens"])
      ?? num(tokens["cached_input_tokens"])
      ?? num(tokens["cacheReadInputTokens"])
      ?? num(tokens["cache_read_input_tokens"])
      ?? 0));
  const outputTokens = num(tokens["output"]) ?? num(tokens["outputTokens"]) ?? 0;
  const reasoningTokens = num(tokens["reasoning"]) ?? num(tokens["reasoningTokens"]) ?? 0;
  const totalTokens = num(tokens["total"]) ?? inputTokens + outputTokens + reasoningTokens;
  if (totalTokens <= 0) return;
  const key = `${str(part["id"]) ?? "step"}:${inputTokens}:${cachedInputTokens}:${outputTokens}:${reasoningTokens}:${totalTokens}`;
  if (session.reportedUsageKeys.has(key)) return;
  session.reportedUsageKeys.add(key);
  void reportTokenUsage({
    aiSessionId: session.aiSessionId,
    providerId: "mimo",
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  });
}

function reduceMimoEvent(session: MimoSession, rawEvent: unknown, traceEvent: unknown = rawEvent): void {
  const event = record(rawEvent);
  const part = record(event["part"]);
  const now = eventTimestamp(event);
  const sessionId = str(event["sessionID"]) ?? str(event["sessionId"]) ?? str(part["sessionID"]) ?? str(part["sessionId"]);
  if (sessionId) session.sessionId = sessionId;
  const eventType = (str(event["type"]) ?? str(part["type"]) ?? "unknown").replace(/-/g, "_");
  session.snapshot = {
    ...session.snapshot,
    threadId: sessionId ?? session.snapshot.threadId,
    turnId: str(part["messageID"]) ?? str(part["messageId"]) ?? session.snapshot.turnId,
    updatedAt: now,
  };

  if (eventType === "text") {
    const text = str(part["text"]) ?? str(event["text"]);
    if (text) updateTextPart(session, part, text);
  } else if (eventType === "reasoning" || eventType === "thinking") {
    const id = str(part["id"]) ?? `mimo-thinking-${Date.now()}`;
    const text = str(part["text"]) ?? str(event["text"]) ?? "";
    session.snapshot = upsertItem(session.snapshot, {
      id,
      type: "thinking",
      title: "正在思考",
      status: "running",
      text,
      rawItemType: eventType,
      startedAt: now,
      completedAt: null,
    });
  } else if (eventType === "tool_use" || eventType === "tool" || eventType === "tool_call") {
    const state = record(part["state"]);
    const input = state["input"] ?? part["input"];
    const inputRecord = record(input);
    const toolName = str(part["tool"]) ?? str(part["name"]) ?? str(event["tool"]) ?? "工具";
    const status = toolStatus(state["status"] ?? part["status"]);
    const id = str(part["callID"]) ?? str(part["callId"]) ?? str(part["id"]) ?? `mimo-tool-${Date.now()}`;
    session.snapshot = upsertItem(session.snapshot, {
      id,
      type: /^(?:bash|shell|command)$/i.test(toolName) ? "command" : "tool",
      title: str(state["title"]) ?? toolName,
      status,
      text: valueText(input),
      rawItemType: eventType,
      command: str(inputRecord["command"]) ?? null,
      output: valueText(state["output"] ?? state["error"] ?? part["output"]) || null,
      startedAt: num(record(state["time"])["start"])
        ? new Date(num(record(state["time"])["start"])!).toISOString()
        : now,
      completedAt: status === "running" ? null : now,
    });
  } else if (eventType === "step_finish") {
    session.snapshot = completeRunningItems(session.snapshot, now);
    reportMimoUsage(session, part);
  } else if (eventType === "error") {
    const error = record(event["error"]);
    const errorData = record(error["data"]);
    const message = str(errorData["message"])
      ?? str(error["message"])
      ?? str(part["message"])
      ?? str(event["message"])
      ?? "MiMo Code 执行出错";
    session.snapshot = {
      ...session.snapshot,
      errors: [...session.snapshot.errors, { message, detail: valueText(error["data"]) || null, at: now }],
    };
  }

  emitTrace(session, { ...record(traceEvent), receivedAt: now });
}

function mimoApprovalTitle(permission: string): string {
  if (permission === "edit" || permission === "write") return "需要同意后修改文件";
  if (permission === "read") return "需要同意后读取文件";
  if (permission === "bash_delete") return "需要同意后删除文件";
  if (permission === "bash") return "需要同意后执行命令";
  if (permission === "external_directory") return "需要同意后访问外部目录";
  return `需要同意 MiMo Code 使用 ${permission}`;
}

function handleMimoPermissionAsked(session: MimoSession, event: Record<string, unknown>): void {
  const properties = record(event["properties"]);
  const requestId = str(properties["id"]);
  const sessionId = str(properties["sessionID"]) ?? str(properties["sessionId"]);
  if (!requestId || sessionId !== session.sessionId || session.pendingApprovals.has(requestId)) return;

  const permission = str(properties["permission"]) ?? "tool";
  const patterns = Array.isArray(properties["patterns"])
    ? properties["patterns"].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const metadata = record(properties["metadata"]);
  const tool = record(properties["tool"]);
  const callId = str(tool["callID"]) ?? str(tool["callId"]);
  const toolItem = callId ? session.snapshot.items.find((item) => item.id === callId) : undefined;
  const isFileChange = permission === "edit" || permission === "write";
  const metadataPath = str(metadata["filepath"]) ?? str(metadata["filePath"]);
  const command = str(metadata["command"])
    ?? toolItem?.command
    ?? (permission === "read" && patterns.length ? `读取 ${patterns.join(", ")}` : null);
  const fileChanges = isFileChange
    ? [...new Set([...(metadataPath ? [metadataPath] : []), ...patterns])]
    : [];
  const detailParts = [
    `MiMo Code 请求 ${permission} 权限。`,
    patterns.length && !isFileChange ? patterns.join("\n") : "",
  ].filter(Boolean);
  const title = mimoApprovalTitle(permission);
  const now = new Date().toISOString();

  session.pendingApprovals.set(requestId, { id: requestId, requestId, resolved: false });
  session.snapshot = {
    ...session.snapshot,
    updatedAt: now,
    approvals: [
      ...session.snapshot.approvals.filter((approval) => approval.id !== requestId),
      {
        id: requestId,
        kind: isFileChange ? "fileChange" : "command",
        status: "pending",
        title,
        command,
        cwd: session.cwd,
        fileChanges,
        detail: detailParts.join("\n") || null,
      },
    ],
  };
  session.snapshot = upsertItem(session.snapshot, {
    id: `approval-${requestId}`,
    type: "approval",
    title,
    status: "running",
    text: detailParts.join("\n"),
    rawItemType: "permission.asked",
    command,
    startedAt: now,
    completedAt: null,
  });
  emitTrace(session, { ...event, receivedAt: now });
}

function resolveMimoApprovalSnapshot(
  session: MimoSession,
  approvalId: string,
  status: "approved" | "denied" | "expired" | "failed",
  detail?: string,
): void {
  const now = new Date().toISOString();
  session.snapshot = {
    ...session.snapshot,
    updatedAt: now,
    approvals: session.snapshot.approvals.map((approval) => approval.id === approvalId
      ? { ...approval, status, detail: detail ?? approval.detail }
      : approval),
    items: session.snapshot.items.map((item) => item.id === `approval-${approvalId}`
      ? {
          ...item,
          status: status === "approved" ? "completed" : "failed",
          completedAt: now,
        }
      : item),
  };
  emitTrace(session, {
    type: "permission.resolved",
    approvalId,
    status,
    detail,
    receivedAt: now,
  });
}

function expireMimoApprovals(session: MimoSession, status: "expired" | "failed", detail: string): void {
  for (const approval of session.pendingApprovals.values()) {
    if (approval.resolved) continue;
    approval.resolved = true;
    resolveMimoApprovalSnapshot(session, approval.id, status, detail);
  }
  session.pendingApprovals.clear();
}

function reduceMimoServerEvent(session: MimoSession, rawEvent: unknown): void {
  const event = record(rawEvent);
  const type = str(event["type"]);
  const properties = record(event["properties"]);

  if (type === "permission.asked") {
    handleMimoPermissionAsked(session, event);
    return;
  }

  if (type === "permission.replied") {
    const sessionId = str(properties["sessionID"]) ?? str(properties["sessionId"]);
    const requestId = str(properties["requestID"]) ?? str(properties["requestId"]);
    const pending = requestId ? session.pendingApprovals.get(requestId) : undefined;
    if (sessionId === session.sessionId && requestId && pending && !pending.resolved) {
      pending.resolved = true;
      const status = properties["reply"] === "reject" ? "denied" : "approved";
      resolveMimoApprovalSnapshot(session, requestId, status);
      session.pendingApprovals.delete(requestId);
    }
    return;
  }

  if (type === "message.updated") {
    const info = record(properties["info"]);
    const sessionId = str(info["sessionID"]) ?? str(info["sessionId"]);
    const messageId = str(info["id"]);
    if (sessionId === session.sessionId && messageId && info["role"] === "assistant") {
      session.assistantMessageIds.add(messageId);
      session.snapshot = {
        ...session.snapshot,
        turnId: messageId,
        updatedAt: new Date().toISOString(),
      };
    }
    return;
  }

  if (type === "message.part.updated") {
    const part = record(properties["part"]);
    const sessionId = str(properties["sessionID"]) ?? str(part["sessionID"]) ?? str(part["sessionId"]);
    if (sessionId !== session.sessionId) return;
    const messageId = str(part["messageID"]) ?? str(part["messageId"]);
    if (messageId && !session.assistantMessageIds.has(messageId)) return;
    const partType = (str(part["type"]) ?? "unknown").replace(/-/g, "_");
    const eventType = partType === "tool" ? "tool_use" : partType;
    reduceMimoEvent(session, {
      type: eventType,
      timestamp: num(properties["time"]) ?? Date.now(),
      sessionID: sessionId,
      part,
    }, event);
    return;
  }

  if (type === "session.error") {
    const sessionId = str(properties["sessionID"]) ?? str(properties["sessionId"]);
    if (sessionId !== session.sessionId) return;
    reduceMimoEvent(session, {
      type: "error",
      timestamp: Date.now(),
      sessionID: sessionId,
      error: properties["error"],
    }, event);
  }
}

function sseData(block: string): string {
  return block
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

async function consumeMimoEventStream(session: MimoSession, response: Response): Promise<void> {
  if (!response.body) throw new Error("MiMo Code 事件流没有响应内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = /\r?\n\r?\n/.exec(buffer);
    while (separator?.index !== undefined) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = sseData(block);
      if (data) {
        try {
          reduceMimoServerEvent(session, JSON.parse(data));
        } catch {
          // Ignore malformed or unsupported SSE events.
        }
      }
      separator = /\r?\n\r?\n/.exec(buffer);
    }
  }
}

function mimoDesktopPrompt(): string {
  return [
    "你是 CodeHub AI 桌面端的编程助手。",
    "请严格遵守以下规则：",
    "1. 必须使用中文回复用户。",
    "2. 必须实际执行读取命令来了解项目结构和文件内容，不能仅凭推测回答。",
    "3. 在执行任何修改性命令前，先告知用户你打算做什么。",
    "4. 命令执行结果要如实反馈给用户。",
  ].join("\n");
}

function buildMimoPrompt(req: RunAiChatRequest): string {
  const goal = req.codexGoal?.trim() ?? req.claudeGoal?.trim();
  const imageNote = req.images?.length
    ? `\n\n[用户还粘贴了 ${req.images.length} 张图片，当前 MiMo 接入暂未传输图片，请根据文字请求继续。]`
    : "";
  const prompt = appendChatContexts(req.prompt, req.contexts);
  const request = goal ? `本轮目标：${goal}\n\n用户请求：\n${prompt}` : prompt;
  return `${mimoDesktopPrompt()}\n\n${request}${imageNote}`;
}

function teardownMimoSession(session: MimoSession): void {
  session.promptAbortController.abort();
  session.eventAbortController.abort();
  try {
    if (!session.closed) session.child.kill();
  } catch {
    // ignore
  }
  if (activeMimoSessions.get(session.aiSessionId) === session) activeMimoSessions.delete(session.aiSessionId);
}

async function waitForMimoServer(session: MimoSession): Promise<void> {
  const deadline = Date.now() + MIMO_SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (session.cancelled) throw new Error("AI chat stopped by user");
    if (session.launchError) throw new Error(session.launchError);
    if (session.closed) {
      throw new Error(session.stderrBuffer.trim() || "MiMo Code 本地服务启动后意外退出");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      await mimoFetch(session, "/path", { signal: controller.signal });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`MiMo Code 本地服务启动超时（${MIMO_SERVER_START_TIMEOUT_MS / 1000} 秒）`);
}

async function ensureMimoProviderSession(
  session: MimoSession,
  req: RunAiChatRequest,
  existingSessionId?: string | null,
): Promise<string> {
  if (existingSessionId) {
    try {
      const current = await mimoJson<Record<string, unknown>>(
        session,
        `/session/${encodeURIComponent(existingSessionId)}`,
      );
      const currentId = str(current["id"]);
      if (currentId) return currentId;
    } catch (error) {
      if (!(error instanceof MimoHttpError) || error.status !== 404) throw error;
    }
  }

  const title = req.prompt.trim().slice(0, 50) || "CodeHub AI 会话";
  const created = await mimoJson<Record<string, unknown>>(session, "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
        { permission: "plan_enter", action: "deny", pattern: "*" },
        { permission: "plan_exit", action: "deny", pattern: "*" },
      ],
    }),
  });
  const sessionId = str(created["id"]);
  if (!sessionId) throw new Error("MiMo Code 未返回 sessionId");
  return sessionId;
}

async function startMimoEventStream(session: MimoSession): Promise<void> {
  const response = await mimoFetch(session, "/event", {
    headers: { Accept: "text/event-stream" },
    signal: session.eventAbortController.signal,
  });
  session.eventTask = consumeMimoEventStream(session, response).catch((error) => {
    if (session.eventAbortController.signal.aborted || session.cancelled || session.closed) return;
    const message = error instanceof Error ? error.message : String(error);
    session.eventError = `MiMo Code 事件流中断：${message}`;
    session.promptAbortController.abort();
  });
}

function applyMimoPromptResult(session: MimoSession, result: unknown): void {
  const message = record(result);
  const info = record(message["info"]);
  const sessionId = str(info["sessionID"]) ?? str(info["sessionId"]);
  if (sessionId) session.sessionId = sessionId;
  const messageId = str(info["id"]);
  if (messageId) session.assistantMessageIds.add(messageId);
  const parts = Array.isArray(message["parts"]) ? message["parts"] : [];
  let hasStepFinish = false;
  for (const value of parts) {
    const part = record(value);
    const partType = (str(part["type"]) ?? "unknown").replace(/-/g, "_");
    if (partType === "step_finish") hasStepFinish = true;
    const eventType = partType === "tool" ? "tool_use" : partType;
    reduceMimoEvent(session, {
      type: eventType,
      timestamp: Date.now(),
      sessionID: session.sessionId,
      part,
    }, {
      type: "prompt.result",
      properties: { sessionID: session.sessionId, part },
    });
  }
  const tokens = record(info["tokens"]);
  if (!hasStepFinish && Object.keys(tokens).length) {
    reportMimoUsage(session, { id: info["id"], tokens });
  }
}

async function sendMimoPrompt(session: MimoSession, req: RunAiChatRequest): Promise<void> {
  if (!session.sessionId) throw new Error("MiMo Code 会话尚未创建");
  const model = parseMimoModel(req.mimoModel);
  try {
    const response = await mimoFetch(
      session,
      `/session/${encodeURIComponent(session.sessionId)}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          ...(req.mimoVariant ? { variant: req.mimoVariant } : {}),
          ...(req.mimoAgent ? { agent: req.mimoAgent } : {}),
          parts: [{ type: "text", text: buildMimoPrompt(req) }],
        }),
        signal: session.promptAbortController.signal,
      },
    );
    const text = await response.text();
    if (!text.trim()) throw new Error("MiMo Code 未返回对话结果");
    applyMimoPromptResult(session, JSON.parse(text));
  } finally {
    session.promptSettled = true;
    if (session.denialFallbackTimer) clearTimeout(session.denialFallbackTimer);
    session.denialFallbackTimer = null;
  }
}

async function abortMimoProviderTurn(session: MimoSession): Promise<void> {
  if (!session.sessionId || session.closed) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    await mimoFetch(session, `/session/${encodeURIComponent(session.sessionId)}/abort`, {
      method: "POST",
      signal: controller.signal,
    });
  } catch {
    // The process may already be stopping.
  } finally {
    clearTimeout(timeout);
  }
}

export async function runMimoChat(
  req: RunAiChatRequest,
  sender: Sender,
  existingSessionId?: string | null,
): Promise<string> {
  const cwd = resolveMimoCwd(req.projectPath);
  const previous = activeMimoSessions.get(req.aiSessionId);
  if (previous) teardownMimoSession(previous);

  const port = await reserveMimoPort();
  const now = new Date().toISOString();
  const child = spawnMimo(["serve", "--hostname", "127.0.0.1", "--port", String(port)], cwd);
  child.stdin.on("error", () => {
    // The process may close stdin while being stopped or failing to launch.
  });
  child.stdin.end();
  const session: MimoSession = {
    aiSessionId: req.aiSessionId,
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    cwd,
    sender,
    snapshot: snapshotBase(now),
    sessionId: existingSessionId ?? null,
    cancelled: false,
    timedOut: false,
    closed: false,
    stderrBuffer: "",
    textParts: new Map(),
    textPartOrder: [],
    anonymousTextPartId: 0,
    reportedUsageKeys: new Set(),
    assistantMessageIds: new Set(),
    pendingApprovals: new Map(),
    promptAbortController: new AbortController(),
    eventAbortController: new AbortController(),
    eventTask: null,
    launchError: null,
    eventError: null,
    promptSettled: false,
    deniedApprovalAbort: false,
    denialFallbackTimer: null,
  };
  if (existingSessionId) session.snapshot.threadId = existingSessionId;
  child.stdout.on("data", () => {
    // Keep the service pipe drained; protocol traffic uses HTTP/SSE.
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    session.stderrBuffer += chunk;
  });
  child.once("error", (error) => {
    session.launchError = `启动 MiMo Code 失败：${error.message}`;
  });
  child.once("close", () => {
    session.closed = true;
    if (!session.cancelled && !session.timedOut && !session.promptAbortController.signal.aborted) {
      session.eventError = session.stderrBuffer.trim() || "MiMo Code 本地服务意外退出";
      session.promptAbortController.abort();
      session.eventAbortController.abort();
    }
  });
  activeMimoSessions.set(req.aiSessionId, session);
  resetLocalAiTrace({
    aiSessionId: req.aiSessionId,
    providerId: "mimo",
    traceKind: "mimo",
    status: "running",
    snapshot: session.snapshot,
  });
  emitTrace(session);

  const timeout = setTimeout(() => {
    session.timedOut = true;
    session.promptAbortController.abort();
    session.eventAbortController.abort();
    void abortMimoProviderTurn(session);
    try { child.kill(); } catch { /* ignore */ }
  }, MIMO_TURN_TIMEOUT_MS);

  try {
    await waitForMimoServer(session);
    session.sessionId = await ensureMimoProviderSession(session, req, existingSessionId);
    session.snapshot = {
      ...session.snapshot,
      threadId: session.sessionId,
      updatedAt: new Date().toISOString(),
    };
    emitTrace(session);
    await startMimoEventStream(session);
    await sendMimoPrompt(session, req);
    if (session.eventError) throw new Error(session.eventError);
    const protocolError = session.snapshot.errors.at(-1);
    if (protocolError) throw new Error(protocolError.message);
    if (session.pendingApprovals.size) {
      expireMimoApprovals(session, "failed", "MiMo Code 会话结束前审批未完成。");
    }
    const completedAt = new Date().toISOString();
    session.snapshot = {
      ...completeRunningItems(session.snapshot, completedAt),
      status: session.cancelled ? "canceled" : "completed",
      updatedAt: completedAt,
      completedAt,
    };
    emitTrace(session);
    return session.sessionId ?? existingSessionId ?? "";
  } catch (error) {
    if (session.deniedApprovalAbort && !session.cancelled && !session.timedOut) {
      const completedAt = new Date().toISOString();
      session.snapshot = {
        ...session.snapshot,
        status: "completed",
        updatedAt: completedAt,
        completedAt,
        finalText: session.snapshot.finalText || "已拒绝 MiMo Code 的操作请求，本轮已停止。",
        items: session.snapshot.items.map((item) => item.status === "running"
          ? { ...item, status: "canceled" as const, completedAt }
          : item),
      };
      emitTrace(session);
      return session.sessionId ?? existingSessionId ?? "";
    }
    const message = session.timedOut
      ? `MiMo Code 会话超时（${MIMO_TURN_TIMEOUT_MS / 60_000} 分钟）`
      : session.eventError
        ? session.eventError
        : error instanceof Error ? error.message : String(error);
    const failedAt = new Date().toISOString();
    const latestError = session.snapshot.errors.at(-1);
    if (session.pendingApprovals.size) {
      expireMimoApprovals(
        session,
        session.cancelled ? "expired" : "failed",
        session.cancelled ? "会话已停止，审批请求已失效。" : message,
      );
    }
    session.snapshot = {
      ...session.snapshot,
      status: session.cancelled ? "canceled" : "failed",
      updatedAt: failedAt,
      completedAt: failedAt,
      errors: session.cancelled || latestError?.message === message
        ? session.snapshot.errors
        : [...session.snapshot.errors, { message, at: failedAt }],
    };
    emitTrace(session);
    if (session.cancelled) return session.sessionId ?? existingSessionId ?? "";
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
    if (session.denialFallbackTimer) clearTimeout(session.denialFallbackTimer);
    session.promptAbortController.abort();
    session.eventAbortController.abort();
    await session.eventTask?.catch(() => undefined);
    teardownMimoSession(session);
  }
}

export async function respondMimoApproval(
  aiSessionId: string,
  approvalId: string,
  decision: CodexApprovalDecision,
): Promise<boolean> {
  const session = activeMimoSessions.get(aiSessionId);
  const approval = session?.pendingApprovals.get(approvalId);
  if (!session || !approval || approval.resolved || session.closed) return false;
  approval.resolved = true;
  try {
    await mimoJson<boolean>(session, `/permission/${encodeURIComponent(approval.requestId)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: decision === "approved" ? "once" : "reject" }),
    });
    resolveMimoApprovalSnapshot(
      session,
      approvalId,
      decision === "approved" ? "approved" : "denied",
      decision === "approved" ? "已允许 MiMo Code 执行本次操作。" : "已拒绝 MiMo Code 执行本次操作。",
    );
    session.pendingApprovals.delete(approvalId);
    if (decision === "denied" && !session.promptSettled && !session.denialFallbackTimer) {
      session.denialFallbackTimer = setTimeout(() => {
        if (session.promptSettled || session.cancelled || session.closed) return;
        session.deniedApprovalAbort = true;
        void abortMimoProviderTurn(session);
        session.promptAbortController.abort();
      }, 8_000);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resolveMimoApprovalSnapshot(session, approvalId, "failed", message);
    session.pendingApprovals.delete(approvalId);
    return false;
  }
}

export function stopMimoChat(aiSessionId: string): boolean {
  const session = activeMimoSessions.get(aiSessionId);
  if (!session) return false;
  session.cancelled = true;
  session.promptAbortController.abort();
  session.eventAbortController.abort();
  void abortMimoProviderTurn(session);
  if (session.pendingApprovals.size) {
    expireMimoApprovals(session, "expired", "会话已停止，审批请求已失效。");
  }
  const now = new Date().toISOString();
  session.snapshot = {
    ...session.snapshot,
    status: "canceled",
    updatedAt: now,
    completedAt: now,
  };
  emitTrace(session);
  try { session.child.kill(); } catch { /* ignore */ }
  return true;
}

export function hasLiveMimoChat(): boolean {
  return activeMimoSessions.size > 0;
}

function modelDisplayName(value: string): string {
  const model = value.split("/").pop() ?? value;
  return model
    .split("-")
    .filter(Boolean)
    .map((part) => {
      const normalized = part.toLowerCase();
      if (normalized === "mimo") return "MiMo";
      if (normalized === "auto") return "Auto";
      if (/^v\d/.test(normalized)) return part.toUpperCase();
      if (normalized === "pro") return "Pro";
      if (normalized === "ultraspeed") return "UltraSpeed";
      return part;
    })
    .join(" ");
}

function parseMimoModels(stdout: string): AcpConfigOption[] {
  const values = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/-]+$/.test(line));
  const uniqueValues = [...new Set(values)];
  const defaultValue = uniqueValues.includes(MIMO_DEFAULT_MODEL) ? MIMO_DEFAULT_MODEL : uniqueValues[0];
  return uniqueValues.map((value) => ({
    value,
    name: modelDisplayName(value),
    isDefault: value === defaultValue || undefined,
  }));
}

export async function listMimoConfigOptions(cwd: string): Promise<AcpConfigOptions> {
  const resolvedCwd = resolveMimoCwd(cwd);
  const child = spawnMimo(["models"], resolvedCwd);
  child.stdin.on("error", () => {
    // Ignore stdin closure when the CLI exits before consuming input.
  });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(stderr.trim() || `mimo models 退出，状态码 ${code ?? "未知"}`)));
  });
  const timeout = setTimeout(() => {
    try { child.kill(); } catch { /* ignore */ }
  }, MIMO_LIST_TIMEOUT_MS);
  try {
    await completion;
    const models = parseMimoModels(stdout);
    if (!models.length) throw new Error("mimo models 未返回可用模型");
    return {
      models,
      efforts: [
        { value: "low", name: "低" },
        { value: "medium", name: "中" },
        { value: "high", name: "高", isDefault: true },
      ],
      modes: [
        { value: "build", name: "构建", isDefault: true },
        { value: "plan", name: "计划" },
        { value: "compose", name: "编排" },
      ],
    };
  } finally {
    clearTimeout(timeout);
    try { child.kill(); } catch { /* ignore */ }
  }
}
