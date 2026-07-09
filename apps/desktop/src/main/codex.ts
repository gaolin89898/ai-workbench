// Codex app-server integration for the Electron main process.
// Spawns `codex app-server --stdio`, communicates via JSON-RPC 2.0,
// and streams Codex trace updates to the renderer through the sender.
// Mirrors the original Tauri Rust run_codex_chat implementation.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RunCodexChatRequest, ChatImageAttachment, ChatSegment, CodexApprovalDecision, CodexApprovalMode, CodexTraceSnapshot, CodexModelOption } from "../services/desktop";
import { reportTokenUsage } from "./sync";
import { getLocalAiSession, resetLocalAiTrace, upsertLocalAiTrace } from "./db";
import { codexTraceSnapshotToSegments, reduceCodexTraceSnapshot, type CodexRawTraceEvent } from "./codex_trace";

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

interface CodexThreadInfo {
  threadId: string;
  model: string | null;
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
  pendingApprovals: Map<string, PendingApproval>;
  traceEnabled: boolean;
  traceSnapshot: CodexTraceSnapshot | null;
  traceDirty: boolean;
  traceFlushTimer: ReturnType<typeof setTimeout> | null;
  turnResolver: { resolve: () => void; reject: (error: Error) => void } | null;
  errorEmitted: boolean;
  cancelled: boolean;
  approvalMode: CodexApprovalMode;
  reportedTokenUsageKeys: Set<string>;
  currentTurnStartedAtMs: number | null;
  launchCommand: string;
  launchDiagnostics: string[];
}

// ---------- Constants ----------

const CODEX_TURN_TIMEOUT_MS = 30 * 60_000;
const CODEX_TRACE_FLUSH_MS = 120;
const CODEX_WARMUP_TIMEOUT_MS = 60_000;
const CODEX_RECONNECT_RETRY_MS = 1200;
const CODEX_RECONNECT_MAX_RETRIES = 5;
const CLI_INTERRUPT_FALLBACK_MS = 1500;
const CODEX_CLIENT_INFO = { name: "AI Workbench", version: "0.1.0" };
const CODEX_INITIALIZE_PARAMS = {
  clientInfo: CODEX_CLIENT_INFO,
  capabilities: { experimentalApi: true },
};
const CODEX_APP_SERVER_SESSION_PREFIX = "app-server:";
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const activeCodexSessions = new Map<string, CodexSession>();
const codexSessionFileCache = new Map<string, string | null>();

interface CodexSpawnResult {
  child: ChildProcessWithoutNullStreams;
  launchCommand: string;
  launchDiagnostics: string[];
}

interface WindowsCodexCandidate {
  kind: "exe" | "cmd";
  path: string;
  source: string;
}

function windowsPathKey(env: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const value = raw?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function windowsUserHomes(): string[] {
  return uniquePaths([process.env["USERPROFILE"], os.homedir()]);
}

function windowsCodexPathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = windowsUserHomes();
  const localAppDataDirs = uniquePaths([
    env["LOCALAPPDATA"],
    ...homes.map((home) => path.join(home, "AppData", "Local")),
  ]);
  const appDataDirs = uniquePaths([
    env["APPDATA"],
    ...homes.map((home) => path.join(home, "AppData", "Roaming")),
  ]);
  return uniquePaths([
    ...localAppDataDirs.map((dir) => path.join(dir, "Programs", "OpenAI", "Codex", "bin")),
    ...appDataDirs.map((dir) => path.join(dir, "npm")),
    env["ProgramFiles"] ? path.join(env["ProgramFiles"], "OpenAI", "Codex", "bin") : null,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "OpenAI", "Codex", "bin") : null,
  ]);
}

function windowsCodexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const pathKey = windowsPathKey(env);
  const existingPath = env[pathKey] ?? "";
  const parts = existingPath.split(path.delimiter).filter(Boolean);
  const seen = new Set(parts.map((part) => part.toLowerCase()));
  for (const dir of windowsCodexPathDirs(env)) {
    const key = dir.toLowerCase();
    if (!seen.has(key)) {
      parts.push(dir);
      seen.add(key);
    }
  }
  env[pathKey] = parts.join(path.delimiter);
  return env;
}

