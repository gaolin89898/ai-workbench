// OpenCode ACP (Agent Client Protocol) integration for the Electron main process.
// Spawns `opencode acp`, communicates via JSON-RPC 2.0 over stdio, and
// emits provider trace updates sharing the same CodexTraceSnapshot model as
// Codex/Claude so the renderer and mobile client render one unified view.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunAiChatRequest, CodexTraceSnapshot, CodexTraceItem, AcpConfigOption, AcpConfigOptions } from "../services/desktop";
import { appendChatContexts } from "../shared/chat_context";
import { reportTokenUsage } from "./sync";
import { upsertLocalAiTrace, resetLocalAiTrace } from "./db";
import { codexTraceSnapshotToSegments } from "./codex_trace";

type Sender = { send: (channel: string, ...args: unknown[]) => void };

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
}

interface AcpSession {
  aiSessionId: string;
  providerId: string;
  command: string;
  child: ChildProcessWithoutNullStreams;
  rl: Interface;
  nextRequestId: number;
  pendingRequests: Map<number, PendingRequest>;
  sender: Sender;
  acpSessionId: string | null;
  snapshot: CodexTraceSnapshot | null;
  turnResolver: { resolve: (response: unknown) => void; reject: (error: Error) => void } | null;
  cancelled: boolean;
  closed: boolean;
  stderrBuffer: string;
  reportedUsageKeys: Set<string>;
}

const ACP_TURN_TIMEOUT_MS = 30 * 60_000;
const activeAcpSessions = new Map<string, AcpSession>();
const OPENCODE_COMMAND = "opencode";

function isDirectoryPath(value: string): boolean {
  try {
    return fsSync.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function resolveAcpCwd(cwd: string): string {
  const requested = (cwd || "").trim();
  const candidates = [
    requested ? (path.isAbsolute(requested) ? requested : path.resolve(requested)) : "",
    os.homedir(),
    process.cwd(),
  ].filter(Boolean);
  return candidates.find(isDirectoryPath) ?? os.homedir();
}

function snapshotBase(provider: string, now: string): CodexTraceSnapshot {
  return {
    provider,
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function emitTrace(session: AcpSession, snapshot: CodexTraceSnapshot, rawEvent?: unknown): void {
  const trace = upsertLocalAiTrace({
    aiSessionId: session.aiSessionId,
    providerId: session.providerId,
    traceKind: session.providerId,
    status: snapshot.status,
    rawEvent,
    snapshot,
    finalText: snapshot.finalText,
  });
  session.sender.send("ai-trace-update", {
    aiSessionId: session.aiSessionId,
    trace: {
      ...trace,
      segments: codexTraceSnapshotToSegments(snapshot),
    },
  });
}

// Reduce an ACP `session/update` notification into the shared snapshot.
function reduceAcpSnapshot(
  previous: CodexTraceSnapshot | null,
  provider: string,
  update: unknown,
  receivedAt: string,
): CodexTraceSnapshot {
  const now = receivedAt;
  let snapshot = previous ?? snapshotBase(provider, now);
  snapshot = { ...snapshot, updatedAt: now };

  const u = record(update);
  const kind = str(u.sessionUpdate) ?? str(u.type) ?? "unknown";

  switch (kind) {
    case "agent_message_chunk": {
      const content = record(u.content);
      const text = str(content.text) ?? "";
      if (text) {
        snapshot = { ...snapshot, finalText: snapshot.finalText + text };
      }
      break;
    }
    case "usage_update": {
      const used = num(u.used) ?? num(u.total);
      if (used && used > 0 && !snapshot.threadId) {
        // usage_update 早期到达时还没有 threadId，仅记录
      }
      break;
    }
    case "tool_call": {
      const title = str(u.name) ?? str(u.toolName) ?? "工具调用";
      const item: CodexTraceItem = {
        id: str(u.id) ?? `acp-tool-${Date.now()}`,
        type: "tool",
        title,
        status: u.status === "completed" ? "completed" : "running",
        text: str(u.input) ?? "",
        rawItemType: kind,
        startedAt: now,
        completedAt: u.status === "completed" ? now : null,
      };
      snapshot = { ...snapshot, items: [...snapshot.items, item] };
      break;
    }
    case "tool_result":
    case "tool_call_update": {
      const status = str(u.status) === "completed" ? "completed" : "running";
      snapshot = {
        ...snapshot,
        items: snapshot.items.map((item) =>
          item.rawItemType === "tool_call" && item.status === "running"
            ? { ...item, status: status === "completed" ? "completed" : "running", completedAt: status === "completed" ? now : null }
            : item,
        ),
      };
      break;
    }
    case "error": {
      const message = str(u.message) ?? "ACP 执行出错";
      snapshot = {
        ...snapshot,
        errors: [...snapshot.errors, { message, at: now }],
      };
      break;
    }
    default:
      // available_commands_update / current_mode_update / config_option_update 等
      // 不影响对话展示，静默忽略
      break;
  }

  return snapshot;
}

function send(session: AcpSession, method: string, params: unknown): Promise<JsonRpcResponse> {
  const id = session.nextRequestId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    session.pendingRequests.set(id, { resolve, reject });
    session.child.stdin.write(msg);
  });
}

function notify(session: AcpSession, method: string, params: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  session.child.stdin.write(msg);
}

function handleLine(session: AcpSession, line: string): void {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;

  // Response to a client request (has id, has result or error)
  if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    const pending = session.pendingRequests.get(msg.id);
    if (pending) {
      session.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "ACP 请求失败"));
      } else {
        pending.resolve(msg);
      }
    }
    return;
  }

  // Server request (has both id and method) — must answer or the turn hangs
  if (typeof msg.id === "number" && typeof msg.method === "string") {
    // ACP 暂无已知需要客户端应答的 server request；空 result 应答避免挂起
    session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
    return;
  }

  // Notification (has method, no id)
  if (typeof msg.method === "string") {
    handleNotification(session, msg.method, msg.params);
  }
}

