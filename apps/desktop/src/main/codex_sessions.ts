import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as db from "./db";
import type { AiHistoryMessage, AiSession, ChatSegment } from "../services/desktop";
import type { Dirent } from "node:fs";

type SessionIndexEntry = {
  id?: string;
  thread_name?: string;
  updated_at?: string;
};

type HistoryEntry = {
  session_id?: string;
  text?: string;
};

type CodexSessionMetaPayload = {
  session_id?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
};

type CodexProjectSession = {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
  source?: string;
  originator?: string;
  cliVersion?: string;
  modelProvider?: string;
  filePath: string;
  imported: boolean;
};

type CodexResponseItemPayload = {
  type?: string;
  role?: string;
  phase?: string;
  content?: unknown;
  name?: string;
  arguments?: string;
  call_id?: string;
  input?: unknown;
  output?: unknown;
};

type CodexEventPayload = CodexResponseItemPayload & {
  message?: string;
  last_agent_message?: string;
  duration_ms?: number;
};

type ImportedAssistantDraft = {
  role: "assistant";
  segments: ChatSegment[];
  finalTextParts: string[];
  createdAt: string;
  completedDurationMs?: number;
  toolStartedAtByCallId: Map<string, string>;
};

const STRUCTURED_MESSAGE_PREFIX = "__AI_WORKBENCH_MESSAGE_V1__";
const CODEX_APP_SERVER_SESSION_PREFIX = "app-server:";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, "sessions");
const CODEX_SESSION_INDEX = path.join(CODEX_DIR, "session_index.jsonl");
const CODEX_HISTORY = path.join(CODEX_DIR, "history.jsonl");
const FIRST_LINE_MAX_BYTES = 64 * 1024;

function normalizeFsPath(value: string): string {
  return path.resolve(value);
}

function isPathInsideProject(projectPath: string, cwd: string): boolean {
  const root = normalizeFsPath(projectPath);
  const target = normalizeFsPath(cwd);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readFirstLine(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(FIRST_LINE_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.indexOf("\n");
    return newlineIndex >= 0 ? chunk.slice(0, newlineIndex) : chunk;
  } finally {
    await handle.close();
  }
}

async function collectRolloutFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRolloutFiles(fullPath));
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readSessionIndex(): Promise<Map<string, SessionIndexEntry>> {
  const entries = new Map<string, SessionIndexEntry>();
  if (!await pathExists(CODEX_SESSION_INDEX)) return entries;

  const content = await fs.readFile(CODEX_SESSION_INDEX, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SessionIndexEntry;
      if (parsed.id) entries.set(parsed.id, parsed);
    } catch {
      // Ignore malformed historical lines and keep the session list usable.
    }
  }
  return entries;
}

async function readHistoryTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (!await pathExists(CODEX_HISTORY)) return titles;

  const content = await fs.readFile(CODEX_HISTORY, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as HistoryEntry;
      if (!parsed.session_id || titles.has(parsed.session_id)) continue;
      const title = titleFromPrompt(parsed.text ?? "");
      if (title) titles.set(parsed.session_id, title);
    } catch {
      // Ignore malformed history rows. The session file fallback still works.
    }
  }
  return titles;
}

function parseSessionMeta(line: string): CodexSessionMetaPayload | null {
  try {
    const parsed = JSON.parse(line) as { type?: string; payload?: CodexSessionMetaPayload };
    if (parsed.type !== "session_meta" || !parsed.payload) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map(extractTextContent).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.output_text === "string") return record.output_text;
  if (typeof record.input_text === "string") return record.input_text;
  if (Array.isArray(record.content)) return extractTextContent(record.content);
  return "";
}

function isVisibleUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("<environment_context>")) return false;
  if (trimmed.includes("# AGENTS.md instructions")) return false;
  if (trimmed.includes("<turn_aborted>")) return false;
  if (trimmed.startsWith("你是 AI Workbench 桌面端的编程助手。")) return false;
  return true;
}

function encodeImportedAssistantMessage(text: string, segments: ChatSegment[]) {
  return `${STRUCTURED_MESSAGE_PREFIX}${JSON.stringify({
    text,
    segments,
    codexHistoryImportVersion: 3,
  })}`;
}

