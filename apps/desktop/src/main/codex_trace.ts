import type { ChatSegment, CodexTraceItem, CodexTraceSnapshot } from "../services/desktop";

export type CodexRawTraceEvent = {
  method: string;
  params: unknown;
  receivedAt: string;
};

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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = str(value);
    if (text) return text;
  }
  return undefined;
}

function extractItemId(params: unknown): string {
  const p = record(params);
  const item = record(p.item);
  return firstString(p.itemId, p.item_id, p.id, item.id) ?? `trace-item-${Date.now()}`;
}

function extractThreadId(params: unknown): string | null {
  const p = record(params);
  const thread = record(p.thread);
  return firstString(p.threadId, p.thread_id, p.id, thread.id) ?? null;
}

function extractTurnId(params: unknown): string | null {
  const p = record(params);
  const turn = record(p.turn);
  return firstString(p.turnId, p.turn_id, p.id, turn.id) ?? null;
}

function extractDelta(params: unknown): string {
  const p = record(params);
  return firstString(p.delta, p.text, p.content, p.output, p.chunk) ?? "";
}

function extractTurnFinalText(params: unknown): string {
  const p = record(params);
  const turn = record(p.turn);
  const response = record(p.response);
  const message = record(p.message);
  return firstString(
    p.last_agent_message,
    p.final_message,
    p.finalText,
    p.final_text,
    p.output_text,
    turn.last_agent_message,
    turn.final_message,
    response.output_text,
    response.text,
    message.text,
  ) ?? "";
}

function extractErrorMessage(params: unknown): string {
  const p = record(params);
  const error = record(p.error);
  return firstString(p.message, error.message, p.error) ?? "未知错误";
}

function fileChangesFrom(value: unknown): string[] {
  const changes = record(value);
  return Object.keys(changes).filter((path) => path.trim().length > 0);
}

function extractFilePath(item: Record<string, unknown>, parent: Record<string, unknown>): string | null {
  const direct = firstString(
    item.path,
    item.filePath,
    item.file_path,
    item.filename,
    parent.path,
    parent.filePath,
    parent.file_path,
    parent.filename,
  );
  if (direct) return direct;
  const changes = fileChangesFrom(item.fileChanges ?? parent.fileChanges ?? item.changes ?? parent.changes);
  return changes[0] ?? null;
}

function diffFromFileChangeValue(path: string, value: unknown): string {
  if (typeof value === "string") return value;
  const change = record(value);
  const diff = firstString(change.diff, change.patch, change.changes, change.change, change.content);
  if (!diff) return "";
  if (/^(diff --git|\*\*\* (?:Add|Update|Delete) File: |\+\+\+ |--- )/m.test(diff)) return diff;
  return `*** Update File: ${path}\n${diff}`;
}

function extractDiff(item: Record<string, unknown>, parent: Record<string, unknown>): string | null {
  const direct = firstString(
    item.diff,
    item.patch,
    item.changes,
    item.change,
    item.output,
    item.result,
    parent.diff,
    parent.patch,
    parent.changes,
    parent.change,
  );
  if (direct && /(^|\n)(diff --git|@@\s|---\s|\+\+\+\s|[+-][^\n]*)/.test(direct)) return direct;
  const changes = record(item.fileChanges ?? parent.fileChanges ?? item.changes ?? parent.changes);
  const diffs = Object.entries(changes)
    .map(([path, value]) => diffFromFileChangeValue(path, value))
    .filter(Boolean);
  return diffs.length ? diffs.join("\n") : null;
}

function traceItemType(rawType: string): CodexTraceItem["type"] {
  switch (rawType) {
    case "reasoning":
      return "thinking";
    case "agentMessage":
      return "agent_message";
    case "commandExecution":
      return "command";
    case "fileEdit":
    case "file_edit":
    case "fileChange":
    case "file_change":
      return "tool";
    default:
      return "status";
  }
}

function traceItemTitle(rawType: string, item: Record<string, unknown>, parent: Record<string, unknown>) {
  switch (traceItemType(rawType)) {
    case "thinking":
      return "正在思考";
    case "agent_message":
      return "执行过程";
    case "command":
      return "正在运行命令";
    case "tool":
      return "正在修改文件";
    default:
      return `执行 ${rawType || "任务"}`;
  }
}

function snapshotBase(now: string): CodexTraceSnapshot {
  return {
    provider: "codex",
    status: "idle",
    threadId: null,
    turnId: null,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    items: [],
    approvals: [],
    errors: [],
    finalText: "",
  };
}

