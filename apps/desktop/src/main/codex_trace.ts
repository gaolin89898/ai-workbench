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

function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function extractAgentMessagePhase(item: Record<string, unknown>, parent: Record<string, unknown>): string | null {
  return firstString(item.phase, parent.phase) ?? null;
}

function isFinalAnswerPhase(phase: string | null | undefined): boolean {
  return phase === "final_answer" || phase === "finalAnswer" || phase === "final";
}

function extractErrorMessage(params: unknown): string {
  const p = record(params);
  const error = record(p.error);
  return firstString(p.message, error.message, p.error) ?? "未知错误";
}

function normalizePlanStatus(value: unknown): "pending" | "in_progress" | "completed" {
  if (value === "in_progress" || value === "inProgress" || value === "running") return "in_progress";
  if (value === "completed" || value === "complete" || value === "done") return "completed";
  return "pending";
}

function extractPlanSteps(params: unknown): Array<{ step: string; status: "pending" | "in_progress" | "completed" }> {
  const p = record(params);
  const plan = Array.isArray(p.plan) ? p.plan : [];
  return plan.flatMap((entry) => {
    const item = record(entry);
    const step = firstString(item.step, item.title, item.text, item.description);
    return step ? [{ step, status: normalizePlanStatus(item.status) }] : [];
  });
}

function extractGoal(params: unknown): {
  objective: string;
  status?: string | null;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
} | null {
  const p = record(params);
  const goal = record(p.goal);
  const objective = firstString(goal.objective, p.objective);
  if (!objective) return null;
  return {
    objective,
    status: firstString(goal.status, p.status) ?? null,
    tokenBudget: num(goal.tokenBudget ?? p.tokenBudget) ?? null,
    tokensUsed: num(goal.tokensUsed ?? p.tokensUsed) ?? 0,
    timeUsedSeconds: num(goal.timeUsedSeconds ?? p.timeUsedSeconds) ?? 0,
  };
}

export function isCodexReconnectMessage(message: string): boolean {
  return /^Reconnecting(?:\.\.\.)?\s+\d+\/\d+$/i.test(message.trim());
}

function fileChangeEntries(value: unknown): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const change = record(entry);
      const path = firstString(change.path, change.filePath, change.file_path, change.filename);
      return path ? [{ path, value: change }] : [];
    });
  }
  const changes = record(value);
  const directPath = firstString(changes.path, changes.filePath, changes.file_path, changes.filename);
  if (directPath) return [{ path: directPath, value: changes }];
  return Object.entries(changes)
    .filter(([path]) => path.trim().length > 0)
    .map(([path, entry]) => ({ path, value: entry }));
}

function fileChangesFrom(value: unknown): string[] {
  return fileChangeEntries(value).map((entry) => entry.path);
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
  const changes = item.fileChanges ?? parent.fileChanges ?? item.changes ?? parent.changes;
  const diffs = fileChangeEntries(changes)
    .map(({ path, value }) => diffFromFileChangeValue(path, value))
    .filter(Boolean);
  return diffs.length ? diffs.join("\n") : null;
}

function traceItemType(rawType: string): CodexTraceItem["type"] {
  switch (rawType) {
    case "reasoning":
      return "thinking";
    case "agentMessage":
    case "plan":
      return "agent_message";
    case "commandExecution":
      return "command";
    case "fileEdit":
    case "file_edit":
    case "fileChange":
    case "file_change":
    case "mcpToolCall":
    case "mcp_tool_call":
    case "dynamicToolCall":
    case "dynamic_tool_call":
      return "tool";
    default:
      return "status";
  }
}

function isMcpToolCallRawType(rawType: string): boolean {
  return /^(?:mcpToolCall|mcp_tool_call)$/i.test(rawType);
}

function isDynamicToolCallRawType(rawType: string): boolean {
  return /^(?:dynamicToolCall|dynamic_tool_call)$/i.test(rawType);
}

function traceItemStatus(
  item: Record<string, unknown>,
  parent: Record<string, unknown>,
): CodexTraceItem["status"] {
  const status = firstString(item.status, parent.status);
  if (status === "failed" || status === "error") return "failed";
  if (status === "canceled" || status === "cancelled" || status === "interrupted") return "canceled";
  if (status === "completed" || status === "success" || status === "succeeded") return "completed";
  if ((item.success ?? parent.success) === false) return "failed";
  if ((item.success ?? parent.success) === true) return "completed";
  return "running";
}

