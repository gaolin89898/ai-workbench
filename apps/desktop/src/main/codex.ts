// Codex app-server integration for the Electron main process.
// Spawns `codex app-server --stdio`, communicates via JSON-RPC 2.0,
// and streams AiChatOutputEvent to the renderer through the sender.
// Mirrors the original Tauri Rust run_codex_chat implementation.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import * as os from "node:os";
import type { RunCodexChatRequest, AiChatOutputEvent, ChatImageAttachment, ChatSegment, CodexApprovalDecision } from "../services/desktop";
import { getLocalAiSession } from "./db";

// Structural sender — WebContents / BrowserWindow satisfy this, and test
// stubs can be passed too.
type Sender = { send: (channel: string, ...args: unknown[]) => void };

// ---------- JSON-RPC 2.0 types ----------

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

interface PendingApproval {
  approvalId: string;
  requestId: number;
  method: string;
  stepId: string;
  segment: Extract<ChatSegment, { type: "approval" }>;
  resolved: boolean;
}

// ---------- Session state ----------

interface CodexSession {
  aiSessionId: string;
  child: ChildProcessWithoutNullStreams;
  rl: Interface;
  threadId: string | null;
  nextRequestId: number;
  pendingRequests: Map<number, PendingRequest>;
  sender: Sender;
  closed: boolean;
  stderrBuffer: string;
  commandOutputBuffers: Map<string, string>;
  agentMessageBuffer: string;
  pendingApprovals: Map<string, PendingApproval>;
  turnResolver: { resolve: () => void; reject: (error: Error) => void } | null;
  errorEmitted: boolean;
  cancelled: boolean;
}

// ---------- Constants ----------

const CODEX_TURN_TIMEOUT_MS = 30 * 60_000;
const CODEX_WARMUP_TIMEOUT_MS = 60_000;
const CODEX_RECONNECT_RETRY_MS = 1200;
const CODEX_RECONNECT_MAX_RETRIES = 5;
const CLI_INTERRUPT_FALLBACK_MS = 1500;
const CODEX_CLIENT_INFO = { name: "AI Workbench", version: "0.1.0" };
const CODEX_APP_SERVER_SESSION_PREFIX = "app-server:";
const activeCodexSessions = new Map<string, CodexSession>();

function spawnCodex(args: string[], cwd: string): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", "codex.cmd", ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn("codex", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ---------- Helpers ----------

function emit(sender: Sender, event: AiChatOutputEvent): void {
  sender.send("ai-chat-output", event);
}

