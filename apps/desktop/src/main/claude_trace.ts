import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CodexTraceItem, CodexTraceSnapshot } from "../services/desktop";

export type ClaudeRawTraceEvent = {
  message: SDKMessage;
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = str(value);
    if (text) return text;
  }
  return undefined;
}

function snapshotBase(now: string): CodexTraceSnapshot {
  return {
    provider: "claude",
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

function completeRunningItems(snapshot: CodexTraceSnapshot, now: string, status: CodexTraceItem["status"] = "completed") {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => item.status === "running"
      ? { ...item, status, completedAt: item.completedAt ?? now }
      : item),
  };
}

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  const content = Array.isArray(message.message.content) ? message.message.content : [];
  return content
    .map((block) => {
      const item = record(block);
      return item.type === "text" ? firstString(item.text) ?? "" : "";
    })
    .join("");
}

function extractPartialText(message: SDKMessage): string {
  if (message.type !== "stream_event") return "";
  const event = record(message.event);
  const delta = record(event.delta);
  return firstString(delta.text, event.text) ?? "";
}

function toolCommand(toolName: string, input: unknown): string | null {
  const data = record(input);
  return firstString(data.command, data.pattern, data.path, data.file_path, data.url, data.prompt)
    ?? (Object.keys(data).length ? `${toolName} ${JSON.stringify(data)}` : toolName);
}

function assistantToolItems(message: SDKMessage, now: string): CodexTraceItem[] {
  if (message.type !== "assistant") return [];
  const content = Array.isArray(message.message.content) ? message.message.content : [];
  return content.flatMap((block): CodexTraceItem[] => {
    const item = record(block);
    if (item.type !== "tool_use") return [];
    const id = firstString(item.id) ?? `claude-tool-${message.uuid}`;
    const name = firstString(item.name) ?? "tool";
    return [{
      id,
      type: name === "Bash" ? "command" : "tool",
      title: name === "Bash" ? "正在运行命令" : `正在使用 ${name}`,
      status: "running",
      text: "",
      startedAt: now,
      completedAt: null,
      rawItemType: "tool_use",
      command: toolCommand(name, item.input),
      output: null,
    }];
  });
}

function appendAgentText(snapshot: CodexTraceSnapshot, text: string, now: string): CodexTraceSnapshot {
  if (!text) return snapshot;
  const current = snapshot.items.find((item) => item.id === "claude-agent-message");
  return upsertItem(snapshot, {
    ...(current ?? {
      id: "claude-agent-message",
      type: "agent_message" as const,
      title: "执行过程",
      status: "running" as const,
      text: "",
      startedAt: now,
      completedAt: null,
      rawItemType: "assistant",
      phase: "final",
    }),
    text: `${current?.text ?? ""}${text}`,
  });
}

function errorMessage(message: SDKMessage): string | null {
  if (message.type === "result" && message.subtype !== "success") {
    return message.errors?.join("\n") || message.subtype;
  }
  if (message.type === "system" && message.subtype === "permission_denied") {
    return message.message || `权限已拒绝：${message.tool_name}`;
  }
  if (message.type === "auth_status" && message.error) {
    return message.error;
  }
  return null;
}

function addError(snapshot: CodexTraceSnapshot, message: string, now: string): CodexTraceSnapshot {
  const failed = completeRunningItems(snapshot, now, "failed");
  return {
    ...failed,
    status: "failed",
    completedAt: now,
    errors: [...failed.errors, { message, at: now }],
    items: [
      ...failed.items,
      {
        id: `claude-error-${failed.errors.length + 1}`,
        type: "error",
        title: "Claude 执行失败",
        status: "failed",
        text: message,
        startedAt: now,
        completedAt: now,
        rawItemType: "error",
      },
    ],
  };
}