function extractToolName(
  rawType: string,
  item: Record<string, unknown>,
  parent: Record<string, unknown>,
): string | null {
  const tool = firstString(item.tool, item.toolName, parent.tool, parent.toolName);
  if (!tool) return null;
  if (isMcpToolCallRawType(rawType)) {
    const server = firstString(item.server, parent.server);
    return server ? `${server} / ${tool}` : tool;
  }
  if (isDynamicToolCallRawType(rawType)) {
    const namespace = firstString(item.namespace, parent.namespace);
    return namespace ? `${namespace} / ${tool}` : tool;
  }
  return tool;
}

function toolResultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = record(value);
  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null) return jsonText(structured);
  const content = result.content;
  if (Array.isArray(content)) {
    const textParts = content.flatMap((entry) => {
      const part = record(entry);
      const text = firstString(part.text, part.content, part.value);
      return text ? [text] : [];
    });
    if (textParts.length === content.length && textParts.length > 0) return textParts.join("\n");
  }
  return jsonText(value);
}

function isInternalUserMessageRawType(rawType: string | null | undefined): boolean {
  return /^(?:userMessage|user_message)$/i.test(rawType ?? "");
}

function isNoisyTraceRawType(rawType: string | null | undefined): boolean {
  return /^(?:webSearch|web_search)$/i.test(rawType ?? "");
}