function emitSessionError(session: CodexSession, message: string, detail?: string): void {
  if (session.errorEmitted) return;
  session.errorEmitted = true;
  emit(session.sender, {
    aiSessionId: session.aiSessionId,
    kind: "error",
    segment: { type: "error", message, detail },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isCodexReconnectMessage(message: string): boolean {
  return /^Reconnecting(?:\.\.\.)?\s+\d+\/\d+$/i.test(message.trim());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function extractFileEditPath(item: Record<string, unknown>, parent: Record<string, unknown>): string | undefined {
  return firstString(
    item["path"],
    item["filePath"],
    item["file_path"],
    item["filename"],
    parent["path"],
    parent["filePath"],
    parent["file_path"],
    parent["filename"],
  );
}

function extractFileEditDiff(item: Record<string, unknown>, parent: Record<string, unknown>): string | undefined {
  const candidate = firstString(
    item["diff"],
    item["patch"],
    item["changes"],
    item["change"],
    item["output"],
    item["result"],
    parent["diff"],
    parent["patch"],
    parent["changes"],
    parent["change"],
  );
  if (!candidate) return undefined;
  return looksLikeDiff(candidate) ? candidate : undefined;
}

function looksLikeDiff(value: string): boolean {
  return /(^|\n)(diff --git|@@\s|---\s|\+\+\+\s|[+-][^\n]*)/.test(value);
}

// ---------- Field extraction (defensive — codex API shapes may vary) ----------

function extractThreadId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    const thread = r["thread"] as Record<string, unknown> | undefined;
    const candidate = r["threadId"] ?? r["thread_id"] ?? r["id"] ?? thread?.["id"];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function buildUserInput(text: string, images: ChatImageAttachment[] = []): Array<Record<string, unknown>> {
  return [
    { type: "text", text, text_elements: [] },
    ...images.map((image) => ({
      type: "image",
      url: image.dataUrl,
      detail: "auto",
    })),
  ];
}

function extractItemId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const item = p["item"] as Record<string, unknown> | undefined;
  const id = p["itemId"] ?? item?.["id"] ?? p["id"];
  return typeof id === "string" ? id : undefined;
}

function extractDelta(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const delta = p["delta"] ?? p["text"] ?? p["content"] ?? p["output"] ?? p["chunk"];
  return typeof delta === "string" ? delta : undefined;
}

function extractTurnFinalText(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const turn = p["turn"] as Record<string, unknown> | undefined;
  const response = p["response"] as Record<string, unknown> | undefined;
  const message = p["message"] as Record<string, unknown> | undefined;
  return firstString(
    p["last_agent_message"],
    p["final_message"],
    p["finalText"],
    p["final_text"],
    p["output_text"],
    turn?.["last_agent_message"],
    turn?.["final_message"],
    response?.["output_text"],
    response?.["text"],
    message?.["text"],
  );
}

function extractErrorMessage(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const errObj = p["error"] as Record<string, unknown> | undefined;
  const msg = p["message"] ?? errObj?.["message"] ?? p["error"];
  return typeof msg === "string" ? msg : undefined;
}

function approvalStatusTitle(status: Extract<ChatSegment, { type: "approval" }>["status"], kind: "command" | "fileChange") {
  const noun = kind === "command" ? "命令" : "文件修改";
  switch (status) {
    case "approved":
      return `已同意执行${noun}`;
    case "denied":
      return `已拒绝执行${noun}`;
    case "expired":
      return `${noun}审批已失效`;
    case "failed":
      return `${noun}审批处理失败`;
    default:
      return kind === "command" ? "需要同意后执行命令" : "需要同意后修改文件";
  }
}

function approvalIdFor(requestId: number, params: Record<string, unknown>) {
  const explicit = strOrUndef(params["approvalId"]) ?? strOrUndef(params["callId"]);
  return explicit ? `${requestId}:${explicit}` : `${requestId}`;
}

function approvalStepIdFor(approvalId: string) {
  return `approval-${approvalId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function commandFromApproval(method: string, params: Record<string, unknown>) {
  if (method === "execCommandApproval") {
    const command = arrayOfStrings(params["command"]);
    return command.join(" ");
  }
  return strOrUndef(params["command"]);
}

function fileChangesFromApproval(params: Record<string, unknown>) {
  const fileChanges = params["fileChanges"];
  if (!fileChanges || typeof fileChanges !== "object" || Array.isArray(fileChanges)) return [];
  return Object.keys(fileChanges as Record<string, unknown>);
}

function buildApprovalSegment(
  method: string,
  requestId: number,
  params: unknown
): Extract<ChatSegment, { type: "approval" }> | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  const approvalKind = method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
    ? "fileChange"
    : "command";
  const approvalId = approvalIdFor(requestId, p);
  const stepId = approvalStepIdFor(approvalId);
  const grantRoot = strOrUndef(p["grantRoot"]);
  const command = commandFromApproval(method, p);
  const fileChanges = fileChangesFromApproval(p);
  const reason = strOrUndef(p["reason"]);
  const cwd = strOrUndef(p["cwd"]);
  return {
    type: "approval",
    stepId,
    approvalId,
    approvalKind,
    status: "pending",
    title: approvalStatusTitle("pending", approvalKind),
    reason,
    command,
    cwd,
    grantRoot,
    fileChanges,
  };
}

function isApprovalRequestMethod(method: string) {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "execCommandApproval"
    || method === "applyPatchApproval";
}

// ---------- ChatSegment builders ----------

function buildItemStartedSegment(params: unknown): ChatSegment {
  const p = (params ?? {}) as Record<string, unknown>;
  const item = (p["item"] ?? p) as Record<string, unknown>;
  const itemType = strOrUndef(item["type"]) ?? "unknown";
  const stepId = extractItemId(params);

  switch (itemType) {
    case "reasoning":
      return {
        type: "status",
        stepId,
        label: "正在思考",
        icon: "think",
      };
    case "agentMessage":
      return { type: "text", stepId, text: "" };
    case "commandExecution":
      return {
        type: "tool",
        stepId,
        toolName: strOrUndef(item["toolName"]) ?? "command",
        command: strOrUndef(item["command"]) ?? strOrUndef(item["commandText"]),
        status: "running",
      };
    case "fileEdit":
    case "file_edit":
      return {
        type: "tool",
        stepId,
        toolName: "修改文件",
        command: extractFileEditPath(item, p),
        status: "running",
      };
    default:
      return {
        type: "status",
        stepId,
        label: `执行 ${itemType}`,
        icon: "think",
      };
  }
}

function buildItemCompletedSegment(params: unknown, fallbackOutput?: string): ChatSegment | null {
  const p = (params ?? {}) as Record<string, unknown>;
  const item = (p["item"] ?? p) as Record<string, unknown>;
  const itemType = strOrUndef(item["type"]) ?? "unknown";
  const stepId = extractItemId(params);
  const additions = numOrUndef(item["additions"] ?? p["additions"]);
  const deletions = numOrUndef(item["deletions"] ?? p["deletions"]);

  switch (itemType) {
    case "reasoning":
      return {
        type: "status",
        stepId,
        label: "正在思考",
        icon: "think",
      };
    case "commandExecution":
      return {
        type: "tool",
        stepId,
        toolName: strOrUndef(item["toolName"]) ?? "command",
        command: strOrUndef(item["command"]) ?? strOrUndef(item["commandText"]),
        status: "success",
        output: strOrUndef(item["output"]) ?? strOrUndef(item["result"]) ?? fallbackOutput,
        additions,
        deletions,
      };
    case "fileEdit":
    case "file_edit":
      return {
        type: "tool",
        stepId,
        toolName: "修改文件",
        command: extractFileEditPath(item, p),
        status: "success",
        summary: strOrUndef(item["result"]) ?? strOrUndef(item["summary"]),
        diff: extractFileEditDiff(item, p),
        additions,
        deletions,
      };
    default:
      return null;
  }
}

// ---------- JSON-RPC communication ----------

function sendRequest(
  session: CodexSession,
  method: string,
  params?: unknown
): Promise<JsonRpcResponse> {
  const id = session.nextRequestId++;
  const request = {
    jsonrpc: "2.0" as const,
    id,
    method,
    params: params ?? {},
  };
  return new Promise((resolve, reject) => {
    session.pendingRequests.set(id, { resolve, reject });
    try {
      session.child.stdin.write(JSON.stringify(request) + "\n");
    } catch (err) {
      session.pendingRequests.delete(id);
      reject(new Error(`failed to write request ${method}: ${errorMessage(err)}`));
    }
  });
}

function sendResponse(session: CodexSession, id: number, result: unknown): void {
  if (session.closed) throw new Error("Codex 会话已结束");
  session.child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  }) + "\n");
}

function sendErrorResponse(session: CodexSession, id: number, message: string): void {
  if (session.closed) return;
  session.child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message },
  }) + "\n");
}

function approvalResponseFor(method: string, decision: CodexApprovalDecision) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: decision === "approved" ? "accept" : "decline" };
  }
  return { decision };
}

function updateApprovalSegment(
  session: CodexSession,
  approval: PendingApproval,
  status: Extract<ChatSegment, { type: "approval" }>["status"],
  detail?: string
): void {
  approval.segment = {
    ...approval.segment,
    status,
    title: approvalStatusTitle(status, approval.segment.approvalKind),
    detail,
  };
  emit(session.sender, {
    aiSessionId: session.aiSessionId,
    kind: "step-update",
    stepId: approval.stepId,
    segment: approval.segment,
  });
}

function handleApprovalRequest(
  session: CodexSession,
  method: string,
  id: number,
  params: unknown
): void {
  const segment = buildApprovalSegment(method, id, params);
  if (!segment) {
    sendResponse(session, id, approvalResponseFor(method, "denied"));
    return;
  }
  const approval: PendingApproval = {
    approvalId: segment.approvalId,
    requestId: id,
    method,
    stepId: segment.stepId,
    segment,
    resolved: false,
  };
  session.pendingApprovals.set(segment.approvalId, approval);
  emit(session.sender, {
    aiSessionId: session.aiSessionId,
    kind: "step-start",
    stepId: segment.stepId,
    segment,
  });
}

function resolvePendingApprovals(session: CodexSession, status: "expired" | "failed", detail?: string): void {
  for (const approval of session.pendingApprovals.values()) {
    if (approval.resolved) continue;
    approval.resolved = true;
    updateApprovalSegment(session, approval, status, detail);
  }
  session.pendingApprovals.clear();
}

// ---------- Line / notification handling ----------

function handleLine(session: CodexSession, line: string): void {
  if (session.closed) return; // session already ended — ignore stale lines
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    // non-JSON line — ignore
    return;
  }

  if (!message || typeof message !== "object") return;
  const msg = message as Record<string, unknown>;

  // Server request from Codex app-server. The app must answer this id, or the
  // Codex turn waits indefinitely for approval.
  if (typeof msg["id"] === "number" && typeof msg["method"] === "string") {
    const method = msg["method"] as string;
    if (isApprovalRequestMethod(method)) {
      handleApprovalRequest(session, method, msg["id"] as number, msg["params"]);
      return;
    }
    sendErrorResponse(session, msg["id"] as number, `Unsupported server request: ${method}`);
    return;
  }

  // Response to a request (has numeric id)
  if (typeof msg["id"] === "number") {
    const pending = session.pendingRequests.get(msg["id"] as number);
    if (pending) {
      session.pendingRequests.delete(msg["id"] as number);
      const errorObj = msg["error"] as { message?: string } | undefined;
      if (errorObj) {
        const message = errorObj.message ?? "JSON-RPC error";
        const error = new Error(message);
        if (isCodexReconnectMessage(message)) {
          (error as Error & { reconnecting?: boolean }).reconnecting = true;
        }
        pending.reject(error);
      } else {
        pending.resolve(msg as unknown as JsonRpcResponse);
      }
    }
  }

  // Notification (has method)
  if (typeof msg["method"] === "string") {
    handleNotification(session, msg["method"] as string, msg["params"]);
  }
}

async function sendRequestWithReconnectRetry(
  session: CodexSession,
  method: string,
  params?: unknown
): Promise<JsonRpcResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CODEX_RECONNECT_MAX_RETRIES; attempt += 1) {
    try {
      return await sendRequest(session, method, params);
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      const reconnecting = (error as Error & { reconnecting?: boolean })?.reconnecting
        || isCodexReconnectMessage(message);
      if (!reconnecting || session.closed || attempt >= CODEX_RECONNECT_MAX_RETRIES) break;
      emit(session.sender, {
        aiSessionId: session.aiSessionId,
        kind: "status",
        text: message,
        segment: {
          type: "status",
          stepId: `codex-reconnect-${attempt}`,
          label: "Codex 正在重连",
          detail: message,
          icon: "warn",
        },
      });
      await delay(CODEX_RECONNECT_RETRY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
}

function handleNotification(
  session: CodexSession,
  method: string,
  params: unknown
): void {
  const { aiSessionId, sender } = session;

  switch (method) {
    case "thread/started": {
      const tid = extractThreadId(params);
      if (tid) session.threadId = tid;
      break;
    }
    case "turn/started": {
      session.agentMessageBuffer = "";
      emit(sender, {
        aiSessionId,
        kind: "status",
        text: "running",
        segment: { type: "status", stepId: "runtime-status", label: "Codex 正在执行", icon: "think" },
      });
      break;
    }
    case "item/started": {
      emit(sender, {
        aiSessionId,
        kind: "step-start",
        stepId: extractItemId(params) ?? null,
        segment: buildItemStartedSegment(params),
      });
      break;
    }
    case "item/agentMessage/delta": {
      const delta = extractDelta(params);
      const stepId = extractItemId(params);
      if (delta) {
        session.agentMessageBuffer += delta;
        emit(sender, {
          aiSessionId,
          kind: "delta",
          text: delta,
          phase: "process",
          stepId: stepId ?? null,
        });
      }
      break;
    }
    case "item/commandExecution/outputDelta": {
      const delta = extractDelta(params);
      const stepId = extractItemId(params);
      if (delta && stepId) {
        const prev = session.commandOutputBuffers.get(stepId) ?? "";
        const accumulated = prev + delta;
        session.commandOutputBuffers.set(stepId, accumulated);
        emit(sender, {
          aiSessionId,
          kind: "step-update",
          stepId,
          segment: { type: "tool", stepId, toolName: "command", status: "running", output: accumulated },
        });
      }
      break;
    }
    case "item/completed": {
      const completedStepId = extractItemId(params);
      const completedOutput = completedStepId ? session.commandOutputBuffers.get(completedStepId) : undefined;
      if (completedStepId) session.commandOutputBuffers.delete(completedStepId);
      const segment = buildItemCompletedSegment(params, completedOutput);
      if (!segment) break;
      emit(sender, {
        aiSessionId,
        kind: "step-update",
        stepId: completedStepId ?? null,
        segment,
      });
      break;
    }
    case "turn/completed": {
      emit(sender, {
        aiSessionId,
        kind: "done",
        text: extractTurnFinalText(params) ?? session.agentMessageBuffer,
        phase: "final",
      });
      if (session.turnResolver) {
        session.turnResolver.resolve();
        session.turnResolver = null;
      }
      break;
    }
    case "error": {
      const msg = extractErrorMessage(params) ?? "未知错误";
      if (isCodexReconnectMessage(msg)) {
        emit(sender, {
          aiSessionId,
          kind: "status",
          text: msg,
          segment: {
            type: "status",
            stepId: "codex-reconnecting",
            label: "Codex 正在重连",
            detail: msg,
            icon: "warn",
          },
        });
        break;
      }
      emitSessionError(session, msg);
      if (session.turnResolver) {
        session.turnResolver.reject(new Error(msg));
        session.turnResolver = null;
      }
      break;
    }
    default:
      // unknown notification — ignore
      break;
  }
}

// ---------- Session lifecycle ----------

function createSession(
  aiSessionId: string,
  cwd: string,
  sender: Sender
): CodexSession {
  const child = spawnCodex(["app-server", "--stdio"], cwd);

  const session: CodexSession = {
    aiSessionId,
    child,
    rl: createInterface({ input: child.stdout, terminal: false }),
    threadId: null,
    nextRequestId: 1,
    pendingRequests: new Map(),
    sender,
    closed: false,
    stderrBuffer: "",
    commandOutputBuffers: new Map(),
    agentMessageBuffer: "",
    pendingApprovals: new Map(),
    turnResolver: null,
    errorEmitted: false,
    cancelled: false,
  };

  // stdout: parse JSON-RPC lines
  session.rl.on("line", (line: string) => handleLine(session, line));

  // stderr: accumulate for error reporting
  child.stderr.on("data", (chunk: Buffer) => {
    session.stderrBuffer += chunk.toString();
  });

  // stdin errors (e.g. EPIPE after child exit) — swallow
  child.stdin.on("error", () => {
    // best-effort; child probably already exited
  });

  // child exit
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    handleExit(session, code, signal);
  });

  // child spawn error (e.g. ENOENT when codex is not installed)
  child.on("error", (err: Error) => {
    handleSpawnError(session, err);
  });

  return session;
}

function handleExit(
  session: CodexSession,
  code: number | null,
  signal: NodeJS.Signals | null
): void {
  const detail =
    session.stderrBuffer.trim() || `code=${code} signal=${signal}`;
  if (!session.closed && !session.cancelled) {
    emitSessionError(session, `Codex 进程意外退出：${detail}`);
  }
  const err = new Error(`codex process exited: ${detail}`);
  for (const [, pending] of session.pendingRequests) {
    pending.reject(err);
  }
  session.pendingRequests.clear();
  resolvePendingApprovals(session, "expired", "Codex 会话已结束，审批请求已失效。");
  if (session.turnResolver) {
    session.turnResolver.reject(err);
    session.turnResolver = null;
  }
  session.closed = true;
}

function handleSpawnError(session: CodexSession, err: Error): void {
  const errno = err as NodeJS.ErrnoException;
  const message =
    errno.code === "ENOENT"
      ? "未找到 codex 命令，请先安装 Codex CLI"
      : `Codex 进程错误：${err.message}`;
  emitSessionError(session, message);
  for (const [, pending] of session.pendingRequests) {
    pending.reject(err);
  }
  session.pendingRequests.clear();
  resolvePendingApprovals(session, "failed", message);
  if (session.turnResolver) {
    session.turnResolver.reject(err);
    session.turnResolver = null;
  }
  session.closed = true;
}

function killSession(session: CodexSession): void {
  if (session.closed) return;
  resolvePendingApprovals(session, "expired", "Codex 会话已结束，审批请求已失效。");
  session.closed = true;
  try {
    session.rl.close();
  } catch {
    // ignore
  }
  try {
    session.child.stdin.end();
  } catch {
    // ignore
  }
  try {
    session.child.kill();
  } catch {
    // ignore
  }
}

function interruptSession(session: CodexSession): void {
  if (session.closed) return;
  resolvePendingApprovals(session, "expired", "用户已中断当前 AI 会话。");
  session.closed = true;
  try {
    session.rl.close();
  } catch {
    // ignore
  }
  try {
    session.child.kill("SIGINT");
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (session.child.killed || session.child.exitCode !== null || session.child.signalCode !== null) return;
    try {
      session.child.stdin.end();
    } catch {
      // ignore
    }
    try {
      session.child.kill();
    } catch {
      // ignore
    }
  }, CLI_INTERRUPT_FALLBACK_MS);
}

// ---------- Thread management ----------

function lookupExistingProviderSessionId(aiSessionId: string): string | null {
  try {
    const providerSessionId = getLocalAiSession(aiSessionId)?.providerSessionId ?? null;
    return decodeAppServerProviderSessionId(providerSessionId);
  } catch {
    return null;
  }
}

function encodeAppServerProviderSessionId(threadId: string): string {
  return threadId.startsWith(CODEX_APP_SERVER_SESSION_PREFIX)
    ? threadId
    : `${CODEX_APP_SERVER_SESSION_PREFIX}${threadId}`;
}

function decodeAppServerProviderSessionId(providerSessionId: string | null): string | null {
  if (!providerSessionId) return null;
  return providerSessionId.startsWith(CODEX_APP_SERVER_SESSION_PREFIX)
    ? providerSessionId.slice(CODEX_APP_SERVER_SESSION_PREFIX.length)
    : providerSessionId;
}

async function ensureThread(
  session: CodexSession,
  aiSessionId: string
): Promise<string> {
  if (session.threadId) return session.threadId;

  // Try to resume from a DB-stored providerSessionId
  const existing = lookupExistingProviderSessionId(aiSessionId);
  if (existing) {
    try {
      const resp = await sendRequestWithReconnectRetry(session, "thread/resume", {
        threadId: existing,
      });
      const tid = extractThreadId(resp.result) ?? existing;
      session.threadId = tid;
      return tid;
    } catch {
      // resume failed — fall back to thread/start
    }
  }

  const resp = await sendRequestWithReconnectRetry(session, "thread/start", {});
  const tid = extractThreadId(resp.result);
  if (!tid) {
    throw new Error("未能从 codex 获取 threadId");
  }
  session.threadId = tid;
  return tid;
}

// ---------- Public API ----------

/**
 * Run a Codex chat turn. Spawns `codex app-server --stdio`, initializes the
 * JSON-RPC connection, starts (or resumes) a thread, sends turn/start, and
 * streams AiChatOutputEvent to the sender until the turn completes.
 *
 * Returns the app-server tagged threadId (providerSessionId).
 */
export async function runCodexChat(
  req: RunCodexChatRequest,
  sender: Sender
): Promise<string> {
  const { aiSessionId, projectPath, prompt, images = [] } = req;
  const session = createSession(aiSessionId, projectPath, sender);
  activeCodexSessions.set(aiSessionId, session);

  const timeout = setTimeout(() => {
    emitSessionError(session, "Codex 会话超时（30 分钟）");
    if (session.turnResolver) {
      session.turnResolver.reject(new Error("timeout"));
      session.turnResolver = null;
    }
    for (const [, pending] of session.pendingRequests) {
      pending.reject(new Error("timeout"));
    }
    session.pendingRequests.clear();
    resolvePendingApprovals(session, "expired", "Codex 会话超时，审批请求已失效。");
    killSession(session);
  }, CODEX_TURN_TIMEOUT_MS);

  try {
    // 1. initialize
    await sendRequestWithReconnectRetry(session, "initialize", { clientInfo: CODEX_CLIENT_INFO });

    // 2. start or resume thread
    const threadId = await ensureThread(session, aiSessionId);

    // 3. set up turn-completion promise (resolved by turn/completed,
    //    rejected by error notification / child exit / timeout)
    const turnDone = new Promise<void>((resolve, reject) => {
      session.turnResolver = { resolve, reject };
    });

    // 4. send turn/start with the user's prompt exactly as entered.
    await sendRequestWithReconnectRetry(session, "turn/start", {
      threadId,
      input: buildUserInput(prompt, images),
    });

    // 5. wait for turn/completed or error
    await turnDone;

    clearTimeout(timeout);
    killSession(session);
    return encodeAppServerProviderSessionId(threadId);
  } catch (err) {
    clearTimeout(timeout);
    if (session.cancelled) {
      killSession(session);
      return session.threadId ? encodeAppServerProviderSessionId(session.threadId) : "";
    }
    if (!session.cancelled) {
      emitSessionError(session, errorMessage(err));
    }
    killSession(session);
    throw err;
  } finally {
    if (activeCodexSessions.get(aiSessionId) === session) {
      activeCodexSessions.delete(aiSessionId);
    }
  }
}

export function stopCodexChat(aiSessionId: string): boolean {
  const session = activeCodexSessions.get(aiSessionId);
  if (!session) return false;
  session.cancelled = true;
  emit(session.sender, {
    aiSessionId,
    kind: "done",
    text: "",
    segment: {
      type: "status",
      stepId: "interrupted",
      label: "已中断",
      icon: "warn",
    },
  });
  const error = new Error("AI chat stopped by user");
  for (const [, pending] of session.pendingRequests) {
    pending.reject(error);
  }
  session.pendingRequests.clear();
  resolvePendingApprovals(session, "expired", "用户已中断当前 AI 会话。");
  if (session.turnResolver) {
    session.turnResolver.reject(error);
    session.turnResolver = null;
  }
  interruptSession(session);
  activeCodexSessions.delete(aiSessionId);
  return true;
}

export function respondCodexApproval(
  aiSessionId: string,
  approvalId: string,
  decision: CodexApprovalDecision
): boolean {
  const session = activeCodexSessions.get(aiSessionId);
  if (!session) return false;
  const approval = session.pendingApprovals.get(approvalId);
  if (!approval || approval.resolved) return false;
  approval.resolved = true;
  try {
    sendResponse(session, approval.requestId, approvalResponseFor(approval.method, decision));
    updateApprovalSegment(
      session,
      approval,
      decision,
      decision === "approved" ? "用户已同意本次操作。" : "用户已拒绝本次操作。"
    );
    session.pendingApprovals.delete(approvalId);
    return true;
  } catch (error) {
    updateApprovalSegment(session, approval, "failed", errorMessage(error));
    session.pendingApprovals.delete(approvalId);
    return false;
  }
}

/**
 * Pre-warm a Codex session by performing initialize + thread/start without
 * sending a turn. Returns the app-server tagged threadId for later reuse via thread/resume.
 *
 * Best-effort: on any failure returns an empty string.
 */
export async function warmupCodexSession(
  aiSessionId: string,
  sender: Sender
): Promise<{ providerSessionId: string }> {
  // warmup has no projectPath — use home dir as a safe cwd
  const cwd = os.homedir();
  const session = createSession(aiSessionId, cwd, sender);

  const timeout = setTimeout(() => {
    for (const [, pending] of session.pendingRequests) {
      pending.reject(new Error("timeout"));
    }
    session.pendingRequests.clear();
    resolvePendingApprovals(session, "expired", "Codex 预热超时。");
    killSession(session);
  }, CODEX_WARMUP_TIMEOUT_MS);

  try {
    await sendRequestWithReconnectRetry(session, "initialize", { clientInfo: CODEX_CLIENT_INFO });
    const threadId = await ensureThread(session, aiSessionId);
    clearTimeout(timeout);
    killSession(session);
    return { providerSessionId: encodeAppServerProviderSessionId(threadId) };
  } catch {
    clearTimeout(timeout);
    killSession(session);
    return { providerSessionId: "" };
  }
}
