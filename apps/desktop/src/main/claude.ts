// Claude Code integration for the Electron main process.
// Uses the official Claude Agent SDK and emits provider trace updates that
// share the same renderer/mobile path as Codex traces.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunAiChatRequest, CodexTraceSnapshot } from "../services/desktop";
import { reportTokenUsage } from "./sync";
import { upsertLocalAiTrace } from "./db";
import { codexTraceSnapshotToSegments } from "./codex_trace";
import { reduceClaudeTraceSnapshot, type ClaudeRawTraceEvent } from "./claude_trace";

type Sender = { send: (channel: string, ...args: unknown[]) => void };

type ActiveClaudeRun = {
  abortController: AbortController;
  sender: Sender;
  snapshot: CodexTraceSnapshot | null;
};

const CLAUDE_TURN_TIMEOUT_MS = 30 * 60_000;
const activeClaudeRuns = new Map<string, ActiveClaudeRun>();

function isDirectoryPath(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function normalizeCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(value);
}

function resolveClaudeCwd(cwd: string): string {
  const requestedCwd = (cwd || "").trim();
  const candidates = [
    requestedCwd ? normalizeCwd(requestedCwd) : "",
    os.homedir(),
    process.cwd(),
  ].filter(Boolean);
  return candidates.find(isDirectoryPath) ?? os.homedir();
}

