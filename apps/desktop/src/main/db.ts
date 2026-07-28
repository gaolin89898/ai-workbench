// SQLite module for the Electron main process.
// Singletons: the DB is opened once at module load and reused by all helpers.
// Schema mirrors the original Rust local-store implementation.

import { app } from "electron";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { readGitStatus } from "./projects";
import { replayCodexTraceEvents } from "./codex_trace";
import type {
  AiSession,
  WorkspaceProject,
  AiHistoryMessage,
  ChatMessage,
  AiProviderTrace,
  AiActivitySummary,
} from "../services/desktop";

// ---------- DB path resolution & initialization ----------

function resolveDbPath(): string {
  const env = process.env.AI_WORKBENCH_DB;
  if (env && env.trim().length > 0) return env;
  return path.join(os.homedir(), ".ai-workbench", "history.db");
}

const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const STRUCTURED_MESSAGE_PREFIX = "__AI_WORKBENCH_MESSAGE_V1__";

db.exec(`
  CREATE TABLE IF NOT EXISTS local_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    git_branch TEXT,
    git_dirty INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_ai_sessions (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    terminal_session_id TEXT,
    provider_session_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    project_path TEXT,
    orchestration_mode TEXT DEFAULT 'single',
    pipeline_config TEXT,
    archived_at TEXT,
    updated_at TEXT NOT NULL
  );
`);

// 迁移：为旧数据库补充 project_path 列（新数据库已包含该列）
try {
  const columns = db.prepare("PRAGMA table_info(local_ai_sessions)").all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === "project_path")) {
    db.exec("ALTER TABLE local_ai_sessions ADD COLUMN project_path TEXT");
    // 将旧数据中复用为项目路径的 summary 迁移到 project_path，并清空 summary 以恢复其摘要语义
    db.exec("UPDATE local_ai_sessions SET project_path = summary, summary = NULL WHERE summary IS NOT NULL");
  }
  if (!columns.some((col) => col.name === "orchestration_mode")) {
    db.exec("ALTER TABLE local_ai_sessions ADD COLUMN orchestration_mode TEXT DEFAULT 'single'");
  }
  if (!columns.some((col) => col.name === "pipeline_config")) {
    db.exec("ALTER TABLE local_ai_sessions ADD COLUMN pipeline_config TEXT");
  }
} catch {
  // 忽略迁移错误，保持启动健壮
}

// 迁移：为消息表补充 agent_role 列
try {
  const msgColumns = db.prepare("PRAGMA table_info(local_ai_messages)").all() as Array<{ name: string }>;
  if (!msgColumns.some((col) => col.name === "agent_role")) {
    db.exec("ALTER TABLE local_ai_messages ADD COLUMN agent_role TEXT");
  }
} catch {
  // 忽略迁移错误，保持启动健壮
}

db.exec(`
  CREATE TABLE IF NOT EXISTS local_ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ai_session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    agent_role TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_local_ai_messages_session ON local_ai_messages(ai_session_id);

  CREATE TABLE IF NOT EXISTS local_ai_traces (
    ai_session_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    trace_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    raw_events TEXT NOT NULL DEFAULT '[]',
    snapshot TEXT NOT NULL DEFAULT '{}',
    final_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (ai_session_id, trace_kind)
  );

  CREATE INDEX IF NOT EXISTS idx_local_ai_traces_session ON local_ai_traces(ai_session_id);
`);

process.on("exit", () => {
  try {
    db.close();
  } catch {
    // ignore — process is tearing down
  }
});

// ---------- Row types ----------

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  git_branch: string | null;
  git_dirty: number;
  updated_at: string;
}

interface SessionRow {
  id: string;
  provider_id: string;
  terminal_session_id: string | null;
  provider_session_id: string | null;
  title: string;
  status: string;
  summary: string | null;
  project_path: string | null;
  orchestration_mode: string | null;
  pipeline_config: string | null;
  archived_at: string | null;
  updated_at: string;
}

interface MessageRow {
  id: number;
  ai_session_id: string;
  role: string;
  content: string;
  agent_role: string | null;
  created_at: string;
}