function upsertItem(snapshot: CodexTraceSnapshot, item: CodexTraceItem): CodexTraceSnapshot {
  const index = snapshot.items.findIndex((entry) => entry.id === item.id);
  const items = [...snapshot.items];
  if (index < 0) {
    items.push(item);
  } else {
    items[index] = { ...items[index], ...item };
  }
  return { ...snapshot, items };
}

function itemFromParams(params: unknown, receivedAt: string): CodexTraceItem {
  const p = record(params);
  const item = record(p.item ?? p);
  const rawType = firstString(item.type, p.type) ?? "unknown";
  const id = extractItemId(params);
  const command = firstString(item.command, item.commandText, p.command, p.commandText) ?? extractFilePath(item, p);
  const output = firstString(item.output, item.result, p.output, p.result) ?? null;
  const diff = extractDiff(item, p);
  return {
    id,
    type: traceItemType(rawType),
    title: traceItemTitle(rawType, item, p),
    status: "running",
    text: "",
    startedAt: receivedAt,
    completedAt: null,
    rawItemType: rawType,
    command: command ?? null,
    output,
    diff,
    additions: num(item.additions ?? p.additions) ?? null,
    deletions: num(item.deletions ?? p.deletions) ?? null,
  };
}

export function reduceCodexTraceSnapshot(
  previous: CodexTraceSnapshot | null | undefined,
  event: CodexRawTraceEvent,
): CodexTraceSnapshot {
  const now = event.receivedAt;
  let snapshot = previous ?? snapshotBase(now);
  snapshot = { ...snapshot, updatedAt: now };

  switch (event.method) {
    case "thread/started": {
      snapshot = { ...snapshot, threadId: extractThreadId(event.params) ?? snapshot.threadId };
      break;
    }
    case "turn/started": {
      snapshot = {
        ...snapshot,
        status: "running",
        turnId: extractTurnId(event.params) ?? snapshot.turnId,
        startedAt: snapshot.startedAt ?? now,
        completedAt: null,
        finalText: "",
        errors: [],
      };
      break;
    }
    case "item/started": {
      snapshot = upsertItem(snapshot, itemFromParams(event.params, now));
      break;
    }
    case "item/agentMessage/delta": {
      const id = extractItemId(event.params);
      const delta = extractDelta(event.params);
      const current = snapshot.items.find((item) => item.id === id);
      const item: CodexTraceItem = {
        ...(current ?? {
          id,
          type: "agent_message" as const,
          title: "执行过程",
          status: "running" as const,
          text: "",
          startedAt: now,
          completedAt: null,
          rawItemType: "agentMessage",
        }),
        text: `${current?.text ?? ""}${delta}`,
      };
      snapshot = upsertItem(snapshot, item);
      break;
    }
    case "item/commandExecution/outputDelta": {
      const id = extractItemId(event.params);
      const delta = extractDelta(event.params);
      const current = snapshot.items.find((item) => item.id === id);
      const item: CodexTraceItem = {
        ...(current ?? {
          id,
          type: "command" as const,
          title: "正在运行命令",
          status: "running" as const,
          text: "",
          startedAt: now,
          completedAt: null,
          rawItemType: "commandExecution",
        }),
        output: `${current?.output ?? ""}${delta}`,
      };
      snapshot = upsertItem(snapshot, item);
      break;
    }
    case "item/completed": {
      const completed = itemFromParams(event.params, now);
      const current = snapshot.items.find((item) => item.id === completed.id);
      snapshot = upsertItem(snapshot, {
        ...(current ?? completed),
        ...completed,
        text: completed.text || current?.text || "",
        output: completed.output || current?.output || null,
        status: "completed",
        completedAt: now,
      });
      break;
    }
    case "approval/requested": {
      const p = record(event.params);
      const id = firstString(p.approvalId, p.id) ?? `approval-${Date.now()}`;
      const kind = p.approvalKind === "fileChange" ? "fileChange" : "command";
      const title = kind === "fileChange" ? "需要同意后修改文件" : "需要同意后执行命令";
      const approval = {
        id,
        kind,
        status: "pending" as const,
        title,
        command: firstString(p.command) ?? null,
        cwd: firstString(p.cwd) ?? null,
        fileChanges: Array.isArray(p.fileChanges) ? p.fileChanges.filter((item): item is string => typeof item === "string") : [],
        detail: firstString(p.detail, p.reason) ?? null,
      };
      snapshot = {
        ...snapshot,
        approvals: [...snapshot.approvals.filter((entry) => entry.id !== id), approval],
        items: [
          ...snapshot.items.filter((entry) => entry.id !== `approval-${id}`),
          {
            id: `approval-${id}`,
            type: "approval",
            title,
            status: "running",
            text: approval.detail ?? "",
            startedAt: now,
            completedAt: null,
            rawItemType: "approval",
            command: approval.command,
          },
        ],
      };
      break;
    }
    case "approval/resolved": {
      const p = record(event.params);
      const id = firstString(p.approvalId, p.id) ?? "";
      const status = p.status === "approved" ? "approved"
        : p.status === "denied" ? "denied"
        : p.status === "failed" ? "failed"
        : "expired";
      snapshot = {
        ...snapshot,
        approvals: snapshot.approvals.map((approval) => approval.id === id ? { ...approval, status } : approval),
        items: snapshot.items.map((item) => item.id === `approval-${id}` ? {
          ...item,
          status: status === "approved" ? "completed" : "failed",
          completedAt: now,
        } : item),
      };
      break;
    }
    case "turn/completed": {
      const finalText = extractTurnFinalText(event.params);
      snapshot = {
        ...snapshot,
        status: "completed",
        completedAt: now,
        finalText: finalText || snapshot.finalText,
        items: snapshot.items.map((item) => item.status === "running" ? { ...item, status: "completed", completedAt: item.completedAt ?? now } : item),
      };
      break;
    }
    case "error": {
      const message = extractErrorMessage(event.params);
      snapshot = {
        ...snapshot,
        status: "failed",
        errors: [...snapshot.errors, { message, at: now }],
        items: [
          ...snapshot.items,
          {
            id: `error-${snapshot.errors.length + 1}`,
            type: "error",
            title: "执行失败",
            status: "failed",
            text: message,
            startedAt: now,
            completedAt: now,
            rawItemType: "error",
          },
        ],
      };
      break;
    }
  }

  return snapshot;
}