function windowsCodexCandidates(env: NodeJS.ProcessEnv): WindowsCodexCandidate[] {
  const pathKey = windowsPathKey(env);
  const pathDirs = (env[pathKey] ?? "").split(path.delimiter).filter(Boolean);
  const configuredPath = env["CODEX_CLI_PATH"];
  const configuredKind = configuredPath?.toLowerCase().endsWith(".cmd") ? "cmd" : "exe";
  const configured = configuredPath
    ? [{ kind: configuredKind as "exe" | "cmd", path: configuredPath, source: "CODEX_CLI_PATH" }]
    : [];
  const knownDirs = windowsCodexPathDirs(env);
  return [
    ...configured,
    ...knownDirs.map((dir) => ({ kind: "cmd" as const, path: path.join(dir, "codex.cmd"), source: "known Codex directory" })),
    ...pathDirs.map((dir) => ({ kind: "cmd" as const, path: path.join(dir, "codex.cmd"), source: "PATH" })),
    ...knownDirs.map((dir) => ({ kind: "exe" as const, path: path.join(dir, "codex.exe"), source: "known Codex directory" })),
    ...pathDirs.map((dir) => ({ kind: "exe" as const, path: path.join(dir, "codex.exe"), source: "PATH" })),
  ];
}

function createWindowsCodexSpawn(args: string[], cwd: string): CodexSpawnResult {
  const env = windowsCodexEnv();
  const candidates = windowsCodexCandidates(env);
  const diagnostics = candidates.map((candidate) => {
    const exists = fsSync.existsSync(candidate.path) ? "found" : "missing";
    return `${exists}: ${candidate.path} (${candidate.source})`;
  });
  const candidate = candidates.find((item) => fsSync.existsSync(item.path));
  if (candidate?.kind === "exe") {
    return {
      child: spawn(candidate.path, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env }),
      launchCommand: `${candidate.path} ${args.join(" ")}`,
      launchDiagnostics: diagnostics,
    };
  }
  if (candidate?.kind === "cmd") {
    const command = process.env["ComSpec"] || "cmd.exe";
    const commandArgs = ["/d", "/s", "/c", candidate.path, ...args];
    return {
      child: spawn(command, commandArgs, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env }),
      launchCommand: `${command} ${commandArgs.join(" ")}`,
      launchDiagnostics: diagnostics,
    };
  }
  const command = process.env["ComSpec"] || "cmd.exe";
  const commandArgs = ["/d", "/s", "/c", "codex", ...args];
  return {
    child: spawn(command, commandArgs, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env }),
    launchCommand: `${command} ${commandArgs.join(" ")}`,
    launchDiagnostics: diagnostics,
  };
}

function spawnCodex(args: string[], cwd: string): CodexSpawnResult {
  if (process.platform === "win32") return createWindowsCodexSpawn(args, cwd);
  return {
    child: spawn("codex", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }),
    launchCommand: `codex ${args.join(" ")}`,
    launchDiagnostics: [],
  };
}

// ---------- Helpers ----------

function flushTrace(session: CodexSession, rawEvent?: CodexRawTraceEvent): void {
  if (!session.traceEnabled || !session.traceSnapshot || !session.traceDirty) return;
  if (session.traceFlushTimer) {
    clearTimeout(session.traceFlushTimer);
    session.traceFlushTimer = null;
  }
  session.traceDirty = false;
  const trace = upsertLocalAiTrace({
    aiSessionId: session.aiSessionId,
    providerId: "codex",
    traceKind: "codex",
    status: session.traceSnapshot.status,
    rawEvent,
    snapshot: session.traceSnapshot,
    finalText: session.traceSnapshot.finalText,
  });
  session.sender.send("ai-trace-update", {
    aiSessionId: session.aiSessionId,
    trace: {
      ...trace,
      segments: codexTraceSnapshotToSegments(session.traceSnapshot),
    },
  });
}

function scheduleTraceFlush(session: CodexSession, rawEvent: CodexRawTraceEvent): void {
  session.traceDirty = true;
  const status = session.traceSnapshot?.status;
  if (status === "completed" || status === "failed" || status === "canceled") {
    flushTrace(session, rawEvent);
    return;
  }
  if (session.traceFlushTimer) return;
  session.traceFlushTimer = setTimeout(() => {
    session.traceFlushTimer = null;
    flushTrace(session, rawEvent);
  }, CODEX_TRACE_FLUSH_MS);
}