function handleNotification(session: AcpSession, method: string, params: unknown): void {
  const now = new Date().toISOString();

  if (method === "session/update") {
    const p = record(params);
    const update = p.update ?? {};
    // 同步 ACP sessionId
    const sid = str(p.sessionId);
    if (sid && !session.acpSessionId) session.acpSessionId = sid;

    session.snapshot = reduceAcpSnapshot(session.snapshot, session.providerId, update, now);
    emitTrace(session, session.snapshot, { method, params, receivedAt: now });
    return;
  }

  // 其他通知暂不处理
}

function reportAcpUsage(session: AcpSession, response: unknown): void {
  const r = record(response);
  const usage = record(r.usage);
  const inputTokens = num(usage.inputTokens) ?? num(usage.input_tokens) ?? 0;
  const cachedInputTokens = Math.min(inputTokens, Math.max(0,
    num(usage.cachedInputTokens)
      ?? num(usage.cached_input_tokens)
      ?? num(usage.cacheReadInputTokens)
      ?? num(usage.cache_read_input_tokens)
      ?? 0));
  const outputTokens = num(usage.outputTokens) ?? num(usage.output_tokens) ?? 0;
  const totalTokens = num(usage.totalTokens) ?? num(usage.total_tokens) ?? (inputTokens + outputTokens);
  if (totalTokens <= 0) return;
  const key = `${session.aiSessionId}:${totalTokens}:${inputTokens}:${cachedInputTokens}:${outputTokens}`;
  if (session.reportedUsageKeys.has(key)) return;
  session.reportedUsageKeys.add(key);
  void reportTokenUsage({
    aiSessionId: session.aiSessionId,
    providerId: session.providerId,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens,
  });
}

function spawnAcpSession(
  aiSessionId: string,
  cwd: string,
  sender: Sender,
): AcpSession {
  const command = OPENCODE_COMMAND;
  const resolvedCwd = resolveAcpCwd(cwd);
  const child = spawn(command, ["acp"], {
    cwd: resolvedCwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
  });

  const session: AcpSession = {
    aiSessionId,
    providerId: "opencode",
    command,
    child,
    rl: createInterface({ input: child.stdout, terminal: false }),
    nextRequestId: 1,
    pendingRequests: new Map(),
    sender,
    acpSessionId: null,
    snapshot: null,
    turnResolver: null,
    cancelled: false,
    closed: false,
    stderrBuffer: "",
    reportedUsageKeys: new Set(),
  };

  session.rl.on("line", (line) => handleLine(session, line));
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    session.stderrBuffer += chunk;
  });
  child.on("error", (error) => {
    failSession(session, `启动 ${command} acp 失败：${error.message}`);
  });
  child.on("close", () => {
    session.closed = true;
    if (session.turnResolver && !session.cancelled) {
      session.turnResolver.reject(new Error(`${command} 进程意外退出`));
      session.turnResolver = null;
    }
  });

  return session;
}

function failSession(session: AcpSession, message: string): void {
  const now = new Date().toISOString();
  const snapshot: CodexTraceSnapshot = {
    ...(session.snapshot ?? snapshotBase(session.providerId, now)),
    status: "failed",
    updatedAt: now,
    completedAt: now,
    errors: [...(session.snapshot?.errors ?? []), { message, at: now }],
  };
  session.snapshot = snapshot;
  emitTrace(session, snapshot);
  if (session.turnResolver) {
    session.turnResolver.reject(new Error(message));
    session.turnResolver = null;
  }
}

