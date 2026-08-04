// Codex app-server integration for the Electron main process.
// Spawns `codex app-server --stdio`, communicates via JSON-RPC 2.0,
// and streams Codex trace updates to the renderer through the sender.
// Mirrors the original Tauri Rust run_codex_chat implementation.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { getCodexSkillsExtraRoots } from "./codex_skills";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RunCodexChatRequest, SteerCodexChatRequest, ChatContextAttachment, ChatFileAttachment, ChatImageAttachment, ChatSegment, CodexApprovalDecision, CodexApprovalMode, CodexTraceSnapshot, CodexReviewTarget, CodexFileSystemPermissionEntry, CodexModelOption, CodexReasoningEffort, CodexReasoningEffortOption, CodexServiceTierOption, CodexPermissionGrantScope, CodexRequestedPermissions, CodexUserInputQuestion } from "../services/desktop";
import { formatChatContext } from "../shared/chat_context";
import { reportTokenUsage } from "./sync";
import { getLocalAiSession, resetLocalAiTrace, updateLocalAiSession, upsertLocalAiTrace } from "./db";
import { codexTraceSnapshotToSegments, isCodexReconnectMessage, reduceCodexTraceSnapshot, type CodexRawTraceEvent } from "./codex_trace";

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
  requestedPermissions?: CodexRequestedPermissions;
  requestedPermissionsRaw?: Record<string, unknown>;
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
  currentTurnId: string | null;
  nextRequestId: number;
  pendingRequests: Map<number, PendingRequest>;
  sender: Sender;
  closed: boolean;
  stderrBuffer: string;
  pendingApprovals: Map<string, PendingApproval>;
  pendingUserInputs: Map<string, PendingUserInput>;
  traceEnabled: boolean;
  traceSnapshot: CodexTraceSnapshot | null;
  traceDirty: boolean;
  traceFlushTimer: ReturnType<typeof setTimeout> | null;
  turnTimeoutTimer: ReturnType<typeof setTimeout> | null;
  turnResolver: { resolve: () => void; reject: (error: Error) => void } | null;
  errorEmitted: boolean;
  cancelled: boolean;
  /** 原生代码审查（review/start）运行中：session 保持活跃直到 exitedReviewMode。 */
  reviewActive: boolean;
  approvalMode: CodexApprovalMode;
  reportedTokenUsageKeys: Set<string>;
  currentTurnStartedAtMs: number | null;
  interruptRequest: Promise<void> | null;
  interruptedTurnId: string | null;
  launchCommand: string;
  launchDiagnostics: string[];
  requestedCwd: string;
  resolvedCwd: string;
}

// ---------- Constants ----------

const CODEX_TURN_TIMEOUT_MS = 30 * 60_000;
const CODEX_TRACE_FLUSH_MS = 120;
const CODEX_WARMUP_TIMEOUT_MS = 60_000;
const CODEX_RECONNECT_RETRY_MS = 1200;
const CODEX_RECONNECT_MAX_RETRIES = 5;
const CODEX_INTERRUPT_REQUEST_TIMEOUT_MS = 5_000;
const CODEX_INTERRUPT_SETTLE_TIMEOUT_MS = 10_000;
const CLI_INTERRUPT_FALLBACK_MS = 1500;
const CODEX_CLIENT_INFO = { name: "CodeHub AI", version: "0.1.0" };
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
  requestedCwd: string;
  resolvedCwd: string;
}

interface WindowsCodexCandidate {
  kind: "exe" | "cmd";
  path: string;
  source: string;
}

interface CodexCwdResolution {
  requestedCwd: string;
  resolvedCwd: string;
  diagnostics: string[];
}