function resolveClaudeExecutable(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const appData = process.env["APPDATA"] || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(appData, "npm", "claude.cmd"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function claudePermissionMode(req: RunAiChatRequest): PermissionMode {
  return req.claudeMode === "plan" ? "plan" : "auto";
}

function spawnClaude(args: string[], options?: { cwd?: string }): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", "claude.cmd", ...args], {
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn("claude", args, {
    cwd: options?.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function claudeDesktopPrompt(): string {
  return [
    "你是 AI Workbench 桌面端的编程助手。",
    "请严格遵守以下规则：",
    "1. 必须使用中文回复用户。",
    "2. 必须实际执行读取命令（如 ls / cat / grep / find）来了解项目结构和文件内容，不能仅凭推测回答。",
    "3. 在执行任何修改性命令前，先告知用户你打算做什么。",
    "4. 命令执行结果要如实地反馈给用户。",
  ].join("\n");
}

function imagePromptNote(imageCount: number | undefined): string {
  if (!imageCount) return "";
  return `\n\n[用户还粘贴了 ${imageCount} 张图片；当前 Claude Agent SDK 集成暂未直接传递图片二进制，请根据用户文字继续，并在需要时提示用户改用 Codex 或描述图片内容。]`;
}

function buildClaudePrompt(req: RunAiChatRequest): string {
  const goal = req.claudeGoal?.trim();
  const imageNote = imagePromptNote(req.images?.length);
  if (!goal) return `${req.prompt}${imageNote}`;
  return `本轮目标：${goal}\n\n用户请求：\n${req.prompt}${imageNote}`;
}

function isUserStopError(error: unknown): boolean {
  return error instanceof Error && error.message === "AI chat stopped by user";
}

function isResumeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(resume|session|conversation)\b/i.test(message)
    && /\b(not found|missing|invalid|failed|unable|cannot|can't)\b/i.test(message);
}

function emitTrace(aiSessionId: string, sender: Sender, snapshot: CodexTraceSnapshot, rawEvent?: ClaudeRawTraceEvent): void {
  const trace = upsertLocalAiTrace({
    aiSessionId,
    providerId: "claude",
    traceKind: "claude",
    status: snapshot.status,
    rawEvent,
    snapshot,
    finalText: snapshot.finalText,
  });
  sender.send("ai-trace-update", {
    aiSessionId,
    trace: {
      ...trace,
      segments: codexTraceSnapshotToSegments(snapshot),
    },
  });
}

function reduceAndEmit(aiSessionId: string, sender: Sender, message: SDKMessage): CodexTraceSnapshot {
  const run = activeClaudeRuns.get(aiSessionId);
  const rawEvent = {
    message,
    receivedAt: new Date().toISOString(),
  };
  const snapshot = reduceClaudeTraceSnapshot(run?.snapshot, rawEvent);
  if (run) run.snapshot = snapshot;
  emitTrace(aiSessionId, sender, snapshot, rawEvent);
  return snapshot;
}

function markCanceled(aiSessionId: string, run: ActiveClaudeRun): void {
  const now = new Date().toISOString();
  const base = run.snapshot ?? {
    provider: "claude",
    status: "running" as const,
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
  const snapshot: CodexTraceSnapshot = {
    ...base,
    provider: "claude",
    status: "canceled",
    updatedAt: now,
    completedAt: now,
    items: base.items.map((item) => item.status === "running"
      ? { ...item, status: "canceled", completedAt: item.completedAt ?? now }
      : item),
  };
  run.snapshot = snapshot;
  emitTrace(aiSessionId, run.sender, snapshot);
}

function reportClaudeTokenUsage(aiSessionId: string, message: SDKMessage): void {
  if (message.type !== "result") return;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) return;
  const inputTokens = numOrZero(usage.input_tokens)
    + numOrZero(usage.cache_creation_input_tokens)
    + numOrZero(usage.cache_read_input_tokens);
  const outputTokens = numOrZero(usage.output_tokens);
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0) return;
  void reportTokenUsage({
    aiSessionId,
    providerId: "claude",
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens,
  });
}

function numOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return 0;
}

function emitFailure(aiSessionId: string, sender: Sender, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  reduceAndEmit(aiSessionId, sender, {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
    errors: [message],
    uuid: `error-${Date.now()}`,
    session_id: activeClaudeRuns.get(aiSessionId)?.snapshot?.threadId ?? "",
  });
}

async function runClaudeOnce(
  req: RunAiChatRequest,
  sender: Sender,
  existingSessionId: string | null,
): Promise<string> {
  const abortController = new AbortController();
  const run: ActiveClaudeRun = { abortController, sender, snapshot: null };
  activeClaudeRuns.set(req.aiSessionId, run);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, CLAUDE_TURN_TIMEOUT_MS);

  let latestSessionId = existingSessionId ?? "";
  try {
    const queryOptions = {
      cwd: resolveClaudeCwd(req.projectPath),
      resume: existingSessionId || undefined,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      permissionMode: claudePermissionMode(req),
      includePartialMessages: true,
      includeHookEvents: true,
      abortController,
      systemPrompt: { type: "preset", preset: "claude_code", append: claudeDesktopPrompt() },
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "ai-workbench-desktop/0.1.0",
      },
    } satisfies Options;
    const queryOptionsWithRunControls = queryOptions as Options & Record<string, unknown>;
    if (req.claudeModel) queryOptionsWithRunControls.model = req.claudeModel;
    if (req.claudeReasoningEffort) queryOptionsWithRunControls.effort = req.claudeReasoningEffort;

    for await (const message of query({
      prompt: buildClaudePrompt(req),
      options: queryOptions,
    })) {
      latestSessionId = message.session_id || latestSessionId;
      reportClaudeTokenUsage(req.aiSessionId, message);
      reduceAndEmit(req.aiSessionId, sender, message);
    }
    return latestSessionId;
  } catch (error) {
    if (abortController.signal.aborted) {
      if (timedOut) {
        const timeoutError = new Error("Claude 会话超时（30 分钟）");
        emitFailure(req.aiSessionId, sender, timeoutError);
        throw timeoutError;
      }
      markCanceled(req.aiSessionId, run);
      throw new Error("AI chat stopped by user");
    }
    emitFailure(req.aiSessionId, sender, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    activeClaudeRuns.delete(req.aiSessionId);
  }
}

export async function runAiChat(
  req: RunAiChatRequest,
  sender: Sender,
  existingSessionId?: string | null,
): Promise<string> {
  const sessionId = existingSessionId ?? null;
  if (!sessionId) {
    try {
      return await runClaudeOnce(req, sender, null);
    } catch (error) {
      if (isUserStopError(error)) return "";
      throw error;
    }
  }

  try {
    return await runClaudeOnce(req, sender, sessionId);
  } catch (error) {
    if (isUserStopError(error)) return sessionId;
    if (!isResumeFailure(error)) throw error;
    return await runClaudeOnce(req, sender, null);
  }
}

export function stopAiChat(aiSessionId: string): boolean {
  const run = activeClaudeRuns.get(aiSessionId);
  if (!run) return false;
  markCanceled(aiSessionId, run);
  run.abortController.abort();
  return true;
}

export function hasLiveAiChat(): boolean {
  return activeClaudeRuns.size > 0;
}

export async function warmupAiSession(
  _aiSessionId: string,
  _sender: Sender,
): Promise<{ providerSessionId: string }> {
  return new Promise((resolve) => {
    const child = spawnClaude(["--version"]);
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ providerSessionId: "" });
    }, 10_000);

    child.on("exit", () => {
      clearTimeout(timeout);
      resolve({ providerSessionId: "" });
    });

    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ providerSessionId: "" });
    });
  });
}
