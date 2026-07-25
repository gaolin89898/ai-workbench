import { randomUUID } from "node:crypto";
import type { ProviderSessionCatalogEntry } from "../services/desktop";
import * as db from "./db";
import { listCodexThreads } from "./codex_admin";

type Sender = {
  send: (channel: string, ...args: unknown[]) => void;
  isDestroyed?: () => boolean;
};

function codexThreadId(providerSessionId?: string | null): string | null {
  const value = providerSessionId?.trim();
  if (!value) return null;
  return value.startsWith("app-server:") ? value.slice("app-server:".length) : value;
}

async function listAllCodexThreads(archived: boolean, sender?: Sender) {
  const threads = [];
  let cursor: string | null = null;
  do {
    const response = await listCodexThreads({ cursor, limit: 100, archived, cwd: null }, sender);
    threads.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor && threads.length < 10_000);
  return threads;
}

export async function listProviderSessions(sender?: Sender): Promise<ProviderSessionCatalogEntry[]> {
  const localSessions = db.listLocalAiSessions();
  const catalog = new Map<string, ProviderSessionCatalogEntry>();
  const linkedCodexThreads = new Map<string, string>();

  for (const session of localSessions) {
    const providerSessionId = session.providerSessionId?.trim() || null;
    const key = providerSessionId ? `${session.providerId}:${providerSessionId}` : `workbench:${session.id}`;
    catalog.set(key, {
      key,
      providerId: session.providerId,
      providerSessionId,
      title: session.title,
      cwd: session.summary || null,
      updatedAt: session.updatedAt || null,
      archived: Boolean(session.archivedAt),
      source: "workbench",
      sourceApp: "codehub",
      linkedAiSessionId: session.id,
      capabilities: { read: true, resume: true, rename: true, archive: true, delete: true },
    });
    if (session.providerId === "codex") {
      const threadId = codexThreadId(providerSessionId);
      if (threadId) linkedCodexThreads.set(threadId, key);
    }
  }

  try {
    const [activeThreads, archivedThreads] = await Promise.all([
      listAllCodexThreads(false, sender),
      listAllCodexThreads(true, sender),
    ]);
    for (const thread of [...activeThreads, ...archivedThreads]) {
      const linkedKey = linkedCodexThreads.get(thread.id);
      if (linkedKey) {
        const linked = catalog.get(linkedKey);
        if (linked) {
          linked.cwd = thread.cwd || linked.cwd;
          linked.updatedAt = new Date(thread.updatedAt * 1000).toISOString();
          linked.archived = thread.archived;
          linked.sourceApp = "codehub";
        }
        continue;
      }
      const key = `codex:${thread.id}`;
      catalog.set(key, {
        key,
        providerId: "codex",
        providerSessionId: thread.id,
        title: thread.name?.trim() || thread.preview.trim().split(/\r?\n/)[0] || "未命名会话",
        cwd: thread.cwd || null,
        updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
        archived: thread.archived,
        source: "provider-api",
        sourceApp: thread.originator === "CodeHub AI"
          ? "codehub"
          : thread.originator === "Codex Desktop"
            ? "desktop"
            : thread.source === "vscode"
              ? "vscode"
              : thread.source === "cli"
                ? "cli"
                : "unknown",
        linkedAiSessionId: null,
        capabilities: { read: true, resume: true, rename: true, archive: true, delete: true },
      });
    }
  } catch {
  }

  return [...catalog.values()].sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
}

export function attachProviderSession(entry: ProviderSessionCatalogEntry) {
  if (entry.linkedAiSessionId) return db.getLocalAiSession(entry.linkedAiSessionId);
  if (!entry.providerSessionId || !entry.capabilities.resume) throw new Error("该原生会话暂不支持继续");
  const existing = db.listLocalAiSessions().find((session) => (
    session.providerId === entry.providerId
    && codexThreadId(session.providerSessionId) === codexThreadId(entry.providerSessionId)
  ));
  if (existing) return existing;
  return db.createLocalAiSession({
    id: randomUUID(),
    providerId: entry.providerId,
    providerSessionId: entry.providerId === "codex" ? `app-server:${entry.providerSessionId}` : entry.providerSessionId,
    title: entry.title || "未命名会话",
    status: "idle",
    summary: entry.cwd,
    updatedAt: entry.updatedAt,
  });
}