function traceStatusToToolStatus(status: CodexTraceItem["status"]): Extract<ChatSegment, { type: "tool" }>["status"] {
  if (status === "running") return "running";
  if (status === "failed" || status === "canceled") return "error";
  return "success";
}

export function codexTraceSnapshotToSegments(snapshot: CodexTraceSnapshot): ChatSegment[] {
  const segments: ChatSegment[] = [];
  if (snapshot.status === "running") {
    segments.push({
      type: "status",
      stepId: "runtime-status",
      label: "Codex 正在执行",
      icon: "think",
    });
  }

  for (const item of snapshot.items) {
    if (item.type === "agent_message") {
      if (item.text.trim()) {
        segments.push({
          type: "text",
          stepId: `process-text-${item.id}`,
          text: item.text,
        });
      }
      continue;
    }
    if (item.type === "thinking") {
      segments.push({
        type: "status",
        stepId: item.id,
        label: item.status === "running" ? "正在思考" : "已思考",
        icon: "think",
      });
      continue;
    }
    if (item.type === "command") {
      segments.push({
        type: "tool",
        stepId: item.id,
        toolName: "命令",
        command: item.command ?? undefined,
        status: traceStatusToToolStatus(item.status),
        output: item.output ?? undefined,
      });
      continue;
    }
    if (item.type === "tool") {
      segments.push({
        type: "tool",
        stepId: item.id,
        toolName: item.title.includes("文件") ? "修改文件" : item.title,
        command: item.command ?? undefined,
        status: traceStatusToToolStatus(item.status),
        summary: item.text || undefined,
        output: item.output ?? undefined,
        diff: item.diff ?? undefined,
        additions: item.additions ?? undefined,
        deletions: item.deletions ?? undefined,
      });
      continue;
    }
    if (item.type === "approval") {
      const approval = snapshot.approvals.find((entry) => `approval-${entry.id}` === item.id);
      segments.push({
        type: "approval",
        stepId: item.id,
        approvalId: approval?.id ?? item.id,
        approvalKind: approval?.kind ?? "command",
        status: approval?.status ?? (item.status === "running" ? "pending" : "expired"),
        title: approval?.title ?? item.title,
        command: item.command ?? approval?.command ?? undefined,
        cwd: approval?.cwd ?? undefined,
        fileChanges: approval?.fileChanges ?? [],
        detail: approval?.detail ?? item.text,
      });
      continue;
    }
    if (item.type === "error") {
      segments.push({
        type: "error",
        stepId: item.id,
        title: item.title,
        message: item.text || "执行失败",
      });
      continue;
    }
    segments.push({
      type: "status",
      stepId: item.id,
      label: item.title,
      icon: item.status === "failed" ? "warn" : "think",
    });
  }

  if (snapshot.status === "completed" && snapshot.startedAt && snapshot.completedAt) {
    const durationMs = Math.max(0, Date.parse(snapshot.completedAt) - Date.parse(snapshot.startedAt));
    segments.push({
      type: "status",
      stepId: "final-summary",
      label: "已处理",
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    });
  }

  return segments;
}
