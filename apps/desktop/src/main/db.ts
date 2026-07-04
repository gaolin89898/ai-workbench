// SQLite module for the Electron main process.
// Singletons: the DB is opened once at module load and reused by all helpers.
// Schema mirrors the original Rust local-store implementation.

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { readGitStatus } from "./projects";
import type {
  AiSession,
  WorkspaceProject,
  AiHistoryMessage,
  ChatMessage,
  AiProviderTrace,
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
    archived_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ai_session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
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
  archived_at: string | null;
  updated_at: string;
}

interface MessageRow {
  id: number;
  ai_session_id: string;
  role: string;
  content: string;
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
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): AiHistoryMessage {
  return {
    role: row.role as AiHistoryMessage["role"],
    content: row.content,
    createdAt: row.created_at,
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
  updatedAt?: string | null;
}): AiSession {
  const now = params.updatedAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO local_ai_sessions
      (id, provider_id, terminal_session_id, provider_session_id, title, status, summary, archived_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    params.id,
    params.providerId,
    params.terminalSessionId ?? null,
    params.providerSessionId ?? null,
    params.title,
    params.status,
    params.summary ?? null,
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
  const row = db.prepare(
    "SELECT * FROM local_ai_traces WHERE ai_session_id = ? AND trace_kind = ?"
  ).get(aiSessionId, traceKind) as TraceRow | undefined;
  return row ? rowToTrace(row, includeRawEvents) : null;
}

// ---------- AI messages ----------

export function appendLocalAiMessage(
  aiSessionId: string,
  role: ChatMessage["role"],
  content: string
): void {
  if (role === "assistant") {
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
        }
        return;
      }
    }
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO local_ai_messages (ai_session_id, role, content, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(aiSessionId, role, content, now);
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
  const rows = db
    .prepare(
      "SELECT * FROM local_ai_messages WHERE ai_session_id = ? ORDER BY datetime(created_at) ASC, id ASC"
    )
    .all(aiSessionId) as MessageRow[];
  return rows.map(rowToMessage);
}