function teardown(session: AcpSession): void {
  try {
    if (!session.closed) session.child.kill();
  } catch {
    // ignore
  }
  activeAcpSessions.delete(session.aiSessionId);
}

async function ensureInitialized(session: AcpSession): Promise<void> {
  await send(session, "initialize", {
    protocolVersion: 1,
    clientInfo: { name: "CodeHub AI", version: "0.1.0" },
  });
}

async function createAcpSession(session: AcpSession, cwd: string): Promise<string> {
  const resp = await send(session, "session/new", { cwd, mcpServers: [] });
  const result = record(resp.result);
  const sessionId = str(result.sessionId);
  if (!sessionId) throw new Error("session/new 未返回 sessionId");
  session.acpSessionId = sessionId;
  return sessionId;
}

async function loadAcpSession(session: AcpSession, sessionId: string, cwd: string): Promise<void> {
  await send(session, "session/load", { sessionId, cwd, mcpServers: [] });
  session.acpSessionId = sessionId;
}

async function setConfigOption(session: AcpSession, configId: string, value: string): Promise<void> {
  if (!session.acpSessionId || !value) return;
  try {
    await send(session, "session/set_config_option", {
      sessionId: session.acpSessionId,
      configId,
      value,
    });
  } catch {
    // 设置失败不阻断主流程，用默认配置继续
  }
}

function extractAcpConfigOptions(configOptions: unknown[]): AcpConfigOptions {
  const models: AcpConfigOption[] = [];
  const efforts: AcpConfigOption[] = [];
  const modes: AcpConfigOption[] = [];
  for (const opt of configOptions) {
    const o = record(opt);
    const id = str(o.id) ?? "";
    const currentValue = str(o.currentValue);
    const options = Array.isArray(o.options) ? o.options : [];
    const mapped: AcpConfigOption[] = options.map((op) => {
      const p = record(op);
      const value = str(p.value) ?? "";
      return { value, name: str(p.name) ?? value, isDefault: value === currentValue || undefined };
    }).filter((m) => m.value);
    if (id === "model") models.push(...mapped);
    else if (id === "effort" || o.category === "thought_level") efforts.push(...mapped);
    else if (id === "mode") modes.push(...mapped);
  }
  return { models, efforts, modes };
}

/**
 * Probe OpenCode ACP for its available config options (models, reasoning
 * effort levels, and session modes).
 */
export async function listOpenCodeConfigOptions(cwd: string): Promise<AcpConfigOptions> {
  const command = OPENCODE_COMMAND;
  const resolvedCwd = resolveAcpCwd(cwd);
  const child = spawn(command, ["acp"], {
    cwd: resolvedCwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
  });
  const rl = createInterface({ input: child.stdout, terminal: false });
  let nextId = 1;
  const pending = new Map<number, (msg: JsonRpcResponse) => void>();

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcResponse;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)!;
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  function sendOnce(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`${method} 超时`)), 15000);
    });
  }

  try {
    const initResp = await sendOnce("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "CodeHub AI", version: "0.1.0" },
    });
    if (initResp.error) throw new Error(initResp.error.message);
    const newResp = await sendOnce("session/new", { cwd: resolvedCwd, mcpServers: [] });
    if (newResp.error) throw new Error(newResp.error.message);
    const result = record(newResp.result);
    const configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
    return extractAcpConfigOptions(configOptions);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
}

async function runPrompt(session: AcpSession, promptText: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.turnResolver = { resolve, reject };
    const timeout = setTimeout(() => {
      if (session.turnResolver) {
        session.turnResolver.reject(new Error(`ACP 会话超时（${ACP_TURN_TIMEOUT_MS / 60_000} 分钟）`));
        session.turnResolver = null;
      }
    }, ACP_TURN_TIMEOUT_MS);

    send(session, "session/prompt", {
      sessionId: session.acpSessionId,
      prompt: [{ type: "text", text: promptText }],
    })
      .then((resp) => {
        clearTimeout(timeout);
        if (session.turnResolver) {
          const r = session.turnResolver;
          session.turnResolver = null;
          r.resolve(resp.result);
        }
      })
      .catch((error) => {
        clearTimeout(timeout);
        if (session.turnResolver) {
          const r = session.turnResolver;
          session.turnResolver = null;
          r.reject(error);
        }
      });
  });
}