function emitTrace(session: CodexSession, rawEvent: CodexRawTraceEvent): void {
  if (!session.traceEnabled) return;
  session.traceSnapshot = reduceCodexTraceSnapshot(session.traceSnapshot, rawEvent);
  scheduleTraceFlush(session, rawEvent);
}

function emitTraceMethod(session: CodexSession, method: string, params: unknown): void {
  emitTrace(session, {
    method,
    params,
    receivedAt: new Date().toISOString(),
  });
}

function emitSessionError(session: CodexSession, message: string, detail?: string): void {
  if (session.errorEmitted) return;
  session.errorEmitted = true;
  emitTraceMethod(session, "error", { error: { message, detail } });
  flushTrace(session);
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

function trimmedOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function codexReasoningEffort(v: unknown): string | null {
  const value = trimmedOrNull(v);
  return value === "low" || value === "medium" || value === "high" || value === "ultra" ? value : null;
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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

function extractThreadInfo(value: unknown, fallbackThreadId?: string | null): CodexThreadInfo | null {
  const threadId = extractThreadId(value) ?? fallbackThreadId ?? null;
  if (!threadId) return null;
  let model: string | null = null;
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    const directModel = r["model"];
    if (typeof directModel === "string" && directModel.trim()) model = directModel;
    const threadSettings = r["threadSettings"];
    if (!model && threadSettings && typeof threadSettings === "object") {
      const settingsModel = (threadSettings as Record<string, unknown>)["model"];
      if (typeof settingsModel === "string" && settingsModel.trim()) model = settingsModel;
    }
  }
  return { threadId, model };
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
  emitTraceMethod(session, "approval/resolved", {
    approvalId: approval.approvalId,
    status,
    detail,
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
  emitTraceMethod(session, "approval/requested", {
    approvalId: segment.approvalId,
    approvalKind: segment.approvalKind,
    command: segment.command,
    cwd: segment.cwd,
    fileChanges: segment.fileChanges,
    reason: segment.reason,
  });
  if (session.approvalMode === "autoEdit" || session.approvalMode === "fullAccess") {
    approval.resolved = true;
    sendResponse(session, id, approvalResponseFor(method, "approved"));
    updateApprovalSegment(session, approval, "approved", session.approvalMode === "fullAccess" ? "已根据完全访问权限自动批准。" : "已根据替我审批自动批准。");
    return;
  }
  session.pendingApprovals.set(segment.approvalId, approval);
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
        reportCodexTokenUsage(session, msg);
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
      emitTraceMethod(session, "status", { id: `codex-reconnect-${attempt}`, message });
      await delay(CODEX_RECONNECT_RETRY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
}

// Codex app-server turn/completed 的 params 原生带 output_token_usage，
// 形如 { input_tokens, output_tokens, reasoning_tokens }。提取并上报。
function reportCodexTokenUsage(session: CodexSession, params: unknown): void {
  try {
    const u = findTokenUsageRecord(params);
    if (!u) return;
    reportCodexTokenUsageRecord(session, u);
  } catch {
    // best-effort锛屼笉褰卞搷涓绘祦绋?
  }
}

function reportCodexTokenUsageRecord(session: CodexSession, u: Record<string, unknown>): void {
  try {
    const inputTokens =
      numOrUndef(u["input_tokens"]) ??
      numOrUndef(u["inputTokens"]) ??
      numOrUndef(u["input"]) ??
      0;
    const outputTokens =
      numOrUndef(u["output_tokens"]) ??
      numOrUndef(u["outputTokens"]) ??
      numOrUndef(u["output"]) ??
      0;
    const reasoningTokens =
      numOrUndef(u["reasoning_output_tokens"]) ??
      numOrUndef(u["reasoning_tokens"]) ??
      numOrUndef(u["reasoningTokens"]) ??
      numOrUndef(u["reasoning"]) ??
      0;
    const total = numOrUndef(u["total_tokens"]) ??
      numOrUndef(u["totalTokens"]) ??
      numOrUndef(u["total"]) ??
      (inputTokens + outputTokens + reasoningTokens);
    if (total <= 0) return;
    const dedupeKey = `${inputTokens}:${outputTokens}:${reasoningTokens}:${total}`;
    if (session.reportedTokenUsageKeys.has(dedupeKey)) return;
    session.reportedTokenUsageKeys.add(dedupeKey);
    void reportTokenUsage({
      aiSessionId: session.aiSessionId,
      providerId: "codex",
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens: total,
    });
  } catch {
    // best-effort，不影响主流程
  }
}

async function reportCodexSessionFileTokenUsage(session: CodexSession, threadId: string): Promise<void> {
  const afterMs = session.currentTurnStartedAtMs ?? 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const usage = await readLatestCodexTokenUsage(threadId, afterMs).catch(() => null);
    if (usage) {
      reportCodexTokenUsageRecord(session, usage);
      return;
    }
    await delay(120);
  }
}

async function readLatestCodexTokenUsage(threadId: string, afterMs: number): Promise<Record<string, unknown> | null> {
  const filePath = await findCodexSessionFile(threadId);
  if (!filePath) return null;
  const content = await fs.readFile(filePath, "utf8");
  let latest: Record<string, unknown> | null = null;
  let latestAt = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = typeof parsed["timestamp"] === "string" ? Date.parse(parsed["timestamp"]) : 0;
    if (Number.isFinite(timestamp) && timestamp < afterMs) continue;
    const payload = parsed["payload"];
    if (!payload || typeof payload !== "object") continue;
    const payloadRecord = payload as Record<string, unknown>;
    if (payloadRecord["type"] !== "token_count") continue;
    const info = payloadRecord["info"];
    if (!info || typeof info !== "object") continue;
    const usage = (info as Record<string, unknown>)["last_token_usage"];
    if (!usage || typeof usage !== "object" || !hasTokenUsageShape(usage as Record<string, unknown>)) continue;
    if (timestamp >= latestAt) {
      latestAt = timestamp;
      latest = usage as Record<string, unknown>;
    }
  }
  return latest;
}

async function findCodexSessionFile(threadId: string): Promise<string | null> {
  if (codexSessionFileCache.has(threadId)) return codexSessionFileCache.get(threadId) ?? null;
  const files = await collectCodexRolloutFiles(CODEX_SESSIONS_DIR);
  for (const filePath of files) {
    const firstLine = await readFirstLine(filePath).catch(() => "");
    if (!firstLine) continue;
    try {
      const parsed = JSON.parse(firstLine) as { type?: string; payload?: Record<string, unknown> };
      const payload = parsed.payload;
      const sessionId = typeof payload?.["session_id"] === "string"
        ? payload["session_id"]
        : typeof payload?.["id"] === "string" ? payload["id"] : "";
      if (parsed.type === "session_meta" && sessionId === threadId) {
        codexSessionFileCache.set(threadId, filePath);
        return filePath;
      }
    } catch {
      // ignore malformed rollout files
    }
  }
  codexSessionFileCache.set(threadId, null);
  return null;
}

async function collectCodexRolloutFiles(dir: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectCodexRolloutFiles(fullPath));
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readFirstLine(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = text.indexOf("\n");
    return newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
  } finally {
    await handle.close();
  }
}

function findTokenUsageRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  const record = value as Record<string, unknown>;
  if (hasTokenUsageShape(record)) return record;

  const directKeys = [
    "output_token_usage",
    "outputTokenUsage",
    "token_usage",
    "tokenUsage",
    "usage",
    "tokens",
  ];
  for (const key of directKeys) {
    const nested = findTokenUsageRecord(record[key], depth + 1);
    if (nested) return nested;
  }

  for (const nested of Object.values(record)) {
    const found = findTokenUsageRecord(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function hasTokenUsageShape(record: Record<string, unknown>): boolean {
  return tokenNumber(record["input_tokens"]) ||
    tokenNumber(record["inputTokens"]) ||
    tokenNumber(record["input"]) ||
    tokenNumber(record["output_tokens"]) ||
    tokenNumber(record["outputTokens"]) ||
    tokenNumber(record["output"]) ||
    tokenNumber(record["reasoning_tokens"]) ||
    tokenNumber(record["reasoningTokens"]) ||
    tokenNumber(record["reasoning"]) ||
    tokenNumber(record["total_tokens"]) ||
    tokenNumber(record["totalTokens"]) ||
    tokenNumber(record["total"]);
}

function tokenNumber(value: unknown): boolean {
  return numOrUndef(value) !== undefined;
}

function numOrUndef(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
}

function handleNotification(
  session: CodexSession,
  method: string,
  params: unknown
): void {
  emitTraceMethod(
    session,
    method,
    params,
  );

  switch (method) {
    case "thread/started": {
      const tid = extractThreadId(params);
      if (tid) session.threadId = tid;
      break;
    }
    case "turn/completed": {
      reportCodexTokenUsage(session, params);
      if (session.turnResolver) {
        session.turnResolver.resolve();
        session.turnResolver = null;
      }
      break;
    }
    case "error": {
      const msg = extractErrorMessage(params) ?? "未知错误";
      if (!isCodexReconnectMessage(msg)) emitSessionError(session, msg);
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
  sender: Sender,
  traceEnabled = false,
  approvalMode: CodexApprovalMode = "suggest",
): CodexSession {
  const launchedCodex = spawnCodex(["app-server", "--stdio"], cwd);
  const child = launchedCodex.child;

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
    pendingApprovals: new Map(),
    traceEnabled,
    traceSnapshot: null,
    traceDirty: false,
    traceFlushTimer: null,
    turnResolver: null,
    errorEmitted: false,
    cancelled: false,
    approvalMode,
    reportedTokenUsageKeys: new Set(),
    currentTurnStartedAtMs: null,
    launchCommand: launchedCodex.launchCommand,
    launchDiagnostics: launchedCodex.launchDiagnostics,
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
  resolvePendingApprovals(session, "expired", "Codex session ended; approval requests expired.");
  flushTrace(session);
  if (session.turnResolver) {
    session.turnResolver.reject(err);
    session.turnResolver = null;
  }
  session.closed = true;
}

function handleSpawnError(session: CodexSession, err: Error): void {
  const errno = err as NodeJS.ErrnoException;
  const baseMessage = errno.code === "ENOENT"
    ? "未找到 codex 命令，请先安装 Codex CLI，或在 CODEX_CLI_PATH 中配置 codex.exe / codex.cmd 的完整路径"
    : `Codex 进程错误：${err.message}`;
  const diagnosticLines = [
    baseMessage,
    `启动方式：${session.launchCommand}`,
    `错误代码：${errno.code ?? "unknown"}`,
    ...session.launchDiagnostics.slice(0, 16).map((line) => `候选路径：${line}`),
  ];
  const message = diagnosticLines.join("\n");
  emitSessionError(session, message);
  for (const [, pending] of session.pendingRequests) {
    pending.reject(err);
  }
  session.pendingRequests.clear();
  resolvePendingApprovals(session, "failed", message);
  flushTrace(session);
  if (session.turnResolver) {
    session.turnResolver.reject(err);
    session.turnResolver = null;
  }
  session.closed = true;
}

function killSession(session: CodexSession): void {
  if (session.closed) return;
  flushTrace(session);
  resolvePendingApprovals(session, "expired", "Codex session ended; approval requests expired.");
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
  flushTrace(session);
  resolvePendingApprovals(session, "expired", "用户主动停止当前 AI 会话。");
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
): Promise<CodexThreadInfo> {
  if (session.threadId) return { threadId: session.threadId, model: null };

  // Try to resume from a DB-stored providerSessionId
  const existing = lookupExistingProviderSessionId(aiSessionId);
  if (existing) {
    try {
      const resp = await sendRequestWithReconnectRetry(session, "thread/resume", {
        threadId: existing,
      });
      const info = extractThreadInfo(resp.result, existing);
      if (!info) throw new Error("未能从 codex 恢复 threadId");
      session.threadId = info.threadId;
      return info;
    } catch {
      // resume failed — fall back to thread/start
    }
  }

  const resp = await sendRequestWithReconnectRetry(session, "thread/start", {});
  const info = extractThreadInfo(resp.result);
  if (!info) {
    throw new Error("未能从 codex 获取 threadId");
  }
  session.threadId = info.threadId;
  return info;
}

function buildCodexCollaborationMode(
  threadInfo: CodexThreadInfo,
  req: RunCodexChatRequest,
  reasoningEffort: string | null
): Record<string, unknown> | null {
  const model = trimmedOrNull(req.codexModel) ?? threadInfo.model;
  if (!model) return null;
  const mode = req.codexMode === "plan" ? "plan" : "default";
  return {
    mode,
    settings: {
      model,
      reasoning_effort: mode === "plan" ? (reasoningEffort ?? "medium") : reasoningEffort,
      developer_instructions: null,
    },
  };
}

function buildCodexTurnParams(
  threadInfo: CodexThreadInfo,
  req: RunCodexChatRequest,
  images: ChatImageAttachment[]
): Record<string, unknown> {
  const model = trimmedOrNull(req.codexModel);
  const reasoningEffort = codexReasoningEffort(req.codexReasoningEffort);
  const collaborationMode = buildCodexCollaborationMode(threadInfo, req, reasoningEffort);
  const turnParams: Record<string, unknown> = {
    threadId: threadInfo.threadId,
    input: buildUserInput(req.prompt, images),
  };
  if (model) turnParams["model"] = model;
  if (reasoningEffort) turnParams["effort"] = reasoningEffort;
  if (collaborationMode) turnParams["collaborationMode"] = collaborationMode;
  return turnParams;
}

async function applyCodexGoal(
  session: CodexSession,
  threadId: string,
  req: RunCodexChatRequest
): Promise<void> {
  const objective = trimmedOrNull(req.codexGoal);
  if (!objective) return;
  const tokenBudget = typeof req.codexGoalTokenBudget === "number" && Number.isFinite(req.codexGoalTokenBudget)
    ? Math.max(1, Math.floor(req.codexGoalTokenBudget))
    : null;
  const params: Record<string, unknown> = {
    threadId,
    objective,
    status: "active",
  };
  if (tokenBudget !== null) params["tokenBudget"] = tokenBudget;
  await sendRequestWithReconnectRetry(session, "thread/goal/set", params);
}

// ---------- Public API ----------

/**
 * Run a Codex chat turn. Spawns `codex app-server --stdio`, initializes the
 * JSON-RPC connection, starts (or resumes) a thread, sends turn/start, and
 * streams Codex trace updates to the sender until the turn completes.
 *
 * Returns the app-server tagged threadId (providerSessionId).
 */
export async function runCodexChat(
  req: RunCodexChatRequest,
  sender: Sender
): Promise<string> {
  const { aiSessionId, projectPath, images = [], approvalMode = "suggest" } = req;
  const session = createSession(aiSessionId, projectPath, sender, true, approvalMode);
  const initialTrace = resetLocalAiTrace({
    aiSessionId,
    providerId: "codex",
    traceKind: "codex",
    status: "running",
    snapshot: {
      provider: "codex",
      status: "running",
      threadId: null,
      turnId: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      items: [],
      approvals: [],
      errors: [],
      finalText: "",
    },
  });
  session.traceSnapshot = initialTrace.snapshot as CodexTraceSnapshot;
  sender.send("ai-trace-update", {
    aiSessionId,
    trace: {
      ...initialTrace,
      segments: codexTraceSnapshotToSegments(session.traceSnapshot),
    },
  });
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
    resolvePendingApprovals(session, "expired", "Codex session ended; approval requests expired.");
    killSession(session);
  }, CODEX_TURN_TIMEOUT_MS);

  try {
    // 1. initialize
    await sendRequestWithReconnectRetry(session, "initialize", CODEX_INITIALIZE_PARAMS);

    // 2. start or resume thread
    const threadInfo = await ensureThread(session, aiSessionId);
    await applyCodexGoal(session, threadInfo.threadId, req);

    // 3. set up turn-completion promise (resolved by turn/completed,
    //    rejected by error notification / child exit / timeout)
    const turnDone = new Promise<void>((resolve, reject) => {
      session.turnResolver = { resolve, reject };
    });

    // 4. send turn/start.
    session.currentTurnStartedAtMs = Date.now();
    await sendRequestWithReconnectRetry(session, "turn/start", buildCodexTurnParams(threadInfo, req, images));

    // 5. wait for turn/completed or error
    await turnDone;
    await reportCodexSessionFileTokenUsage(session, threadInfo.threadId);

    clearTimeout(timeout);
    killSession(session);
    return encodeAppServerProviderSessionId(threadInfo.threadId);
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

function extractCodexModelOptions(result: unknown): CodexModelOption[] {
  if (!result || typeof result !== "object") return [];
  const data = (result as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return [];
  return data.flatMap((item): CodexModelOption[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const model = trimmedOrNull(row["model"]) ?? trimmedOrNull(row["id"]);
    const id = trimmedOrNull(row["id"]) ?? model;
    if (!id || !model) return [];
    return [{
      id,
      model,
      displayName: trimmedOrNull(row["displayName"]) ?? model,
      description: trimmedOrNull(row["description"]),
      isDefault: row["isDefault"] === true,
    }];
  });
}

function extractNextCursor(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  return trimmedOrNull((result as Record<string, unknown>)["nextCursor"]);
}

export async function listCodexModels(sender: Sender = { send: () => undefined }): Promise<CodexModelOption[]> {
  const session = createSession(`codex-model-list-${Date.now()}`, os.homedir(), sender);
  const timeout = setTimeout(() => {
    for (const [, pending] of session.pendingRequests) pending.reject(new Error("timeout"));
    session.pendingRequests.clear();
    killSession(session);
  }, CODEX_WARMUP_TIMEOUT_MS);

  try {
    await sendRequestWithReconnectRetry(session, "initialize", CODEX_INITIALIZE_PARAMS);
    const models = new Map<string, CodexModelOption>();
    let cursor: string | null = null;
    do {
      const resp = await sendRequestWithReconnectRetry(session, "model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      for (const model of extractCodexModelOptions(resp.result)) {
        models.set(model.model, model);
      }
      cursor = extractNextCursor(resp.result);
    } while (cursor);
    return [...models.values()].sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.displayName.localeCompare(right.displayName, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
    });
  } finally {
    clearTimeout(timeout);
    killSession(session);
  }
}

export function stopCodexChat(aiSessionId: string): boolean {
  const session = activeCodexSessions.get(aiSessionId);
  if (!session) return false;
  session.cancelled = true;
  if (session.traceSnapshot) {
    session.traceSnapshot = {
      ...session.traceSnapshot,
      status: "canceled",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const trace = upsertLocalAiTrace({
      aiSessionId,
      providerId: "codex",
      traceKind: "codex",
      status: "canceled",
      snapshot: session.traceSnapshot,
      finalText: session.traceSnapshot.finalText,
    });
    session.sender.send("ai-trace-update", {
      aiSessionId,
      trace: {
        ...trace,
        segments: codexTraceSnapshotToSegments(session.traceSnapshot),
      },
    });
  }
  const error = new Error("AI chat stopped by user");
  for (const [, pending] of session.pendingRequests) {
    pending.reject(error);
  }
  session.pendingRequests.clear();
  resolvePendingApprovals(session, "expired", "用户主动停止当前 AI 会话。");
  if (session.turnResolver) {
    session.turnResolver.reject(error);
    session.turnResolver = null;
  }
  interruptSession(session);
  activeCodexSessions.delete(aiSessionId);
  return true;
}

export function hasLiveCodexChat(): boolean {
  return activeCodexSessions.size > 0;
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
    resolvePendingApprovals(session, "expired", "Codex session ended; approval requests expired.");
    killSession(session);
  }, CODEX_WARMUP_TIMEOUT_MS);

  try {
    await sendRequestWithReconnectRetry(session, "initialize", CODEX_INITIALIZE_PARAMS);
    const threadInfo = await ensureThread(session, aiSessionId);
    clearTimeout(timeout);
    killSession(session);
    return { providerSessionId: encodeAppServerProviderSessionId(threadInfo.threadId) };
  } catch {
    clearTimeout(timeout);
    killSession(session);
    return { providerSessionId: "" };
  }
}