function isDirectoryPath(value: string): boolean {
  try {
    return fsSync.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function normalizeCandidateCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(value);
}

function resolveCodexCwd(cwd: string | null | undefined): CodexCwdResolution {
  const requestedCwd = (cwd || "").trim();
  const candidates = uniquePaths([
    requestedCwd ? normalizeCandidateCwd(requestedCwd) : null,
    os.homedir(),
    process.cwd(),
  ]);
  const resolvedCwd = candidates.find(isDirectoryPath) ?? os.homedir();
  return {
    requestedCwd,
    resolvedCwd,
    diagnostics: [
      `requested cwd: ${requestedCwd || "<empty>"}`,
      `resolved cwd: ${resolvedCwd}`,
      ...candidates.map((candidate) => `${isDirectoryPath(candidate) ? "found" : "missing"}: ${candidate} (cwd)`),
    ],
  };
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
    ...appDataDirs.map((dir) => path.join(dir, "npm")),
    ...localAppDataDirs.map((dir) => path.join(dir, "Programs", "OpenAI", "Codex", "bin")),
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
  const cwdInfo = resolveCodexCwd(cwd);
  const candidates = windowsCodexCandidates(env);
  const diagnostics = [
    ...cwdInfo.diagnostics,
    ...candidates.map((candidate) => {
      const exists = fsSync.existsSync(candidate.path) ? "found" : "missing";
      return `${exists}: ${candidate.path} (${candidate.source})`;
    }),
  ];
  const candidate = candidates.find((item) => fsSync.existsSync(item.path));
  const spawnOptions = { cwd: cwdInfo.resolvedCwd, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true, env };
  if (candidate?.kind === "exe") {
    return {
      child: spawn(candidate.path, args, spawnOptions),
      launchCommand: `${candidate.path} ${args.join(" ")}`,
      launchDiagnostics: diagnostics,
      requestedCwd: cwdInfo.requestedCwd,
      resolvedCwd: cwdInfo.resolvedCwd,
    };
  }
  if (candidate?.kind === "cmd") {
    const command = process.env["ComSpec"] || "cmd.exe";
    const commandArgs = ["/d", "/s", "/c", candidate.path, ...args];
    return {
      child: spawn(command, commandArgs, spawnOptions),
      launchCommand: `${command} ${commandArgs.join(" ")}`,
      launchDiagnostics: diagnostics,
      requestedCwd: cwdInfo.requestedCwd,
      resolvedCwd: cwdInfo.resolvedCwd,
    };
  }
  const command = process.env["ComSpec"] || "cmd.exe";
  const commandArgs = ["/d", "/s", "/c", "codex", ...args];
  return {
    child: spawn(command, commandArgs, spawnOptions),
    launchCommand: `${command} ${commandArgs.join(" ")}`,
    launchDiagnostics: diagnostics,
    requestedCwd: cwdInfo.requestedCwd,
    resolvedCwd: cwdInfo.resolvedCwd,
  };
}

function spawnCodex(args: string[], cwd: string): CodexSpawnResult {
  if (process.platform === "win32") return createWindowsCodexSpawn(args, cwd);
  const cwdInfo = resolveCodexCwd(cwd);
  return {
    child: spawn("codex", args, {
      cwd: cwdInfo.resolvedCwd,
      stdio: ["pipe", "pipe", "pipe"],
    }),
    launchCommand: `codex ${args.join(" ")}`,
    launchDiagnostics: cwdInfo.diagnostics,
    requestedCwd: cwdInfo.requestedCwd,
    resolvedCwd: cwdInfo.resolvedCwd,
  };
}

export function spawnCodexAppServerProcess(cwd: string): ChildProcessWithoutNullStreams {
  return spawnCodex(["app-server", "--stdio"], cwd).child;
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
  if (rawEvent.method === "turn/completed" || rawEvent.method === "error") {
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

function finishCodexSessionTrace(
  session: CodexSession,
  status: "completed" | "failed" | "canceled",
  detail?: string
): void {
  if (!session.traceEnabled || !session.traceSnapshot) return;
  const now = new Date().toISOString();
  session.traceSnapshot = {
    ...session.traceSnapshot,
    status,
    updatedAt: now,
    completedAt: now,
    errors: status === "failed" && detail
      ? [...session.traceSnapshot.errors, { message: detail, at: now }]
      : session.traceSnapshot.errors,
    approvals: session.traceSnapshot.approvals.map((approval) => (
      approval.status === "pending" ? { ...approval, status: "expired" as const } : approval
    )),
    items: session.traceSnapshot.items.map((item) => (
      item.status === "running"
        ? {
            ...item,
            status: status === "completed" ? "completed" as const : status === "canceled" ? "canceled" as const : "failed" as const,
            completedAt: item.completedAt ?? now,
          }
        : item
    )),
  };
  session.traceDirty = true;
  flushTrace(session);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// recordValue / strValue：从任意载荷安全提取对象与字符串（review item 解析用）。
function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function recordOrNull(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function codexReasoningEffort(v: unknown): CodexReasoningEffort | null {
  const value = trimmedOrNull(v);
  return value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    || value === "ultra"
    ? value
    : null;
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function fileSystemAccessOrNull(v: unknown): CodexFileSystemPermissionEntry["access"] | null {
  return v === "read" || v === "write" || v === "deny" ? v : null;
}

interface PendingUserInput {
  requestId: number;
  questions: CodexUserInputQuestion[];
  resolved: boolean;
}

async function applyCodexSkillsExtraRoots(session: CodexSession): Promise<void> {
  const extraRoots = await getCodexSkillsExtraRoots();
  if (!extraRoots.length) return;
  try {
    await sendRequestWithReconnectRetry(session, "skills/extraRoots/set", { extraRoots });
  } catch (error) {
    console.warn("Unable to apply configured Codex Skills roots:", errorMessage(error));
  }
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

function buildUserInput(
  text: string,
  images: ChatImageAttachment[] = [],
  attachments: ChatFileAttachment[] = [],
  contexts: ChatContextAttachment[] = [],
): Array<Record<string, unknown>> {
  return [
    { type: "text", text, text_elements: [] },
    ...images.map((image) => ({
      type: "image",
      url: image.dataUrl,
      detail: "auto",
    })),
    ...attachments.map((attachment) => ({
      type: "mention",
      name: attachment.name,
      path: attachment.path,
    })),
    ...contexts.map((context) => context.kind === "file" || context.kind === "folder"
      ? {
          type: "mention",
          name: context.name,
          path: context.path,
        }
      : {
          type: "text",
          text: formatChatContext(context),
          text_elements: [],
        }),
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

function approvalStatusTitle(status: Extract<ChatSegment, { type: "approval" }>["status"], kind: "command" | "fileChange" | "permissions") {
  const noun = kind === "command" ? "命令" : kind === "fileChange" ? "文件修改" : "权限申请";
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
      return kind === "command" ? "需要同意后执行命令" : kind === "fileChange" ? "需要同意后修改文件" : "需要同意额外权限";
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
  const approvalKind = method === "item/permissions/requestApproval" || method === "permissions/requestApproval"
    ? "permissions"
    : method === "item/fileChange/requestApproval" || method === "applyPatchApproval" ? "fileChange" : "command";
  const approvalId = approvalIdFor(requestId, p);
  const stepId = approvalStepIdFor(approvalId);
  const grantRoot = strOrUndef(p["grantRoot"]);
  const command = commandFromApproval(method, p);
  const fileChanges = fileChangesFromApproval(p);
  const reason = strOrUndef(p["reason"]);
  const cwd = strOrUndef(p["cwd"]);
  const requestedPermissions = approvalKind === "permissions" ? requestedPermissionsFromApproval(p) : undefined;
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
    requestedPermissions,
    permissionScope: approvalKind === "permissions" ? "turn" : undefined,
  };
}

function isApprovalRequestMethod(method: string) {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
    || method === "permissions/requestApproval"
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

function approvalResponseFor(method: string, decision: CodexApprovalDecision, requestedPermissions?: Record<string, unknown>, scope: CodexPermissionGrantScope = "turn") {
  if (method === "item/permissions/requestApproval" || method === "permissions/requestApproval") {
    return { permissions: decision === "approved" ? requestedPermissions ?? {} : {}, scope };
  }
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
    requestedPermissions: segment.requestedPermissions,
    requestedPermissionsRaw: params && typeof params === "object" && !Array.isArray(params)
      ? recordOrNull((params as Record<string, unknown>)["permissions"]) ?? undefined
      : undefined,
    resolved: false,
  };
  emitTraceMethod(session, "approval/requested", {
    approvalId: segment.approvalId,
    approvalKind: segment.approvalKind,
    command: segment.command,
    cwd: segment.cwd,
    fileChanges: segment.fileChanges,
    reason: segment.reason,
    requestedPermissions: segment.requestedPermissions,
    permissionScope: segment.permissionScope,
  });
  if ((session.approvalMode === "autoEdit" && segment.approvalKind !== "permissions") || session.approvalMode === "fullAccess") {
    approval.resolved = true;
    sendResponse(session, id, approvalResponseFor(method, "approved", approval.requestedPermissionsRaw));
    updateApprovalSegment(session, approval, "approved", session.approvalMode === "fullAccess" ? "已根据完全访问权限自动批准。" : "已根据替我审批自动批准。");
    return;
  }
  session.pendingApprovals.set(segment.approvalId, approval);
  refreshCodexTurnTimeout(session);
}

function userInputQuestionsFromParams(params: unknown): CodexUserInputQuestion[] | null {
  const record = recordOrNull(params);
  if (!record || !Array.isArray(record["questions"])) return null;
  const questions = record["questions"].flatMap((value) => {
    const question = recordOrNull(value);
    if (!question) return [];
    const id = strOrUndef(question["id"])?.trim();
    const prompt = strOrUndef(question["question"])?.trim();
    if (!id || !prompt) return [];
    const options = Array.isArray(question["options"])
      ? question["options"].flatMap((option) => {
        const entry = recordOrNull(option);
        if (!entry) return [];
        const label = strOrUndef(entry["label"])?.trim();
        if (!label) return [];
        return [{ label, description: strOrUndef(entry["description"])?.trim() ?? "" }];
      })
      : [];
    return [{
      id,
      question: prompt,
      header: strOrUndef(question["header"])?.trim() ?? "",
      options,
      isOther: question["isOther"] === true,
      isSecret: question["isSecret"] === true,
    }];
  });
  return questions.length ? questions : null;
}

function clearPendingUserInput(session: CodexSession, requestId: string): void {
  session.pendingUserInputs.delete(requestId);
  session.sender.send("codex-user-input-resolved", { aiSessionId: session.aiSessionId, requestId });
}

function resolvePendingUserInputs(session: CodexSession): void {
  for (const [requestId, request] of session.pendingUserInputs) {
    if (request.resolved) continue;
    request.resolved = true;
    try {
      sendResponse(session, request.requestId, { answers: {} });
    } catch {
      // The process may already be gone; the renderer still needs to unlock.
    }
    clearPendingUserInput(session, requestId);
  }
}

function handleUserInputRequest(session: CodexSession, id: number, params: unknown): void {
  const questions = userInputQuestionsFromParams(params);
  if (!questions) {
    sendResponse(session, id, { answers: {} });
    return;
  }
  const requestId = String(id);
  session.pendingUserInputs.set(requestId, { requestId: id, questions, resolved: false });
  session.sender.send("codex-user-input-request", { aiSessionId: session.aiSessionId, requestId, questions });
  refreshCodexTurnTimeout(session);
}

function requestedPermissionsFromApproval(params: Record<string, unknown>): CodexRequestedPermissions | undefined {
  const permissions = params["permissions"];
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return undefined;
  const source = permissions as Record<string, unknown>;
  const networkSource = source["network"];
  const fileSystemSource = source["fileSystem"];
  const requested: CodexRequestedPermissions = {};
  if (networkSource && typeof networkSource === "object" && !Array.isArray(networkSource)) {
    const enabled = (networkSource as Record<string, unknown>)["enabled"];
    requested.network = { enabled: typeof enabled === "boolean" ? enabled : null };
  }
  if (fileSystemSource && typeof fileSystemSource === "object" && !Array.isArray(fileSystemSource)) {
    const fileSystem = fileSystemSource as Record<string, unknown>;
    const entries = Array.isArray(fileSystem["entries"])
      ? fileSystem["entries"].flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const entry = value as Record<string, unknown>;
        const access = fileSystemAccessOrNull(entry["access"]);
        const pathValue = entry["path"];
        if (!access) return [];
        if (!pathValue || typeof pathValue !== "object" || Array.isArray(pathValue)) return [];
        const pathRecord = pathValue as Record<string, unknown>;
        const displayPath = strOrUndef(pathRecord["path"]) ?? strOrUndef(pathRecord["pattern"]) ?? strOrUndef(pathRecord["value"]);
        return displayPath ? [{ path: displayPath, access }] : [];
      })
      : undefined;
    requested.fileSystem = {
      read: Array.isArray(fileSystem["read"]) ? arrayOfStrings(fileSystem["read"]) : null,
      write: Array.isArray(fileSystem["write"]) ? arrayOfStrings(fileSystem["write"]) : null,
      entries,
    };
  }
  return requested.network || requested.fileSystem ? requested : undefined;
}

function extractTurnId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    const turn = r["turn"] as Record<string, unknown> | undefined;
    const candidate = r["turnId"] ?? r["turn_id"] ?? turn?.["id"];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function resolvePendingApprovals(session: CodexSession, status: "expired" | "failed", detail?: string): void {
  for (const approval of session.pendingApprovals.values()) {
    if (approval.resolved) continue;
    approval.resolved = true;
    updateApprovalSegment(session, approval, status, detail);
  }
  session.pendingApprovals.clear();
}

function declinePendingApprovalsForInterrupt(session: CodexSession): void {
  for (const approval of session.pendingApprovals.values()) {
    if (approval.resolved) continue;
    approval.resolved = true;
    try {
      sendResponse(session, approval.requestId, approvalResponseFor(approval.method, "denied"));
    } catch {
      // turn/interrupt remains authoritative if the approval response races shutdown
    }
    updateApprovalSegment(session, approval, "expired", "用户主动停止当前 AI 会话。");
  }
  session.pendingApprovals.clear();
}

function clearCodexTurnTimeout(session: CodexSession): void {
  if (!session.turnTimeoutTimer) return;
  clearTimeout(session.turnTimeoutTimer);
  session.turnTimeoutTimer = null;
}

function expireCodexTurnForInactivity(session: CodexSession): void {
  session.turnTimeoutTimer = null;
  if (session.closed || session.cancelled || session.pendingApprovals.size > 0 || session.pendingUserInputs.size > 0) return;

  const timeoutMessage = "Codex 连续 30 分钟没有新活动，本轮已自动结束。";
  emitSessionError(session, timeoutMessage);
  if (session.turnResolver) {
    session.turnResolver.reject(new Error("timeout"));
    session.turnResolver = null;
  }
  for (const [, pending] of session.pendingRequests) {
    pending.reject(new Error("timeout"));
  }
  session.pendingRequests.clear();
  resolvePendingApprovals(session, "expired", "Codex 会话空闲超时，审批请求已失效。");
  resolvePendingUserInputs(session);
  finishCodexSessionTrace(session, "failed", timeoutMessage);
  killSession(session);
}

function refreshCodexTurnTimeout(session: CodexSession): void {
  clearCodexTurnTimeout(session);
  if (!session.traceEnabled || session.closed || session.cancelled || session.pendingApprovals.size > 0 || session.pendingUserInputs.size > 0) return;
  session.turnTimeoutTimer = setTimeout(() => {
    expireCodexTurnForInactivity(session);
  }, CODEX_TURN_TIMEOUT_MS);
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
  refreshCodexTurnTimeout(session);

  // Server request from Codex app-server. The app must answer this id, or the
  // Codex turn waits indefinitely for approval.
  if (typeof msg["id"] === "number" && typeof msg["method"] === "string") {
    const method = msg["method"] as string;
    if (isApprovalRequestMethod(method)) {
      handleApprovalRequest(session, method, msg["id"] as number, msg["params"]);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      handleUserInputRequest(session, msg["id"] as number, msg["params"]);
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
// 形如 { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }。提取并上报。
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
    const cachedInputTokens = Math.min(inputTokens, Math.max(0,
      numOrUndef(u["cached_input_tokens"]) ??
      numOrUndef(u["cachedInputTokens"]) ??
      numOrUndef(u["cached_input"]) ??
      0));
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
      (inputTokens + outputTokens);
    if (total <= 0) return;
    const dedupeKey = `${inputTokens}:${cachedInputTokens}:${outputTokens}:${reasoningTokens}:${total}`;
    if (session.reportedTokenUsageKeys.has(dedupeKey)) return;
    session.reportedTokenUsageKeys.add(dedupeKey);
    void reportTokenUsage({
      aiSessionId: session.aiSessionId,
      providerId: "codex",
      inputTokens,
      cachedInputTokens,
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
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
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
    case "turn/started": {
      const turnId = extractTurnId(params);
      if (turnId) session.currentTurnId = turnId;
      if (session.cancelled && session.threadId && session.currentTurnId) {
        void interruptCurrentCodexTurn(session).catch(() => interruptSession(session));
      }
      break;
    }
    case "turn/completed": {
      clearCodexTurnTimeout(session);
      reportCodexTokenUsage(session, params);
      session.currentTurnId = null;
      if (session.turnResolver) {
        session.turnResolver.resolve();
        session.turnResolver = null;
      }
      break;
    }
    case "item/completed": {
      // 原生代码审查结束：exitedReviewMode item 到达后清理会话，让后续消息可复用。
      const p = recordValue(params);
      const item = recordValue(p.item ?? p);
      if (strValue(item.type) === "exitedReviewMode" && session.reviewActive) {
        session.reviewActive = false;
        clearCodexTurnTimeout(session);
        senderSafeSend(session, "codex-review-complete", { aiSessionId: session.aiSessionId });
        void finishCodexReviewSession(session);
      }
      break;
    }
    case "error": {
      const msg = extractErrorMessage(params) ?? "未知错误";
      if (!isCodexReconnectMessage(msg)) session.errorEmitted = true;
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
  approvalMode: CodexApprovalMode = "custom",
): CodexSession {
  const launchedCodex = spawnCodex(["app-server", "--stdio"], cwd);
  const child = launchedCodex.child;

  const session: CodexSession = {
    aiSessionId,
    child,
    rl: createInterface({ input: child.stdout, terminal: false }),
    threadId: null,
    currentTurnId: null,
    nextRequestId: 1,
    pendingRequests: new Map(),
    sender,
    closed: false,
    stderrBuffer: "",
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    traceEnabled,
    traceSnapshot: null,
    traceDirty: false,
    traceFlushTimer: null,
    turnTimeoutTimer: null,
    turnResolver: null,
    errorEmitted: false,
    cancelled: false,
    reviewActive: false,
    approvalMode,
    reportedTokenUsageKeys: new Set(),
    currentTurnStartedAtMs: null,
    interruptRequest: null,
    interruptedTurnId: null,
    launchCommand: launchedCodex.launchCommand,
    launchDiagnostics: launchedCodex.launchDiagnostics,
    requestedCwd: launchedCodex.requestedCwd,
    resolvedCwd: launchedCodex.resolvedCwd,
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
  clearCodexTurnTimeout(session);
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
  resolvePendingUserInputs(session);
  flushTrace(session);
  if (session.turnResolver) {
    session.turnResolver.reject(err);
    session.turnResolver = null;
  }
  session.closed = true;
}

function handleSpawnError(session: CodexSession, err: Error): void {
  clearCodexTurnTimeout(session);
  const errno = err as NodeJS.ErrnoException & { spawnargs?: string[] };
  const spawnArgs = Array.isArray(errno.spawnargs) ? errno.spawnargs.join(" ") : "";
  const baseMessage = errno.code === "ENOENT"
    ? "Codex process failed to start. The command or working directory was not found."
    : `Codex process error: ${err.message}`;
  const diagnosticLines = [
    baseMessage,
    `launch command: ${session.launchCommand}`,
    `requested cwd: ${session.requestedCwd || "<empty>"}`,
    `resolved cwd: ${session.resolvedCwd}`,
    `error code: ${errno.code ?? "unknown"}`,
    `error path: ${errno.path ?? "unknown"}`,
    spawnArgs ? `error spawnargs: ${spawnArgs}` : null,
    ...session.launchDiagnostics.slice(0, 20).map((line) => `diagnostic: ${line}`),
  ].filter((line): line is string => Boolean(line));
  const message = diagnosticLines.join("\n");
  emitSessionError(session, message);
  for (const [, pending] of session.pendingRequests) {
    pending.reject(err);
  }
  session.pendingRequests.clear();
  resolvePendingApprovals(session, "failed", message);
  resolvePendingUserInputs(session);
  flushTrace(session);
  if (session.turnResolver) {
    session.turnResolver.reject(err);
    session.turnResolver = null;
  }
  session.closed = true;
}

function killSession(session: CodexSession): void {
  clearCodexTurnTimeout(session);
  if (session.closed) return;
  flushTrace(session);
  resolvePendingApprovals(session, "expired", "Codex session ended; approval requests expired.");
  resolvePendingUserInputs(session);
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
  clearCodexTurnTimeout(session);
  if (session.closed) return;
  flushTrace(session);
  resolvePendingApprovals(session, "expired", "用户主动停止当前 AI 会话。");
  resolvePendingUserInputs(session);
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

function codexApprovalOverrides(mode: CodexApprovalMode): Record<string, unknown> {
  if (mode === "suggest") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    };
  }
  if (mode === "autoEdit") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    };
  }
  if (mode === "fullAccess") {
    return {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
  }
  return {};
}

async function interruptCurrentCodexTurn(session: CodexSession): Promise<void> {
  if (session.interruptRequest) return session.interruptRequest;
  const threadId = session.threadId;
  const turnId = session.currentTurnId;
  if (!threadId || !turnId || session.closed) return;
  if (session.interruptedTurnId === turnId) return;
  session.interruptedTurnId = turnId;

  const request = Promise.race([
    sendRequestWithReconnectRetry(session, "turn/interrupt", { threadId, turnId }).then(() => undefined),
    delay(CODEX_INTERRUPT_REQUEST_TIMEOUT_MS).then(() => {
      throw new Error("turn/interrupt request timed out");
    }),
  ]);
  session.interruptRequest = request;
  try {
    await request;
  } finally {
    if (session.interruptRequest === request) session.interruptRequest = null;
  }
}

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
  const approvalOverrides = codexApprovalOverrides(session.approvalMode);

  // Try to resume from a DB-stored providerSessionId
  const existing = lookupExistingProviderSessionId(aiSessionId);
  if (existing) {
    try {
      const resp = await sendRequestWithReconnectRetry(session, "thread/resume", {
        threadId: existing,
        ...approvalOverrides,
      });
      const info = extractThreadInfo(resp.result, existing);
      if (!info) throw new Error("未能从 codex 恢复 threadId");
      session.threadId = info.threadId;
      return info;
    } catch {
      // resume failed — fall back to thread/start
    }
  }

  const resp = await sendRequestWithReconnectRetry(session, "thread/start", approvalOverrides);
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
  images: ChatImageAttachment[],
  attachments: ChatFileAttachment[],
): Record<string, unknown> {
  const model = trimmedOrNull(req.codexModel);
  const reasoningEffort = codexReasoningEffort(req.codexReasoningEffort);
  const collaborationMode = buildCodexCollaborationMode(threadInfo, req, reasoningEffort);
  const turnParams: Record<string, unknown> = {
    threadId: threadInfo.threadId,
    input: buildUserInput(req.prompt, images, attachments, req.contexts ?? []),
  };
  if (model) turnParams["model"] = model;
  if (reasoningEffort) turnParams["effort"] = reasoningEffort;
  if (req.codexServiceTier !== undefined) {
    turnParams["serviceTier"] = trimmedOrNull(req.codexServiceTier);
  }
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
    status: req.codexGoalStatus ?? "active",
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
  const { aiSessionId, projectPath, images = [], attachments = [], approvalMode = "custom" } = req;
  const existingSession = activeCodexSessions.get(aiSessionId);
  if (existingSession && !existingSession.closed && !existingSession.cancelled) {
    throw new Error("当前 Codex 会话仍在执行，请等待完成或先停止当前任务。");
  }
  const session = createSession(aiSessionId, resolveCodexCwd(projectPath).resolvedCwd, sender, true, approvalMode);
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

  refreshCodexTurnTimeout(session);

  try {
    // 1. initialize
    await sendRequestWithReconnectRetry(session, "initialize", CODEX_INITIALIZE_PARAMS);
    await applyCodexSkillsExtraRoots(session);

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
    const turnStartResponse = await sendRequestWithReconnectRetry(session, "turn/start", buildCodexTurnParams(threadInfo, req, images, attachments));
    const responseTurnId = extractTurnId(turnStartResponse.result);
    if (session.turnResolver && responseTurnId) session.currentTurnId = responseTurnId;
    if (session.cancelled) await interruptCurrentCodexTurn(session);

    // 5. wait for turn/completed or error
    await turnDone;
    await reportCodexSessionFileTokenUsage(session, threadInfo.threadId);

    killSession(session);
    return encodeAppServerProviderSessionId(threadInfo.threadId);
  } catch (err) {
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

// ---------- 原生代码审查（review/start） ----------

// senderSafeSend 安全转发会话事件到 renderer（会话可能已关闭）。
function senderSafeSend(session: CodexSession, channel: string, payload: unknown): void {
  try {
    session.sender.send(channel, payload);
  } catch {
    // renderer 已关闭或发送失败时忽略
  }
}

// finishCodexReviewSession 在 exitedReviewMode 后清理审查会话，释放后续消息通道。
async function finishCodexReviewSession(session: CodexSession): Promise<void> {
  if (activeCodexSessions.get(session.aiSessionId) === session) {
    activeCodexSessions.delete(session.aiSessionId);
  }
  // 审查结束：把本地会话状态从 running 恢复为 completed，避免侧边栏一直显示执行中。
  try {
    updateLocalAiSession(session.aiSessionId, { status: "completed" });
  } catch {
    // 本地记录缺失时忽略
  }
  killSession(session);
}

/**
 * 启动 Codex 原生代码审查（review/start）。
 *
 * review 在指定 thread 上运行，事件（enteredReviewMode / exitedReviewMode
 * item）通过既有 trace 流推送到 renderer。返回后 session 保持活跃，
 * 直到 exitedReviewMode item 到达（见 handleNotification）才清理。
 */
export async function startCodexReview(
  aiSessionId: string,
  projectPath: string,
  target: CodexReviewTarget,
  delivery: "inline" | "detached",
  sender: Sender,
): Promise<{ reviewThreadId: string; turnId: string }> {
  const existingSession = activeCodexSessions.get(aiSessionId);
  if (existingSession && !existingSession.closed && !existingSession.cancelled) {
    throw new Error("当前 Codex 会话仍在执行，请等待完成或先停止当前任务。");
  }
  const session = createSession(aiSessionId, resolveCodexCwd(projectPath).resolvedCwd, sender, true, "custom");
  const now = new Date().toISOString();
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
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      items: [],
      approvals: [],
      errors: [],
      finalText: "",
      reviewMode: null,
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
  refreshCodexTurnTimeout(session);

  try {
    await sendRequestWithReconnectRetry(session, "initialize", CODEX_INITIALIZE_PARAMS);
    await applyCodexSkillsExtraRoots(session);
    const threadInfo = await ensureThread(session, aiSessionId);

    session.reviewActive = true;
    const response = await sendRequestWithReconnectRetry(session, "review/start", {
      threadId: threadInfo.threadId,
      target,
      delivery,
    });
    const result = recordValue(response.result);
    const reviewThreadId = strValue(result.reviewThreadId) ?? threadInfo.threadId;
    const turn = recordValue(result.turn);
    const turnId = strValue(turn.id) ?? "";
    return { reviewThreadId, turnId };
  } catch (err) {
    session.reviewActive = false;
    if (!session.cancelled) {
      emitSessionError(session, errorMessage(err));
    }
    killSession(session);
    if (activeCodexSessions.get(aiSessionId) === session) {
      activeCodexSessions.delete(aiSessionId);
    }
    throw err;
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
    const supportedReasoningEfforts = Array.isArray(row["supportedReasoningEfforts"])
      ? row["supportedReasoningEfforts"].flatMap((item): CodexReasoningEffortOption[] => {
        if (!item || typeof item !== "object") return [];
        const option = item as Record<string, unknown>;
        const reasoningEffort = codexReasoningEffort(option["reasoningEffort"]);
        if (!reasoningEffort) return [];
        return [{
          reasoningEffort,
          description: trimmedOrNull(option["description"]) ?? "",
        }];
      })
      : [];
    const serviceTiers = new Map<string, CodexServiceTierOption>();
    const serviceTierKeys = new Set<string>();
    serviceTiers.set("flex", {
      id: "flex",
      name: "Flex",
      description: "低成本弹性处理，可能需要等待更长时间",
    });
    serviceTierKeys.add("flex");
    if (Array.isArray(row["serviceTiers"])) {
      for (const item of row["serviceTiers"]) {
        if (!item || typeof item !== "object") continue;
        const option = item as Record<string, unknown>;
        const tierId = trimmedOrNull(option["id"]);
        if (!tierId) continue;
        const name = trimmedOrNull(option["name"]) ?? tierId;
        const normalizedId = tierId.toLocaleLowerCase();
        const normalizedName = name.toLocaleLowerCase();
        if (serviceTierKeys.has(normalizedId) || serviceTierKeys.has(normalizedName)) continue;
        serviceTiers.set(tierId, {
          id: tierId,
          name,
          description: trimmedOrNull(option["description"]) ?? "",
        });
        serviceTierKeys.add(normalizedId);
        serviceTierKeys.add(normalizedName);
      }
    }
    if (Array.isArray(row["additionalSpeedTiers"])) {
      for (const value of row["additionalSpeedTiers"]) {
        const tierId = trimmedOrNull(value);
        const normalizedId = tierId?.toLocaleLowerCase();
        if (!tierId || !normalizedId || serviceTierKeys.has(normalizedId)) continue;
        serviceTiers.set(tierId, { id: tierId, name: tierId, description: "" });
        serviceTierKeys.add(normalizedId);
      }
    }
    return [{
      id,
      model,
      displayName: trimmedOrNull(row["displayName"]) ?? model,
      description: trimmedOrNull(row["description"]),
      isDefault: row["isDefault"] === true,
      defaultReasoningEffort: codexReasoningEffort(row["defaultReasoningEffort"]),
      supportedReasoningEfforts,
      defaultServiceTier: trimmedOrNull(row["defaultServiceTier"]),
      serviceTiers: [...serviceTiers.values()],
    }];
  });
}

function extractNextCursor(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  return trimmedOrNull((result as Record<string, unknown>)["nextCursor"]);
}

function approvalModeFromConfigReadResult(result: unknown): CodexApprovalMode {
  const config = recordOrNull(recordOrNull(result)?.["config"]);
  if (!config) return "custom";
  const approvalPolicy = trimmedOrNull(config["approval_policy"]);
  const approvalsReviewer = trimmedOrNull(config["approvals_reviewer"]) ?? "user";
  const sandboxMode = trimmedOrNull(config["sandbox_mode"]);

  if (approvalPolicy === "never" && sandboxMode === "danger-full-access") return "fullAccess";
  if (approvalPolicy === "on-request" && sandboxMode === "workspace-write") {
    return approvalsReviewer === "auto_review" || approvalsReviewer === "guardian_subagent"
      ? "autoEdit"
      : approvalsReviewer === "user"
        ? "suggest"
        : "custom";
  }
  return "custom";
}

export async function getCodexApprovalMode(
  cwd: string,
  sender: Sender = { send: () => undefined },
): Promise<CodexApprovalMode> {
  const session = createSession(`codex-config-read-${Date.now()}`, cwd || os.homedir(), sender);
  const timeout = setTimeout(() => {
    for (const [, pending] of session.pendingRequests) pending.reject(new Error("timeout"));
    session.pendingRequests.clear();
    killSession(session);
  }, CODEX_WARMUP_TIMEOUT_MS);

  try {
    await sendRequestWithReconnectRetry(session, "initialize", CODEX_INITIALIZE_PARAMS);
    const response = await sendRequestWithReconnectRetry(session, "config/read", {
      cwd: session.resolvedCwd,
      includeLayers: false,
    });
    return approvalModeFromConfigReadResult(response.result);
  } finally {
    clearTimeout(timeout);
    killSession(session);
  }
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

export async function steerCodexChat(req: SteerCodexChatRequest): Promise<boolean> {
  const session = activeCodexSessions.get(req.aiSessionId);
  const prompt = req.prompt.trim();
  const images = req.images ?? [];
  const attachments = req.attachments ?? [];
  const contexts = req.contexts ?? [];
  if (!session || session.closed || session.cancelled || !session.threadId || !session.currentTurnId) return false;
  if (!prompt && images.length === 0 && attachments.length === 0 && contexts.length === 0) return false;
  const response = await sendRequestWithReconnectRetry(session, "turn/steer", {
    threadId: session.threadId,
    expectedTurnId: session.currentTurnId,
    clientUserMessageId: req.clientUserMessageId ?? null,
    input: buildUserInput(prompt || "查看添加的上下文", images, attachments, contexts),
  });
  const responseTurnId = extractTurnId(response.result);
  if (responseTurnId) session.currentTurnId = responseTurnId;
  refreshCodexTurnTimeout(session);
  return true;
}

export async function stopCodexChat(aiSessionId: string): Promise<boolean> {
  const session = activeCodexSessions.get(aiSessionId);
  if (!session) return false;
  if (session.cancelled) return true;
  session.cancelled = true;
  clearCodexTurnTimeout(session);
  declinePendingApprovalsForInterrupt(session);
  resolvePendingUserInputs(session);
  finishCodexSessionTrace(session, "canceled");
  if (session.threadId && session.currentTurnId) {
    try {
      await interruptCurrentCodexTurn(session);
    } catch {
      // A process signal is only a fallback when the protocol request cannot complete.
      interruptSession(session);
    }
  }
  const deadline = Date.now() + CODEX_INTERRUPT_SETTLE_TIMEOUT_MS;
  while (activeCodexSessions.get(aiSessionId) === session && Date.now() < deadline) {
    await delay(25);
  }
  if (activeCodexSessions.get(aiSessionId) === session) {
    interruptSession(session);
  }
  return true;
}

export function hasLiveCodexChat(): boolean {
  return activeCodexSessions.size > 0;
}

export function respondCodexApproval(
  aiSessionId: string,
  approvalId: string,
  decision: CodexApprovalDecision,
  scope: CodexPermissionGrantScope = "turn"
): boolean {
  const session = activeCodexSessions.get(aiSessionId);
  if (!session) return false;
  const approval = session.pendingApprovals.get(approvalId);
  if (!approval || approval.resolved) return false;
  approval.resolved = true;
  try {
    sendResponse(session, approval.requestId, approvalResponseFor(approval.method, decision, approval.requestedPermissionsRaw, scope));
    updateApprovalSegment(
      session,
      approval,
      decision,
      decision === "approved" ? "用户已同意本次操作。" : "用户已拒绝本次操作。"
    );
    session.pendingApprovals.delete(approvalId);
    refreshCodexTurnTimeout(session);
    return true;
  } catch (error) {
    updateApprovalSegment(session, approval, "failed", errorMessage(error));
    session.pendingApprovals.delete(approvalId);
    refreshCodexTurnTimeout(session);
    return false;
  }
}

export function respondCodexUserInput(
  aiSessionId: string,
  requestId: string,
  answers: Record<string, string[]>
): boolean {
  const session = activeCodexSessions.get(aiSessionId);
  if (!session) return false;
  const request = session.pendingUserInputs.get(requestId);
  if (!request || request.resolved) return false;
  request.resolved = true;
  const validIds = new Set(request.questions.map((question) => question.id));
  const normalizedAnswers: Record<string, { answers: string[] }> = {};
  for (const [questionId, values] of Object.entries(answers ?? {})) {
    if (!validIds.has(questionId) || !Array.isArray(values)) continue;
    normalizedAnswers[questionId] = {
      answers: values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    };
  }
  try {
    sendResponse(session, request.requestId, { answers: normalizedAnswers });
    clearPendingUserInput(session, requestId);
    refreshCodexTurnTimeout(session);
    return true;
  } catch {
    clearPendingUserInput(session, requestId);
    refreshCodexTurnTimeout(session);
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
    await applyCodexSkillsExtraRoots(session);
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