export function reduceClaudeTraceSnapshot(
  previous: CodexTraceSnapshot | null | undefined,
  event: ClaudeRawTraceEvent,
): CodexTraceSnapshot {
  const now = event.receivedAt;
  const message = event.message;
  let snapshot = previous ?? snapshotBase(now);
  snapshot = {
    ...snapshot,
    provider: "claude",
    updatedAt: now,
    threadId: message.session_id ?? snapshot.threadId ?? null,
  };

  const err = errorMessage(message);
  if (err) return addError(snapshot, err, now);

  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        snapshot = {
          ...snapshot,
          status: "running",
          startedAt: snapshot.startedAt ?? now,
          completedAt: null,
          turnId: message.uuid,
        };
        snapshot = upsertItem(snapshot, {
          id: "claude-runtime",
          type: "status",
          title: "Claude 已连接",
          status: "running",
          text: `模型 ${message.model}`,
          startedAt: now,
          completedAt: null,
          rawItemType: "init",
        });
      } else if (message.subtype === "status" && message.status) {
        snapshot = upsertItem(snapshot, {
          id: "claude-status",
          type: "thinking",
          title: message.status === "requesting" ? "Claude 正在请求模型" : "Claude 正在压缩上下文",
          status: "running",
          text: "",
          startedAt: now,
          completedAt: null,
          rawItemType: message.subtype,
        });
      } else if (message.subtype === "session_state_changed" && message.state === "running") {
        snapshot = {
          ...snapshot,
          status: "running",
          startedAt: snapshot.startedAt ?? now,
          completedAt: null,
        };
      } else if (message.subtype === "task_started") {
        snapshot = upsertItem(snapshot, {
          id: `claude-task-${message.task_id}`,
          type: "tool",
          title: message.subagent_type ? `正在运行 ${message.subagent_type}` : "正在运行子任务",
          status: "running",
          text: message.description,
          startedAt: now,
          completedAt: null,
          rawItemType: "task_started",
        });
      } else if (message.subtype === "task_progress") {
        const id = `claude-task-${message.task_id}`;
        const current = snapshot.items.find((item) => item.id === id);
        snapshot = upsertItem(snapshot, {
          ...(current ?? {
            id,
            type: "tool" as const,
            title: "正在运行子任务",
            status: "running" as const,
            text: "",
            startedAt: now,
            completedAt: null,
            rawItemType: "task_progress",
          }),
          text: message.summary || message.description || current?.text || "",
          output: message.last_tool_name ?? current?.output ?? null,
        });
      } else if (message.subtype === "task_notification") {
        const id = `claude-task-${message.task_id}`;
        const current = snapshot.items.find((item) => item.id === id);
        snapshot = upsertItem(snapshot, {
          ...(current ?? {
            id,
            type: "tool" as const,
            title: "子任务",
            text: "",
            startedAt: now,
            rawItemType: "task_notification",
          }),
          status: message.status === "failed" ? "failed" : message.status === "stopped" ? "canceled" : "completed",
          text: message.summary || current?.text || "",
          output: message.output_file || current?.output || null,
          completedAt: now,
        });
      } else if (message.subtype === "task_updated") {
        const id = `claude-task-${message.task_id}`;
        const current = snapshot.items.find((item) => item.id === id);
        if (current) {
          const status = message.patch.status === "failed" ? "failed"
            : message.patch.status === "killed" ? "canceled"
            : message.patch.status === "completed" ? "completed"
            : current.status;
          snapshot = upsertItem(snapshot, {
            ...current,
            status,
            text: message.patch.description || current.text,
            output: message.patch.error || current.output,
            completedAt: status === "running" ? current.completedAt : now,
          });
        }
      }
      break;
    }
    case "assistant": {
      const text = extractAssistantText(message);
      const existingText = snapshot.items.find((item) => item.id === "claude-agent-message")?.text.trim();
      if (text && !existingText && !snapshot.finalText) snapshot = appendAgentText(snapshot, text, now);
      for (const item of assistantToolItems(message, now)) snapshot = upsertItem(snapshot, item);
      break;
    }
    case "stream_event": {
      snapshot = appendAgentText(snapshot, extractPartialText(message), now);
      break;
    }
    case "tool_progress": {
      const current = snapshot.items.find((item) => item.id === message.tool_use_id);
      snapshot = upsertItem(snapshot, {
        ...(current ?? {
          id: message.tool_use_id,
          type: message.tool_name === "Bash" ? "command" as const : "tool" as const,
          title: message.tool_name === "Bash" ? "正在运行命令" : `正在使用 ${message.tool_name}`,
          text: "",
          startedAt: now,
          completedAt: null,
          rawItemType: "tool_progress",
        }),
        status: "running",
        output: `${Math.round(message.elapsed_time_seconds)}s`,
      });
      break;
    }
    case "tool_use_summary": {
      snapshot = upsertItem(snapshot, {
        id: `claude-tool-summary-${message.uuid}`,
        type: "status",
        title: "工具调用摘要",
        status: "completed",
        text: message.summary,
        startedAt: now,
        completedAt: now,
        rawItemType: "tool_use_summary",
      });
      break;
    }
    case "result": {
      if (message.subtype === "success") {
        snapshot = {
          ...completeRunningItems(snapshot, now),
          status: "completed",
          completedAt: now,
          finalText: message.result || snapshot.finalText,
        };
      }
      break;
    }
  }

  return snapshot;
}