function acpDesktopPrompt(): string {
  return [
    "你是 CodeHub AI 桌面端的编程助手。",
    "请严格遵守以下规则：",
    "1. 必须使用中文回复用户。",
    "2. 必须实际执行读取命令（如 ls / cat / grep / find）来了解项目结构和文件内容，不能仅凭推测回答。",
    "3. 在执行任何修改性命令前，先告知用户你打算做什么。",
    "4. 命令执行结果要如实地反馈给用户。",
  ].join("\n");
}

function buildAcpPrompt(req: RunAiChatRequest): string {
  const goal = req.claudeGoal?.trim() ?? req.codexGoal?.trim();
  const imageNote = req.images?.length
    ? `\n\n[用户还粘贴了 ${req.images.length} 张图片，请根据文字描述继续]`
    : "";
  const systemHint = acpDesktopPrompt();
  const prompt = appendChatContexts(req.prompt, req.contexts);
  const userGoal = goal ? `本轮目标：${goal}\n\n用户请求：\n${prompt}` : prompt;
  return `${systemHint}\n\n${userGoal}${imageNote}`;
}

/**
 * Run an OpenCode ACP chat turn. Spawns `opencode acp`,
 * initializes the JSON-RPC connection, creates (or loads) a session, sends
 * session/prompt, and streams trace updates to the sender until the turn
 * completes.
 *
 * Returns the ACP sessionId (providerSessionId) for later reuse via session/load.
 */
export async function runOpenCodeChat(
  req: RunAiChatRequest,
  sender: Sender,
  existingSessionId?: string | null,
): Promise<string> {
  const { aiSessionId, projectPath } = req;
  const providerId = "opencode";
  const cwd = resolveAcpCwd(projectPath);

  // Tear down any previous session for this aiSessionId
  const prev = activeAcpSessions.get(aiSessionId);
  if (prev) teardown(prev);

  const session = spawnAcpSession(aiSessionId, projectPath, sender);
  activeAcpSessions.set(aiSessionId, session);

  const now = new Date().toISOString();
  session.snapshot = snapshotBase(providerId, now);
  resetLocalAiTrace({
    aiSessionId,
    providerId,
    traceKind: providerId,
    status: "running",
    snapshot: session.snapshot,
  });
  emitTrace(session, session.snapshot);

  try {
    await ensureInitialized(session);

    let acpSessionId: string;
    if (existingSessionId) {
      try {
        await loadAcpSession(session, existingSessionId, cwd);
        acpSessionId = existingSessionId;
      } catch {
        // load 失败（会话不存在等），降级为新建
        acpSessionId = await createAcpSession(session, cwd);
      }
    } else {
      acpSessionId = await createAcpSession(session, cwd);
    }

    session.snapshot = {
      ...session.snapshot,
      threadId: acpSessionId,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    emitTrace(session, session.snapshot);

    // OpenCode only exposes effort options after the model is selected.
    if (req.opencodeModel) await setConfigOption(session, "model", req.opencodeModel);
    if (req.opencodeEffort) await setConfigOption(session, "effort", req.opencodeEffort);
    if (req.opencodeMode) await setConfigOption(session, "mode", req.opencodeMode);

    const promptResponse = await runPrompt(session, buildAcpPrompt(req));
    reportAcpUsage(session, promptResponse);

    const completedAt = new Date().toISOString();
    const stopReason = str(record(promptResponse).stopReason) ?? "end_turn";
    const finalSnapshot: CodexTraceSnapshot = {
      ...session.snapshot,
      status: session.cancelled ? "canceled" : "completed",
      updatedAt: completedAt,
      completedAt,
    };
    session.snapshot = finalSnapshot;
    emitTrace(session, finalSnapshot);

    return acpSessionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failSnapshot: CodexTraceSnapshot = {
      ...(session.snapshot ?? snapshotBase(providerId, now)),
      status: session.cancelled ? "canceled" : "failed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      errors: [...(session.snapshot?.errors ?? []), { message, at: new Date().toISOString() }],
    };
    session.snapshot = failSnapshot;
    emitTrace(session, failSnapshot);
    if (session.cancelled) return session.acpSessionId ?? "";
    throw error;
  } finally {
    teardown(session);
  }
}

export function stopOpenCodeChat(aiSessionId: string): boolean {
  const session = activeAcpSessions.get(aiSessionId);
  if (!session) return false;
  session.cancelled = true;
  try {
    if (session.acpSessionId) {
      notify(session, "session/cancel", { sessionId: session.acpSessionId });
    }
  } catch {
    // ignore
  }
  const now = new Date().toISOString();
  if (session.snapshot) {
    session.snapshot = {
      ...session.snapshot,
      status: "canceled",
      updatedAt: now,
      completedAt: now,
    };
    emitTrace(session, session.snapshot);
  }
  return true;
}

export function hasLiveOpenCodeChat(): boolean {
  return activeAcpSessions.size > 0;
}