function flushAssistantDraft(messages: AiHistoryMessage[], draft: ImportedAssistantDraft | null) {
  if (!draft) return;
  const promoted = promoteFinalTextFromProcessSegments(draft);
  const text = promoted.text;
  const segments = promoted.segments;
  if (draft.completedDurationMs !== undefined && segments.some(isProcessHistorySegment)) {
    segments.push({
      type: "status",
      stepId: "final-summary",
      label: `已处理 ${formatCompactDuration(draft.completedDurationMs)}`,
      durationMs: draft.completedDurationMs,
    });
  }
  messages.push({
    role: "assistant",
    content: encodeImportedAssistantMessage(text, segments),
    createdAt: draft.createdAt,
  });
}

function promoteFinalTextFromProcessSegments(draft: ImportedAssistantDraft): { text: string; segments: ChatSegment[] } {
  const explicitFinalText = draft.finalTextParts.join("\n\n").trim();
  const segments = [...draft.segments];
  if (explicitFinalText || !segments.length) return { text: explicitFinalText, segments };

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!isProcessTextSegment(segment) || !looksLikeFinalAssistantText(segment.text)) continue;
    segments.splice(index, 1);
    return { text: segment.text.trim(), segments };
  }

  return { text: "", segments };
}

function looksLikeFinalAssistantText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (normalized.length >= 160) return true;
  return /^(?:已按|我已|我会|结论|总结|这里|现在|可以|如果|这次|这样)/.test(normalized)
    || /(?:已完成|已处理|已修复|已实现|构建通过|验证通过|不会|可以|需要|建议)/.test(normalized);
}

function ensureAssistantDraft(draft: ImportedAssistantDraft | null, timestamp?: string): ImportedAssistantDraft {
  return draft ?? {
    role: "assistant",
    segments: [],
    finalTextParts: [],
    createdAt: timestamp ?? new Date(0).toISOString(),
    toolStartedAtByCallId: new Map(),
  };
}

function appendAssistantMessageSegment(draft: ImportedAssistantDraft, payload: CodexResponseItemPayload, text: string) {
  if (payload.phase === "commentary") {
    appendProcessTextSegment(draft, text);
    return;
  }
  appendFinalTextPart(draft, text);
}

function appendProcessTextSegment(draft: ImportedAssistantDraft, text: string) {
  const normalized = text.trim();
  if (!normalized) return;
  const last = draft.segments[draft.segments.length - 1];
  if (last?.type === "text" && last.stepId?.startsWith("process-text-") && last.text === normalized) return;
  draft.segments.push({
    type: "text",
    stepId: `process-text-${draft.segments.length}`,
    text: normalized,
  });
}

function appendFinalTextPart(draft: ImportedAssistantDraft, text: string) {
  const normalized = text.trim();
  if (!normalized) return;
  if (draft.finalTextParts[draft.finalTextParts.length - 1] === normalized) return;
  draft.finalTextParts.push(normalized);
}

function isProcessHistorySegment(segment: ChatSegment) {
  return segment.type === "tool"
    || segment.type === "status"
    || segment.type === "thought"
    || segment.type === "approval"
    || segment.type === "error"
    || (segment.type === "text" && isProcessTextStepId(segment.stepId));
}

function isProcessTextStepId(stepId?: string) {
  return Boolean(stepId && /^(?:process-text|thought|commentary)-/.test(stepId));
}

function formatCompactDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs}ms`;
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (!totalMinutes) return `${seconds}秒`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (!hours) return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
  return seconds ? `${hours}时${minutes}分${seconds}秒` : `${hours}时${minutes}分`;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function commandFromPayload(payload: CodexResponseItemPayload): string {
  const args = parseJsonRecord(payload.arguments);
  const command = args?.["cmd"] ?? args?.["command"] ?? payload.input;
  if (Array.isArray(command)) return command.filter((item) => typeof item === "string").join(" ");
  if (typeof command === "string") return command;
  return "";
}

function toolInputFromPayload(payload: CodexResponseItemPayload): string | undefined {
  const args = parseJsonRecord(payload.arguments);
  if (!args) return typeof payload.input === "string" ? payload.input : undefined;
  if (typeof args["cmd"] === "string" || Array.isArray(args["cmd"])) return undefined;
  return JSON.stringify(args, null, 2);
}

function patchTextFromPayload(payload: CodexResponseItemPayload): string {
  const directInput = typeof payload.input === "string" ? payload.input : "";
  if (directInput.trim().startsWith("*** Begin Patch")) return directInput;
  const args = parseJsonRecord(payload.arguments);
  for (const value of Object.values(args ?? {})) {
    if (typeof value === "string" && value.trim().startsWith("*** Begin Patch")) return value;
  }
  return "";
}

function patchFiles(patch: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    const file = match?.[1]?.trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}

function patchStats(patch: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function shortFileList(files: string[]) {
  if (files.length <= 2) return files.join(", ");
  return `${files.slice(0, 2).join(", ")} 等 ${files.length} 个`;
}

function toolStatusFromOutput(output?: string): "success" | "error" | "running" {
  if (!output) return "running";
  const exitCode = output.match(/Process exited with code\s+(-?\d+)/i)?.[1]
    ?? output.match(/Exit code:\s*(-?\d+)/i)?.[1];
  if (exitCode !== undefined) return exitCode === "0" ? "success" : "error";
  return /\b(error|failed|command failed)\b/i.test(output) ? "error" : "success";
}

function toolNameFromPayload(payload: CodexResponseItemPayload): string {
  const name = payload.name ?? "tool";
  if (name === "write_stdin") return "命令";
  if (/exec|command|shell/i.test(name)) return "命令";
  if (/apply_patch|patch|edit/i.test(name) || patchTextFromPayload(payload)) return "文件修改";
  return name;
}

function appendToolSegment(draft: ImportedAssistantDraft, payload: CodexResponseItemPayload, timestamp?: string) {
  const callId = payload.call_id ?? `${draft.segments.length}`;
  const isOutput = payload.type === "function_call_output" || payload.type === "custom_tool_call_output";
  if (!isOutput && timestamp) draft.toolStartedAtByCallId.set(callId, timestamp);
  const existingIndex = draft.segments.findIndex((segment) => segment.type === "tool" && segment.stepId === callId);
  const output = typeof payload.output === "string" ? payload.output : undefined;
  const patchText = patchTextFromPayload(payload);
  const files = patchFiles(patchText);
  const stats = patchStats(patchText);
  const startedAt = draft.toolStartedAtByCallId.get(callId);
  const durationMs = isOutput && timestamp && startedAt ? Math.max(0, Date.parse(timestamp) - Date.parse(startedAt)) : undefined;
  if (existingIndex >= 0) {
    const existing = draft.segments[existingIndex];
    if (existing.type === "tool") {
      draft.segments[existingIndex] = {
        ...existing,
        status: toolStatusFromOutput(output),
        output: output ? [existing.output, output].filter(Boolean).join("\n") : existing.output,
        diff: existing.diff || patchText || undefined,
        command: files.length ? shortFileList(files) : existing.command,
        additions: existing.additions ?? (patchText ? stats.additions : undefined),
        deletions: existing.deletions ?? (patchText ? stats.deletions : undefined),
        durationMs: durationMs ?? existing.durationMs,
      };
    }
    return;
  }
  const summary = output ? "已执行" : "已请求执行";
  draft.segments.push({
    type: "tool",
    stepId: callId,
    toolName: toolNameFromPayload(payload),
    command: files.length ? shortFileList(files) : commandFromPayload(payload) || undefined,
    status: toolStatusFromOutput(output),
    input: patchText ? undefined : toolInputFromPayload(payload),
    output,
    diff: patchText || undefined,
    summary,
    durationMs,
    additions: patchText ? stats.additions : undefined,
    deletions: patchText ? stats.deletions : undefined,
  });
}

function applyCodexEventPayload(draft: ImportedAssistantDraft | null, payload: CodexEventPayload, timestamp?: string) {
  if (payload.type !== "agent_message" && payload.type !== "task_complete" && payload.type !== "turn_aborted") return draft;
  if (!draft && payload.type !== "agent_message") return draft;
  const nextDraft = ensureAssistantDraft(draft, timestamp);
  if (payload.type === "agent_message") {
    const text = (payload.message ?? "").trim();
    if (text) appendAssistantMessageSegment(nextDraft, payload, text);
  }
  if (payload.type === "task_complete") {
    if (typeof payload.duration_ms === "number") nextDraft.completedDurationMs = payload.duration_ms;
    const finalText = (payload.last_agent_message ?? "").trim();
    if (finalText) appendFinalTextPart(nextDraft, finalText);
  }
  if (payload.type === "turn_aborted" && typeof payload.duration_ms === "number") {
    nextDraft.completedDurationMs = payload.duration_ms;
  }
  return nextDraft;
}

export async function readCodexSessionHistory(filePath: string): Promise<AiHistoryMessage[]> {
  const messages: AiHistoryMessage[] = [];
  if (!filePath || !await pathExists(filePath)) return messages;

  const content = await fs.readFile(filePath, "utf8");
  let assistantDraft: ImportedAssistantDraft | null = null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { timestamp?: string; type?: string; payload?: CodexResponseItemPayload | CodexEventPayload };
      const payload = parsed.payload;
      if (!payload) continue;
      if (parsed.type === "event_msg") {
        assistantDraft = applyCodexEventPayload(assistantDraft, payload as CodexEventPayload, parsed.timestamp);
        continue;
      }
      if (parsed.type !== "response_item") continue;
      if (payload.type === "function_call" || payload.type === "function_call_output" || payload.type === "custom_tool_call" || payload.type === "custom_tool_call_output") {
        assistantDraft = ensureAssistantDraft(assistantDraft, parsed.timestamp);
        appendToolSegment(assistantDraft, payload, parsed.timestamp);
        continue;
      }
      if (payload.type !== "message") continue;
      if (payload.role !== "user" && payload.role !== "assistant") continue;

      const text = extractTextContent(payload.content).trim();
      if (!text) continue;
      if (payload.role === "user") {
        if (!isVisibleUserText(text)) continue;
        flushAssistantDraft(messages, assistantDraft);
        assistantDraft = null;
        messages.push({
          role: "user",
          content: text,
          createdAt: parsed.timestamp ?? new Date(0).toISOString(),
        });
        continue;
      }
      assistantDraft = ensureAssistantDraft(assistantDraft, parsed.timestamp);
      appendAssistantMessageSegment(assistantDraft, payload, text);
    } catch {
      // Ignore malformed rows and keep importing the readable parts.
    }
  }
  flushAssistantDraft(messages, assistantDraft);
  return messages;
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt
    .replace(/\[Image #[^\]]+\]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  if (!normalized) return "";
  if (looksSensitiveTitle(normalized)) return "";
  return normalized.length > 24 ? `${normalized.slice(0, 24)}...` : normalized;
}

function looksSensitiveTitle(value: string): boolean {
  const lower = value.toLowerCase();
  if (/密码|口令|密钥|令牌|验证码/.test(value)) return true;
  if (/(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/.test(lower)) return true;
  if (/^ssh\s+\S+@/i.test(value)) return true;
  if (/^\$argon2(id|i|d)?\$/i.test(value)) return true;
  if (/^[A-Za-z0-9+/=._-]{32,}$/.test(value)) return true;
  return false;
}

function fallbackTitle(sessionId: string) {
  const shortId = sessionId.slice(0, 8);
  return `Codex 会话 ${shortId}`;
}

function sortByUpdatedAt(left: CodexProjectSession, right: CodexProjectSession) {
  const rightTime = Date.parse(right.updatedAt);
  const leftTime = Date.parse(left.updatedAt);
  return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
}

async function listCodexProjectSessions(
  projectPath: string,
  localSessions: AiSession[] = []
): Promise<CodexProjectSession[]> {
  const trimmedProjectPath = projectPath.trim();
  if (!trimmedProjectPath || !await pathExists(CODEX_SESSIONS_DIR)) return [];

  const importedProviderSessionIds = new Set(
    localSessions
      .map((session) => session.providerSessionId)
      .filter((value): value is string => Boolean(value))
      .map(normalizeProviderSessionId)
  );
  const [indexEntries, historyTitles, rolloutFiles] = await Promise.all([
    readSessionIndex(),
    readHistoryTitles(),
    collectRolloutFiles(CODEX_SESSIONS_DIR),
  ]);

  const sessions: CodexProjectSession[] = [];
  const seenIds = new Set<string>();
  for (const filePath of rolloutFiles) {
    let meta: CodexSessionMetaPayload | null = null;
    try {
      meta = parseSessionMeta(await readFirstLine(filePath));
    } catch {
      continue;
    }
    const sessionId = meta?.session_id ?? meta?.id;
    if (!sessionId || !meta?.cwd || seenIds.has(sessionId)) continue;
    if (!isPathInsideProject(trimmedProjectPath, meta.cwd)) continue;

    const indexed = indexEntries.get(sessionId);
    const updatedAt = indexed?.updated_at ?? meta.timestamp ?? new Date(0).toISOString();
    sessions.push({
      id: sessionId,
      title: indexed?.thread_name?.trim() || historyTitles.get(sessionId) || fallbackTitle(sessionId),
      updatedAt,
      cwd: meta.cwd,
      source: meta.source,
      originator: meta.originator,
      cliVersion: meta.cli_version,
      modelProvider: meta.model_provider,
      filePath,
      imported: importedProviderSessionIds.has(sessionId),
    });
    seenIds.add(sessionId);
  }

  return sessions.sort(sortByUpdatedAt);
}

function hasImportedCodexHistory(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((message) =>
    message.role === "assistant"
    && message.content.includes(STRUCTURED_MESSAGE_PREFIX)
    && /"codexHistoryImportVersion":(?:2|3)/.test(message.content)
  );
}

function isAppServerProviderSession(providerSessionId: string): boolean {
  return providerSessionId.startsWith(CODEX_APP_SERVER_SESSION_PREFIX);
}

function normalizeProviderSessionId(providerSessionId: string): string {
  return isAppServerProviderSession(providerSessionId)
    ? providerSessionId.slice(CODEX_APP_SERVER_SESSION_PREFIX.length)
    : providerSessionId;
}

function hasLocalWorkbenchHistory(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((message) => message.role === "user" || message.content.startsWith(STRUCTURED_MESSAGE_PREFIX));
}

function hasToolCodexHistory(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((message) =>
    message.role === "assistant"
    && message.content.includes(STRUCTURED_MESSAGE_PREFIX)
    && message.content.includes("\"type\":\"tool\"")
    && message.content.includes("\"codexHistoryImportVersion\":3")
  );
}

function historiesEqual(
  left: Array<{ role: string; content: string; createdAt?: string }>,
  right: Array<{ role: string; content: string; createdAt?: string }>
): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return message.role === other.role
      && message.content === other.content
      && (message.createdAt ?? "") === (other.createdAt ?? "");
  });
}

export async function syncCodexHistoryMirror(sessionId: string): Promise<boolean> {
  const session = db.getLocalAiSession(sessionId);
  if (!session?.providerSessionId || session.providerId !== "codex" || !session.summary) return false;
  if (isAppServerProviderSession(session.providerSessionId)) return false;
  const existingHistory = db.listLocalAiHistory(sessionId);
  const isImportedMirror = hasImportedCodexHistory(existingHistory);
  if (!isImportedMirror && hasLocalWorkbenchHistory(existingHistory)) return false;
  const needsUpgrade = !hasToolCodexHistory(existingHistory);
  const codexSession = (await listCodexProjectSessions(session.summary, db.listLocalAiSessions()))
    .find((item) => item.id === session.providerSessionId);
  if (!codexSession) return false;
  const history = await readCodexSessionHistory(codexSession.filePath);
  if (!history.length) return false;
  const historyChanged = !historiesEqual(existingHistory, history);
  const nextTitle = codexSession.title || session.title;
  const titleChanged = nextTitle !== session.title;
  const updatedAtChanged = Boolean(codexSession.updatedAt && codexSession.updatedAt !== session.updatedAt);
  if (!historyChanged && !titleChanged && !updatedAtChanged) return false;
  let messagesChanged = false;
  if (historyChanged) {
    const shouldReplace = existingHistory.length === 0 || (isImportedMirror && needsUpgrade);
    messagesChanged = shouldReplace
      ? (db.replaceLocalAiHistory(sessionId, history), true)
      : db.mergeLocalAiHistory(sessionId, history);
  }
  if (titleChanged || updatedAtChanged) {
    db.updateLocalAiSession(sessionId, {
      title: nextTitle,
      status: session.status,
      updatedAt: codexSession.updatedAt || session.updatedAt,
    });
  }
  return messagesChanged || titleChanged || updatedAtChanged;
}