interface TraceRow {
  ai_session_id: string;
  provider_id: string;
  trace_kind: string;
  status: string;
  raw_events: string;
  snapshot: string;
  final_text: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Mappers ----------

function rowToProject(row: ProjectRow): WorkspaceProject {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    gitBranch: row.git_branch,
    gitDirty: row.git_dirty !== 0,
  };
}

function rowToSession(row: SessionRow): AiSession {
  return {
    id: row.id,
    providerId: row.provider_id,
    terminalSessionId: row.terminal_session_id,
    providerSessionId: row.provider_session_id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    projectPath: row.project_path,
    orchestrationMode: row.orchestration_mode ?? "single",
    pipelineConfig: row.pipeline_config,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): AiHistoryMessage {
  return {
    role: row.role as AiHistoryMessage["role"],
    content: row.content,
    createdAt: row.created_at,
    agentRole: row.agent_role,
  };
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToTrace(row: TraceRow, includeRawEvents = false): AiProviderTrace {
  return {
    aiSessionId: row.ai_session_id,
    providerId: row.provider_id,
    traceKind: row.trace_kind,
    status: row.status,
    rawEvents: includeRawEvents ? safeJsonParse<unknown[]>(row.raw_events, []) : undefined,
    snapshot: safeJsonParse<Record<string, unknown>>(row.snapshot, {}),
    finalText: row.final_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Workspace projects ----------

export function listWorkspaceProjects(): WorkspaceProject[] {
  const rows = db
    .prepare("SELECT * FROM local_projects ORDER BY name ASC")
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export async function addWorkspaceProject(
  projectPath: string
): Promise<WorkspaceProject> {
  const id = randomUUID();
  const name = path.basename(projectPath) || projectPath;
  const { branch, dirty } = await readGitStatus(projectPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO local_projects (id, name, path, git_branch, git_dirty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       name = excluded.name,
       git_branch = excluded.git_branch,
       git_dirty = excluded.git_dirty,
       updated_at = excluded.updated_at`
  ).run(id, name, projectPath, branch, dirty ? 1 : 0, now);
  const row = db
    .prepare("SELECT * FROM local_projects WHERE path = ?")
    .get(projectPath) as ProjectRow;
  return rowToProject(row);
}

export function renameWorkspaceProject(id: string, name: string): WorkspaceProject {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE local_projects SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, now, id);
  if (result.changes === 0) {
    throw new Error(`workspace project not found: ${id}`);
  }
  const row = db
    .prepare("SELECT * FROM local_projects WHERE id = ?")
    .get(id) as ProjectRow;
  return rowToProject(row);
}

export function removeWorkspaceProject(id: string): void {
  db.prepare("DELETE FROM local_projects WHERE id = ?").run(id);
}

export function getWorkspaceProject(id: string): WorkspaceProject | null {
  const row = db
    .prepare("SELECT * FROM local_projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function getWorkspaceProjectByPath(projectPath: string): WorkspaceProject | null {
  const row = db
    .prepare("SELECT * FROM local_projects WHERE path = ?")
    .get(projectPath) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

function normalizePathForCompare(value: string): string {
  return path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function isSameOrChildPath(candidatePath: string, parentPath: string): boolean {
  const candidate = normalizePathForCompare(candidatePath);
  const parent = normalizePathForCompare(parentPath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export function findWorkspaceProjectForPath(projectPath: string): WorkspaceProject | null {
  const rows = db.prepare("SELECT * FROM local_projects").all() as ProjectRow[];
  let best: ProjectRow | null = null;
  let bestLength = -1;
  for (const row of rows) {
    if (!isSameOrChildPath(projectPath, row.path)) continue;
    const length = normalizePathForCompare(row.path).length;
    if (length > bestLength) {
      best = row;
      bestLength = length;
    }
  }
  return best ? rowToProject(best) : null;
}

export async function resolveWorkspaceProjectPath(projectPath: string): Promise<string> {
  const existing = findWorkspaceProjectForPath(projectPath);
  if (existing) return existing.path;
  const project = await addWorkspaceProject(projectPath);
  return project.path;
}

// ---------- AI sessions ----------

export function createLocalAiSession(params: {
  id: string;
  providerId: string;
  terminalSessionId?: string | null;
  providerSessionId?: string | null;
  title: string;
  status: string;
  summary?: string | null;
  projectPath?: string | null;
  orchestrationMode?: string | null;
  pipelineConfig?: string | null;
  updatedAt?: string | null;
}): AiSession {
  const now = params.updatedAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO local_ai_sessions
      (id, provider_id, terminal_session_id, provider_session_id, title, status, summary, project_path, orchestration_mode, pipeline_config, archived_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    params.id,
    params.providerId,
    params.terminalSessionId ?? null,
    params.providerSessionId ?? null,
    params.title,
    params.status,
    params.summary ?? null,
    params.projectPath ?? null,
    params.orchestrationMode ?? "single",
    params.pipelineConfig ?? null,
    now
  );
  const row = db
    .prepare("SELECT * FROM local_ai_sessions WHERE id = ?")
    .get(params.id) as SessionRow;
  return rowToSession(row);
}

export function listLocalAiSessions(): AiSession[] {
  const rows = db
    .prepare("SELECT * FROM local_ai_sessions ORDER BY updated_at DESC")
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

export function getLocalAiSession(aiSessionId: string): AiSession | null {
  const row = db
    .prepare("SELECT * FROM local_ai_sessions WHERE id = ?")
    .get(aiSessionId) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function updateLocalAiSession(
  aiSessionId: string,
  updates: Partial<{
    providerSessionId: string | null;
    status: string;
    summary: string | null;
    projectPath: string | null;
    title: string;
    updatedAt: string | null;
  }>
): AiSession {
  const sets: string[] = [];
  const values: Array<string | null> = [];
  if (updates.providerSessionId !== undefined) {
    sets.push("provider_session_id = ?");
    values.push(updates.providerSessionId);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (updates.summary !== undefined) {
    sets.push("summary = ?");
    values.push(updates.summary);
  }
  if (updates.projectPath !== undefined) {
    sets.push("project_path = ?");
    values.push(updates.projectPath);
  }
  if (updates.title !== undefined) {
    sets.push("title = ?");
    values.push(updates.title);
  }
  if (updates.updatedAt !== undefined) {
    sets.push("updated_at = ?");
    values.push(updates.updatedAt ?? new Date().toISOString());
  } else {
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
  }
  values.push(aiSessionId);
  const result = db
    .prepare(`UPDATE local_ai_sessions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
  if (result.changes === 0) {
    throw new Error(`ai session not found: ${aiSessionId}`);
  }
  const row = db
    .prepare("SELECT * FROM local_ai_sessions WHERE id = ?")
    .get(aiSessionId) as SessionRow;
  return rowToSession(row);
}

export function archiveLocalAiSession(
  aiSessionId: string,
  archived: boolean
): AiSession {
  const now = new Date().toISOString();
  const archivedAt = archived ? now : null;
  const result = db
    .prepare(
      "UPDATE local_ai_sessions SET archived_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(archivedAt, now, aiSessionId);
  if (result.changes === 0) {
    throw new Error(`ai session not found: ${aiSessionId}`);
  }
  const row = db
    .prepare("SELECT * FROM local_ai_sessions WHERE id = ?")
    .get(aiSessionId) as SessionRow;
  return rowToSession(row);
}

export function deleteLocalAiSession(aiSessionId: string): boolean {
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM local_ai_messages WHERE ai_session_id = ?").run(aiSessionId);
    db.prepare("DELETE FROM local_ai_traces WHERE ai_session_id = ?").run(aiSessionId);
    return db.prepare("DELETE FROM local_ai_sessions WHERE id = ?").run(aiSessionId).changes > 0;
  });
  const deleted = remove();
  if (deleted) {
    const logPath = path.join(app.getPath("logs"), "ai-sessions", `${aiSessionId}.md`);
    try { fs.rmSync(logPath, { force: true }); } catch { /* ignore stale log cleanup errors */ }
  }
  return deleted;
}

// ---------- AI provider traces ----------

export function resetLocalAiTrace(params: {
  aiSessionId: string;
  providerId: string;
  traceKind: string;
  status?: string;
  snapshot?: unknown;
}): AiProviderTrace {
  const now = new Date().toISOString();
  const snapshot = JSON.stringify(params.snapshot ?? {});
  db.prepare(
    `INSERT INTO local_ai_traces
      (ai_session_id, provider_id, trace_kind, status, raw_events, snapshot, final_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, NULL, ?, ?)
     ON CONFLICT(ai_session_id, trace_kind) DO UPDATE SET
       provider_id = excluded.provider_id,
       status = excluded.status,
       raw_events = excluded.raw_events,
       snapshot = excluded.snapshot,
       final_text = excluded.final_text,
       updated_at = excluded.updated_at`
  ).run(
    params.aiSessionId,
    params.providerId,
    params.traceKind,
    params.status ?? "running",
    snapshot,
    now,
    now,
  );
  const row = db.prepare(
    "SELECT * FROM local_ai_traces WHERE ai_session_id = ? AND trace_kind = ?"
  ).get(params.aiSessionId, params.traceKind) as TraceRow;
  return rowToTrace(row, true);
}

export function upsertLocalAiTrace(params: {
  aiSessionId: string;
  providerId: string;
  traceKind: string;
  status: string;
  rawEvent?: unknown;
  snapshot: unknown;
  finalText?: string | null;
}): AiProviderTrace {
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT * FROM local_ai_traces WHERE ai_session_id = ? AND trace_kind = ?"
  ).get(params.aiSessionId, params.traceKind) as TraceRow | undefined;
  const rawEvents = existing ? safeJsonParse<unknown[]>(existing.raw_events, []) : [];
  if (params.rawEvent !== undefined) rawEvents.push(params.rawEvent);
  const createdAt = existing?.created_at ?? now;
  db.prepare(
    `INSERT INTO local_ai_traces
      (ai_session_id, provider_id, trace_kind, status, raw_events, snapshot, final_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ai_session_id, trace_kind) DO UPDATE SET
       provider_id = excluded.provider_id,
       status = excluded.status,
       raw_events = excluded.raw_events,
       snapshot = excluded.snapshot,
       final_text = excluded.final_text,
       updated_at = excluded.updated_at`
  ).run(
    params.aiSessionId,
    params.providerId,
    params.traceKind,
    params.status,
    JSON.stringify(rawEvents),
    JSON.stringify(params.snapshot ?? {}),
    params.finalText ?? null,
    createdAt,
    now,
  );
  const row = db.prepare(
    "SELECT * FROM local_ai_traces WHERE ai_session_id = ? AND trace_kind = ?"
  ).get(params.aiSessionId, params.traceKind) as TraceRow;
  return rowToTrace(row, false);
}

export function getLocalAiTrace(
  aiSessionId: string,
  traceKind = "codex",
  includeRawEvents = false,
): AiProviderTrace | null {
  let row = db.prepare(
    "SELECT * FROM local_ai_traces WHERE ai_session_id = ? AND trace_kind = ?"
  ).get(aiSessionId, traceKind) as TraceRow | undefined;
  if (row?.provider_id === "codex") {
    const snapshot = safeJsonParse<Record<string, unknown>>(row.snapshot, {});
    const rawEvents = safeJsonParse<unknown[]>(row.raw_events, []);
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const needsDiffRepair = items.some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      const rawType = typeof item.rawItemType === "string" ? item.rawItemType : "";
      const diff = typeof item.diff === "string" ? item.diff.trim() : "";
      return /^(?:fileChange|file_change|fileEdit|file_edit)$/i.test(rawType) && !diff;
    });
    const storedFinalText = typeof snapshot.finalText === "string" ? snapshot.finalText.trim() : "";
    const needsPlanReplay = !storedFinalText && rawEvents.some((event) => (
      event && typeof event === "object" && !Array.isArray(event)
      && (event as Record<string, unknown>).method === "item/plan/delta"
    ));
    if (needsDiffRepair || needsPlanReplay) {
      const replayed = replayCodexTraceEvents(rawEvents);
      if (replayed) {
        const repairedSnapshot = JSON.stringify(replayed);
        const repairedFinalText = replayed.finalText.trim();
        db.prepare(
          "UPDATE local_ai_traces SET snapshot = ?, final_text = COALESCE(NULLIF(?, ''), final_text) WHERE ai_session_id = ? AND trace_kind = ?"
        ).run(repairedSnapshot, repairedFinalText, aiSessionId, traceKind);
        row = {
          ...row,
          snapshot: repairedSnapshot,
          final_text: repairedFinalText || row.final_text,
        };
      }
    }
  }
  return row ? rowToTrace(row, includeRawEvents) : null;
}

function markdownEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

function decodeStoredMessageContent(content: string): { text: string; imageNames: string[]; fileNames: string[] } {
  if (!content.startsWith(STRUCTURED_MESSAGE_PREFIX)) return { text: content, imageNames: [], fileNames: [] };
  try {
    const parsed = JSON.parse(content.slice(STRUCTURED_MESSAGE_PREFIX.length));
    if (!parsed || typeof parsed !== "object") return { text: content, imageNames: [], fileNames: [] };
    const record = parsed as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    const images = Array.isArray(record.images) ? record.images : [];
    const imageNames = images
      .map((image) => image && typeof image === "object" ? (image as Record<string, unknown>).name : null)
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
    const attachments = Array.isArray(record.attachments) ? record.attachments : [];
    const fileNames = attachments
      .map((attachment) => attachment && typeof attachment === "object" ? (attachment as Record<string, unknown>).name : null)
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
    if (text || imageNames.length || fileNames.length) return { text, imageNames, fileNames };
  } catch {
    return { text: content, imageNames: [], fileNames: [] };
  }
  return { text: content, imageNames: [], fileNames: [] };
}

function roleLabel(role: string): string {
  switch (role) {
    case "user": return "User";
    case "assistant": return "Assistant";
    case "system": return "System";
    case "error": return "Error";
    default: return role || "Message";
  }
}

function writeLocalAiSessionLog(aiSessionId: string): void {
  try {
    const session = getLocalAiSession(aiSessionId);
    const rows = db
      .prepare("SELECT * FROM local_ai_messages WHERE ai_session_id = ? ORDER BY datetime(created_at) ASC, id ASC")
      .all(aiSessionId) as MessageRow[];
    const logsDir = path.join(app.getPath("logs"), "ai-sessions");
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `${aiSessionId}.md`);
    const lines: string[] = [
      `# ${markdownEscape(session?.title || "AI Session")}`,
      "",
      `- Session ID: ${aiSessionId}`,
      `- Provider: ${session?.providerId ?? "unknown"}`,
      `- Project: ${session?.projectPath ?? ""}`,
      `- Updated: ${new Date().toISOString()}`,
      "",
    ];
    for (const row of rows) {
      const decoded = decodeStoredMessageContent(row.content);
      lines.push(`## ${roleLabel(row.role)} - ${row.created_at}`, "");
      if (decoded.text.trim()) {
        lines.push(decoded.text.trim(), "");
      }
      if (decoded.imageNames.length) {
        lines.push(`Images: ${decoded.imageNames.join(", ")}`, "");
      }
      if (decoded.fileNames.length) {
        lines.push(`Files: ${decoded.fileNames.join(", ")}`, "");
      }
    }
    fs.writeFileSync(filePath, `${lines.join("\n").trimEnd()}\n`, "utf-8");
  } catch (error) {
    console.error("Failed to write AI session log:", error);
  }
}
// ---------- AI messages ----------

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getAiActivitySummary(): AiActivitySummary {
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  const rangeStart = new Date(today);
  rangeStart.setDate(today.getDate() - today.getDay() - 52 * 7);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeStart.getDate() + 53 * 7 - 1);
  const statisticsStart = new Date(today);
  statisticsStart.setDate(today.getDate() - 364);

  const queryStart = new Date(rangeStart);
  queryStart.setHours(0, 0, 0, 0);
  const rows = db
    .prepare(
      `SELECT messages.created_at, sessions.provider_id, sessions.project_path
       FROM local_ai_messages AS messages
       LEFT JOIN local_ai_sessions AS sessions ON sessions.id = messages.ai_session_id
       WHERE messages.role = 'user' AND datetime(messages.created_at) >= datetime(?)
       ORDER BY datetime(messages.created_at) ASC`,
    )
    .all(queryStart.toISOString()) as Array<{ created_at: string; provider_id: string | null; project_path: string | null }>;

  const counts = new Map<string, number>();
  const providerCounts = new Map<string, Map<string, number>>();
  const workspaceProjects = listWorkspaceProjects();
  const projectsByPathSpecificity = [...workspaceProjects]
    .sort((left, right) => normalizePathForCompare(right.path).length - normalizePathForCompare(left.path).length);
  const projectActivity = new Map(workspaceProjects.map((project) => [project.id, {
    count: 0,
    lastActiveAt: "",
    providerCounts: new Map<string, number>(),
  }]));
  const statisticsStartKey = localDateKey(statisticsStart);
  const todayKey = localDateKey(today);
  for (const row of rows) {
    const date = new Date(row.created_at);
    if (Number.isNaN(date.getTime())) continue;
    const key = localDateKey(date);
    if (key < localDateKey(rangeStart) || key > localDateKey(rangeEnd)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (row.provider_id) {
      const dayProviders = providerCounts.get(key) ?? new Map<string, number>();
      dayProviders.set(row.provider_id, (dayProviders.get(row.provider_id) ?? 0) + 1);
      providerCounts.set(key, dayProviders);
    }
    if (key < statisticsStartKey || key > todayKey || !row.project_path) continue;
    const projectPath = row.project_path;
    const project = projectsByPathSpecificity.find((candidate) => isSameOrChildPath(projectPath, candidate.path));
    if (!project) continue;
    const activity = projectActivity.get(project.id);
    if (!activity) continue;
    activity.count += 1;
    if (!activity.lastActiveAt || date.getTime() > new Date(activity.lastActiveAt).getTime()) {
      activity.lastActiveAt = date.toISOString();
    }
    if (row.provider_id) {
      activity.providerCounts.set(row.provider_id, (activity.providerCounts.get(row.provider_id) ?? 0) + 1);
    }
  }

  let longestStreak = 0;
  let runningStreak = 0;
  const cursor = new Date(statisticsStart);
  while (cursor <= today) {
    if ((counts.get(localDateKey(cursor)) ?? 0) > 0) {
      runningStreak += 1;
      longestStreak = Math.max(longestStreak, runningStreak);
    } else {
      runningStreak = 0;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const currentCursor = new Date(today);
  if (!counts.has(localDateKey(currentCursor))) {
    currentCursor.setDate(currentCursor.getDate() - 1);
  }
  let currentStreak = 0;
  while (currentCursor >= statisticsStart && counts.has(localDateKey(currentCursor))) {
    currentStreak += 1;
    currentCursor.setDate(currentCursor.getDate() - 1);
  }

  const days = [...counts.entries()]
    .map(([date, count]) => {
      const providers = [...(providerCounts.get(date)?.entries() ?? [])]
        .sort((left, right) => right[1] - left[1]);
      return { date, count, providerId: providers[0]?.[0] };
    })
    .sort((left, right) => left.date.localeCompare(right.date));
  const statisticDays = days.filter((day) => day.date >= localDateKey(statisticsStart) && day.date <= localDateKey(today));
  const projects = workspaceProjects
    .map((project) => {
      const activity = projectActivity.get(project.id)!;
      const providers = [...activity.providerCounts.entries()].sort((left, right) => right[1] - left[1]);
      return {
        id: project.id,
        name: project.name,
        path: project.path,
        count: activity.count,
        providerId: providers[0]?.[0],
        lastActiveAt: activity.lastActiveAt || undefined,
      };
    })
    .sort((left, right) => right.count - left.count
      || (right.lastActiveAt ?? "").localeCompare(left.lastActiveAt ?? "")
      || left.name.localeCompare(right.name));

  return {
    days,
    projects,
    activeDays: statisticDays.length,
    currentStreak,
    longestStreak,
    totalInteractions: statisticDays.reduce((total, day) => total + day.count, 0),
    rangeStart: localDateKey(rangeStart),
    rangeEnd: localDateKey(rangeEnd),
  };
}

export function appendLocalAiMessage(
  aiSessionId: string,
  role: ChatMessage["role"],
  content: string,
  agentRole?: string | null
): void {
  if (role === "assistant" && !agentRole) {
    const previous = db
      .prepare("SELECT rowid AS id, role, content FROM local_ai_messages WHERE ai_session_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(aiSessionId) as { id: number; role: string; content: string } | undefined;
    if (previous?.role === role) {
      if (previous.content === content) return;
      const previousText = assistantDisplayText(previous.content);
      const nextText = assistantDisplayText(content);
      if (areDuplicateAssistantDisplays(previousText, nextText)) {
        if (historyContentScore(content) > historyContentScore(previous.content)) {
          db.prepare("UPDATE local_ai_messages SET content = ?, created_at = ? WHERE rowid = ?")
            .run(content, new Date().toISOString(), previous.id);
          writeLocalAiSessionLog(aiSessionId);
        }
        return;
      }
    }
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO local_ai_messages (ai_session_id, role, content, agent_role, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(aiSessionId, role, content, agentRole ?? null, now);
  writeLocalAiSessionLog(aiSessionId);
}

export function replaceLocalAiHistory(
  aiSessionId: string,
  messages: Array<{ role: ChatMessage["role"]; content: string; createdAt?: string }>
): void {
  const insert = db.prepare(
    `INSERT INTO local_ai_messages (ai_session_id, role, content, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM local_ai_messages WHERE ai_session_id = ?").run(aiSessionId);
    for (const message of messages) {
      insert.run(aiSessionId, message.role, message.content, message.createdAt ?? new Date().toISOString());
    }
  });
  replace();
  writeLocalAiSessionLog(aiSessionId);
}

export function mergeLocalAiHistory(
  aiSessionId: string,
  messages: Array<{ role: ChatMessage["role"]; content: string; createdAt?: string }>
): boolean {
  const existingRows = db
    .prepare("SELECT rowid AS id, role, content, created_at FROM local_ai_messages WHERE ai_session_id = ? ORDER BY rowid ASC")
    .all(aiSessionId) as Array<{ id: number; role: string; content: string; created_at: string }>;
  const exactSeen = new Set(existingRows.map((message) =>
    `${message.role}\u0000${message.created_at}\u0000${message.content}`
  ));
  const rowsByTurn = new Map<string, Array<{ id: number; content: string }>>();
  for (const row of existingRows) {
    const key = `${row.role}\u0000${row.created_at}`;
    rowsByTurn.set(key, [...(rowsByTurn.get(key) ?? []), { id: row.id, content: row.content }]);
  }
  const insert = db.prepare(
    `INSERT INTO local_ai_messages (ai_session_id, role, content, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const update = db.prepare("UPDATE local_ai_messages SET content = ? WHERE rowid = ?");
  const removeDuplicate = db.prepare("DELETE FROM local_ai_messages WHERE rowid = ?");
  let changed = 0;
  const merge = db.transaction(() => {
    for (const message of messages) {
      const createdAt = message.createdAt ?? new Date().toISOString();
      const key = `${message.role}\u0000${createdAt}\u0000${message.content}`;
      if (exactSeen.has(key)) continue;
      const turnKey = `${message.role}\u0000${createdAt}`;
      const existingTurnRows = rowsByTurn.get(turnKey);
      if (existingTurnRows?.length) {
        const keeper = existingTurnRows[0];
        if (keeper.content !== message.content) {
          update.run(message.content, keeper.id);
          keeper.content = message.content;
          changed += 1;
        }
        for (const duplicate of existingTurnRows.slice(1)) {
          removeDuplicate.run(duplicate.id);
          changed += 1;
        }
        rowsByTurn.set(turnKey, [keeper]);
        exactSeen.add(key);
        continue;
      }
      const result = insert.run(aiSessionId, message.role, message.content, createdAt);
      const insertedId = Number(result.lastInsertRowid);
      rowsByTurn.set(turnKey, [{ id: insertedId, content: message.content }]);
      exactSeen.add(key);
      changed += 1;
    }
  });
  merge();
  if (changed > 0) writeLocalAiSessionLog(aiSessionId);
  return changed > 0;
}

function compactLocalAiHistory(aiSessionId: string): void {
  const rows = db
    .prepare("SELECT rowid AS id, role, content, created_at FROM local_ai_messages WHERE ai_session_id = ? ORDER BY rowid ASC")
    .all(aiSessionId) as Array<{ id: number; role: string; content: string; created_at: string }>;
  const bestByTurn = new Map<string, { id: number; content: string }>();
  const idsToDelete: number[] = [];
  const compactedRows: Array<{ id: number; role: string; content: string; created_at: string }> = [];
  for (const row of rows) {
    const key = `${row.role}\u0000${row.created_at}`;
    const current = bestByTurn.get(key);
    if (!current) {
      bestByTurn.set(key, { id: row.id, content: row.content });
    } else if (row.content.length > current.content.length) {
      idsToDelete.push(current.id);
      bestByTurn.set(key, { id: row.id, content: row.content });
      const currentIndex = compactedRows.findIndex((item) => item.id === current.id);
      if (currentIndex >= 0) compactedRows.splice(currentIndex, 1);
    } else {
      idsToDelete.push(row.id);
      continue;
    }
    const previous = compactedRows[compactedRows.length - 1];
    if (previous?.role === "assistant" && row.role === "assistant") {
      const previousText = assistantDisplayText(previous.content);
      const rowText = assistantDisplayText(row.content);
      if (areDuplicateAssistantDisplays(previousText, rowText)) {
        if (historyContentScore(row.content) > historyContentScore(previous.content)) {
          idsToDelete.push(previous.id);
          compactedRows[compactedRows.length - 1] = row;
        } else {
          idsToDelete.push(row.id);
        }
        continue;
      }
    }
    compactedRows.push(row);
  }
  if (!idsToDelete.length) return;
  const remove = db.prepare("DELETE FROM local_ai_messages WHERE rowid = ?");
  const compact = db.transaction(() => {
    for (const id of [...new Set(idsToDelete)]) remove.run(id);
  });
  compact();
}

function areDuplicateAssistantDisplays(left: string, right: string): boolean {
  const a = normalizeAssistantDisplayText(left);
  const b = normalizeAssistantDisplayText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 80 && longer.startsWith(shorter)) return true;
  if (shorter.length < 160) return false;
  return commonPrefixLength(shorter, longer) / shorter.length >= 0.86;
}

function normalizeAssistantDisplayText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function assistantDisplayText(content: string): string {
  if (!content.startsWith(STRUCTURED_MESSAGE_PREFIX)) return content.trim();
  try {
    const parsed = JSON.parse(content.slice(STRUCTURED_MESSAGE_PREFIX.length));
    if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
      const record = parsed as { text: string; segments?: unknown };
      const segments = Array.isArray(record.segments)
        ? record.segments as Array<{ type?: string; stepId?: string; text?: string }>
        : [];
      return stripProcessTextFromFinalText(record.text, segments);
    }
  } catch {
    return content.trim();
  }
  return content.trim();
}

function stripProcessTextFromFinalText(
  text: string,
  sourceSegments: Array<{ type?: string; stepId?: string; text?: string }>
): string {
  let cleaned = text.trim();
  if (!cleaned) return cleaned;
  for (const segment of sourceSegments) {
    if (!isProcessTextSegment(segment)) continue;
    cleaned = removeTextBlock(cleaned, segment.text ?? "");
    if (!cleaned) break;
  }
  return cleaned.trim();
}

function isProcessTextSegment(segment: { type?: string; stepId?: string }) {
  return segment.type === "text" && Boolean(segment.stepId && /^(?:process-text|thought|commentary)-/.test(segment.stepId));
}

function removeTextBlock(text: string, block: string) {
  const target = block.trim();
  let source = text.trim();
  if (!target || !source) return source;
  if (source === target) return "";
  if (source.startsWith(target)) return source.slice(target.length).trimStart();
  const surrounded = `\n\n${target}\n\n`;
  const index = source.indexOf(surrounded);
  if (index >= 0) {
    source = `${source.slice(0, index)}\n\n${source.slice(index + surrounded.length)}`;
  }
  return source.trim();
}

function historyContentScore(content: string): number {
  // 移除 final-summary 评分加成，所有状态都绑定到具体步骤
  let score = content.length;
  if (content.includes("\"stepId\":\"mobile-run-started\"")) score -= 1_000;
  return score;
}

export function listLocalAiHistory(aiSessionId: string): AiHistoryMessage[] {
  compactLocalAiHistory(aiSessionId);
  writeLocalAiSessionLog(aiSessionId);
  const rows = db
    .prepare(
      "SELECT * FROM local_ai_messages WHERE ai_session_id = ? ORDER BY datetime(created_at) ASC, id ASC"
    )
    .all(aiSessionId) as MessageRow[];
  return rows.map(rowToMessage);
}