function traceItemTitle(rawType: string, item: Record<string, unknown>, parent: Record<string, unknown>) {
  if (/^(?:contextCompaction|context_compaction)$/i.test(rawType)) return "正在压缩上下文";
  const toolName = extractToolName(rawType, item, parent);
  if (isMcpToolCallRawType(rawType)) return toolName ? `MCP ${toolName}` : "MCP 工具调用";
  if (isDynamicToolCallRawType(rawType)) return toolName ?? "动态工具调用";
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

function expirePendingApprovals(snapshot: CodexTraceSnapshot, now: string): CodexTraceSnapshot {
  const approvals = snapshot.approvals.map((approval) =>
    approval.status === "pending" ? { ...approval, status: "expired" as const } : approval
  );
  const items = snapshot.items.map((item) => (
    item.type === "approval" && item.status === "running"
      ? { ...item, status: "failed" as const, completedAt: item.completedAt ?? now }
      : item
  ));
  return { ...snapshot, approvals, items };
}

function itemFromParams(params: unknown, receivedAt: string): CodexTraceItem {
  const p = record(params);
  const item = record(p.item ?? p);
  const rawType = firstString(item.type, p.type) ?? "unknown";
  const id = extractItemId(params);
  const toolCall = isMcpToolCallRawType(rawType) || isDynamicToolCallRawType(rawType);
  const error = firstString(record(item.error).message, record(p.error).message, item.error, p.error) ?? null;
  const command = firstString(item.command, item.commandText, p.command, p.commandText) ?? extractFilePath(item, p);
  const text = error ?? firstString(item.text, item.summary, item.message, item.detail, p.text, p.summary, p.message, p.detail) ?? "";
  const output = toolCall
    ? toolResultText(item.result ?? item.contentItems ?? p.result ?? p.contentItems) ?? null
    : firstString(item.output, item.result, p.output, p.result) ?? null;
  // Plan items are assistant-facing output. Treat them as a final message so
  // plan-only turns remain visible even when no agentMessage item is emitted.
  const phase = rawType === "plan" ? "final" : extractAgentMessagePhase(item, p);
  const diff = extractDiff(item, p);
  return {
    id,
    type: traceItemType(rawType),
    title: traceItemTitle(rawType, item, p),
    status: traceItemStatus(item, p),
    text,
    startedAt: receivedAt,
    completedAt: null,
    rawItemType: rawType,
    phase,
    toolName: extractToolName(rawType, item, p),
    command: command ?? null,
    input: toolCall ? jsonText(item.arguments ?? p.arguments) ?? null : null,
    output,
    error,
    diff,
    durationMs: num(item.durationMs ?? p.durationMs) ?? null,
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
    case "thread/goal/updated": {
      const goal = extractGoal(event.params);
      if (goal) {
        snapshot = {
          ...snapshot,
          goal: {
            ...goal,
            updatedAt: now,
          },
        };
      }
      break;
    }
    case "thread/goal/cleared": {
      snapshot = { ...snapshot, goal: null };
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
    case "turn/plan/updated": {
      const p = record(event.params);
      const steps = extractPlanSteps(event.params);
      if (steps.length) {
        snapshot = {
          ...snapshot,
          plan: {
            turnId: extractTurnId(event.params) ?? snapshot.turnId,
            explanation: firstString(p.explanation),
            steps,
            updatedAt: now,
          },
        };
      }
      break;
    }
    case "item/started": {
      const item = itemFromParams(event.params, now);
      if (!isInternalUserMessageRawType(item.rawItemType) && !isNoisyTraceRawType(item.rawItemType)) {
        snapshot = upsertItem(snapshot, item);
      }
      break;
    }
    case "item/agentMessage/delta": {
      const id = extractItemId(event.params);
      const delta = extractDelta(event.params);
      const p = record(event.params);
      const payloadItem = record(p.item);
      const phase = extractAgentMessagePhase(payloadItem, p);
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
          phase,
        }),
        phase: phase ?? current?.phase ?? null,
        text: `${current?.text ?? ""}${delta}`,
      };
      snapshot = upsertItem(snapshot, item);
      break;
    }
    case "item/plan/delta": {
      const id = extractItemId(event.params);
      const delta = extractDelta(event.params);
      const current = snapshot.items.find((item) => item.id === id);
      const content = `${snapshot.plan?.content ?? current?.text ?? ""}${delta}`;
      const item: CodexTraceItem = {
        ...(current ?? {
          id,
          type: "agent_message" as const,
          title: "执行计划",
          status: "running" as const,
          text: "",
          startedAt: now,
          completedAt: null,
          rawItemType: "plan",
          phase: "final",
        }),
        phase: "final",
        text: content,
      };
      snapshot = upsertItem(snapshot, item);
      snapshot = {
        ...snapshot,
        plan: {
          turnId: extractTurnId(event.params) ?? snapshot.turnId,
          explanation: "执行计划",
          content,
          steps: snapshot.plan?.steps ?? [],
          updatedAt: now,
        },
      };
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
    case "item/mcpToolCall/progress": {
      const id = extractItemId(event.params);
      const p = record(event.params);
      const current = snapshot.items.find((item) => item.id === id);
      const item: CodexTraceItem = {
        ...(current ?? {
          id,
          type: "tool" as const,
          title: "MCP 工具调用",
          status: "running" as const,
          text: "",
          startedAt: now,
          completedAt: null,
          rawItemType: "mcpToolCall",
          toolName: "MCP 工具",
        }),
        status: "running",
        text: firstString(p.message) ?? current?.text ?? "",
      };
      snapshot = upsertItem(snapshot, item);
      break;
    }
    case "item/completed": {
      const completed = itemFromParams(event.params, now);
      if (isInternalUserMessageRawType(completed.rawItemType)) break;
      if (isNoisyTraceRawType(completed.rawItemType)) break;
      const current = snapshot.items.find((item) => item.id === completed.id);
      const completedItem = {
        ...(current ?? completed),
        ...completed,
        text: completed.text || current?.text || "",
        output: completed.output || current?.output || null,
        input: completed.input ?? current?.input ?? null,
        command: completed.command ?? current?.command ?? null,
        diff: completed.diff ?? current?.diff ?? null,
        toolName: completed.toolName ?? current?.toolName ?? null,
        error: completed.error ?? current?.error ?? null,
        durationMs: completed.durationMs ?? current?.durationMs ?? null,
        additions: completed.additions ?? current?.additions ?? null,
        deletions: completed.deletions ?? current?.deletions ?? null,
        phase: completed.phase ?? current?.phase ?? null,
        status: completed.status === "running" ? "completed" as const : completed.status,
        completedAt: now,
      };
      snapshot = upsertItem(snapshot, completedItem);
      if (completedItem.type === "agent_message" && isFinalAnswerPhase(completedItem.phase) && completedItem.text.trim()) {
        snapshot = { ...snapshot, finalText: completedItem.text.trim() };
      }
      if (completedItem.rawItemType === "plan" && completedItem.text.trim()) {
        snapshot = {
          ...snapshot,
          plan: {
            turnId: extractTurnId(event.params) ?? snapshot.turnId,
            explanation: "执行计划",
            content: completedItem.text.trim(),
            steps: snapshot.plan?.steps ?? [],
            updatedAt: now,
          },
        };
      }
      break;
    }
    case "approval/requested": {
      const p = record(event.params);
      const id = firstString(p.approvalId, p.id) ?? `approval-${Date.now()}`;
      const kind: "fileChange" | "command" | "permissions" = p.approvalKind === "permissions"
        ? "permissions"
        : p.approvalKind === "fileChange" ? "fileChange" : "command";
      const title = kind === "permissions" ? "需要同意额外权限" : kind === "fileChange" ? "需要同意后修改文件" : "需要同意后执行命令";
      const approval = {
        id,
        kind,
        status: "pending" as const,
        title,
        command: firstString(p.command) ?? null,
        cwd: firstString(p.cwd) ?? null,
        fileChanges: Array.isArray(p.fileChanges) ? p.fileChanges.filter((item): item is string => typeof item === "string") : [],
        requestedPermissions: p.requestedPermissions && typeof p.requestedPermissions === "object" ? p.requestedPermissions : undefined,
        permissionScope: p.permissionScope === "session" ? "session" as const : p.permissionScope === "turn" ? "turn" as const : undefined,
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
      const p = record(event.params);
      const turn = record(p.turn);
      const turnStatus = firstString(turn.status, p.status);
      const status = turnStatus === "interrupted" ? "canceled"
        : turnStatus === "failed" ? "failed"
        : "completed";
      snapshot = {
        ...snapshot,
        status,
        completedAt: now,
        items: snapshot.items.map((item) => item.status === "running" ? {
          ...item,
          status: status === "canceled" ? "canceled" : status === "failed" ? "failed" : "completed",
          completedAt: item.completedAt ?? now,
        } : item),
      };
      // Some app-server versions complete a plan-only turn without emitting
      // item/completed. Keep the accumulated plan deltas as the response.
      if (!snapshot.finalText.trim()) {
        const planText = snapshot.items
          .find((item) => item.rawItemType === "plan" && item.text.trim())
          ?.text.trim();
        if (planText) snapshot = { ...snapshot, finalText: planText };
      }
      snapshot = expirePendingApprovals(snapshot, now);
      break;
    }
    case "error": {
      const message = extractErrorMessage(event.params);
      if (isCodexReconnectMessage(message)) break;
      snapshot = {
        ...snapshot,
        status: "failed",
        completedAt: now,
        errors: [...snapshot.errors, { message, at: now }],
        items: [
          ...snapshot.items.map((item) => item.status === "running" ? {
            ...item,
            status: "failed" as const,
            completedAt: item.completedAt ?? now,
          } : item),
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
      snapshot = expirePendingApprovals(snapshot, now);
      break;
    }
  }

  return snapshot;
}

export function replayCodexTraceEvents(events: unknown[]): CodexTraceSnapshot | null {
  let snapshot: CodexTraceSnapshot | null = null;
  for (const value of events) {
    const event = record(value);
    const method = firstString(event.method);
    const receivedAt = firstString(event.receivedAt);
    if (!method || !receivedAt) continue;
    snapshot = reduceCodexTraceSnapshot(snapshot, {
      method,
      params: event.params,
      receivedAt,
    });
  }
  return snapshot;
}

function traceStatusToToolStatus(status: CodexTraceItem["status"]): Extract<ChatSegment, { type: "tool" }>["status"] {
  if (status === "running") return "running";
  if (status === "failed" || status === "canceled") return "error";
  return "success";
}

function itemDurationMs(item: CodexTraceItem, fallbackEndAt: string | null | undefined): number | undefined {
  if (typeof item.durationMs === "number" && Number.isFinite(item.durationMs)) {
    return Math.max(0, item.durationMs);
  }
  if (!item.startedAt) return undefined;
  const startedAt = Date.parse(item.startedAt);
  const endAt = Date.parse(item.completedAt ?? fallbackEndAt ?? new Date().toISOString());
  if (!Number.isFinite(startedAt) || !Number.isFinite(endAt)) return undefined;
  return Math.max(0, endAt - startedAt);
}

export function codexTraceSnapshotToSegments(snapshot: CodexTraceSnapshot): ChatSegment[] {
  const segments: ChatSegment[] = [];
  const providerName = ({
    codex: "Codex",
    claude: "Claude",
    opencode: "OpenCode",
    mimo: "MiMo Code",
  } as Record<string, string>)[snapshot.provider] ?? snapshot.provider;
  if (snapshot.status === "running") {
    const durationMs = snapshot.startedAt ? Math.max(0, Date.now() - Date.parse(snapshot.startedAt)) : undefined;
    segments.push({
      type: "status",
      stepId: "runtime-status",
      label: `${providerName} 正在执行`,
      icon: "think",
      status: "running",
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
      rawItemType: "runtime",
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    });
  } else if (snapshot.startedAt && snapshot.completedAt) {
    // 完成态也生成 runtime-status segment（不显示，仅用于计算总时长）
    const startedAt = Date.parse(snapshot.startedAt);
    const completedAt = Date.parse(snapshot.completedAt);
    const durationMs = Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : undefined;
    segments.push({
      type: "status",
      stepId: "runtime-status",
      label: `${providerName} 已完成`,
      icon: "check",
      status: snapshot.status === "failed" ? "failed" : "completed",
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
      durationMs,
      rawItemType: "runtime",
    });
  }

  if (snapshot.plan?.steps?.length || snapshot.plan?.content?.trim()) {
    const explanation = snapshot.plan.explanation?.trim() || null;
    const content = snapshot.plan.content?.trim() || undefined;
    segments.push({
      type: "plan",
      stepId: `plan-${snapshot.plan.turnId ?? "current"}`,
      title: explanation ?? "执行计划",
      summary: explanation ?? undefined,
      content,
      steps: snapshot.plan.steps,
    });
  }

  if (snapshot.goal?.objective) {
    segments.push({
      type: "goal",
      stepId: "active-goal",
      objective: snapshot.goal.objective,
    });
  }

  for (const item of snapshot.items) {
    if (isInternalUserMessageRawType(item.rawItemType)) continue;
    if (isNoisyTraceRawType(item.rawItemType)) continue;
    if (item.type === "agent_message") {
      if (item.text.trim() && !isFinalAnswerPhase(item.phase)) {
        segments.push({
          type: "thought",
          stepId: `agent-message-${item.id}`,
          text: item.text,
          collapsed: false,
          durationMs: itemDurationMs(item, snapshot.completedAt),
        });
      }
      continue;
    }
    if (item.type === "thinking") {
      segments.push({
        type: "status",
        stepId: item.id,
        label: item.status === "running" ? "正在思考" : "思考",
        icon: "think",
        status: item.status,
        startedAt: item.startedAt,
        durationMs: itemDurationMs(item, snapshot.completedAt),
        rawItemType: item.rawItemType,
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
        summary: item.text || undefined,
        output: item.output ?? undefined,
        durationMs: itemDurationMs(item, snapshot.completedAt),
      });
      continue;
    }
    if (item.type === "tool") {
      segments.push({
        type: "tool",
        stepId: item.id,
        toolName: item.toolName ?? (item.title.includes("文件") ? "修改文件" : item.title),
        command: item.command ?? undefined,
        status: traceStatusToToolStatus(item.status),
        summary: item.error || item.text || undefined,
        input: item.input ?? undefined,
        output: item.output ?? undefined,
        diff: item.diff ?? undefined,
        durationMs: itemDurationMs(item, snapshot.completedAt),
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
        providerId: snapshot.provider,
        status: approval?.status ?? (item.status === "running" ? "pending" : "expired"),
        title: approval?.title ?? item.title,
        command: item.command ?? approval?.command ?? undefined,
        cwd: approval?.cwd ?? undefined,
        fileChanges: approval?.fileChanges ?? [],
        requestedPermissions: approval?.requestedPermissions,
        permissionScope: approval?.permissionScope,
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
      status: item.status,
      startedAt: item.startedAt,
      durationMs: itemDurationMs(item, snapshot.completedAt),
      rawItemType: item.rawItemType,
    });
  }

  // 移除统一的 final-summary，completed 状态已绑定到各个执行步骤
  return segments;
}
