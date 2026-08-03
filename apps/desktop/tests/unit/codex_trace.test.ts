import { describe, expect, it } from "vitest";
import {
  codexTraceSnapshotToSegments,
  isCodexReconnectMessage,
  reduceCodexTraceSnapshot,
  replayCodexTraceEvents,
} from "../../src/main/codex_trace";

describe("isCodexReconnectMessage", () => {
  it("matches the reconnect progress format", () => {
    expect(isCodexReconnectMessage("Reconnecting 1/5")).toBe(true);
    expect(isCodexReconnectMessage("Reconnecting... 3/5")).toBe(true);
    expect(isCodexReconnectMessage("RECONNECTING 2/4")).toBe(true);
  });

  it("rejects unrelated messages", () => {
    expect(isCodexReconnectMessage("正在连接服务器")).toBe(false);
    expect(isCodexReconnectMessage("Reconnecting")).toBe(false);
    expect(isCodexReconnectMessage("")).toBe(false);
  });
});

describe("reduceCodexTraceSnapshot", () => {
  it("captures the thread id from thread/started", () => {
    const snapshot = reduceCodexTraceSnapshot(null, {
      method: "thread/started",
      params: { threadId: "thread-123" },
      receivedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(snapshot.threadId).toBe("thread-123");
    expect(snapshot.updatedAt).toBe("2026-07-30T00:00:00.000Z");
  });

  it("keeps an existing thread id when the event has none", () => {
    const base = reduceCodexTraceSnapshot(null, {
      method: "thread/started",
      params: { threadId: "thread-123" },
      receivedAt: "2026-07-30T00:00:00.000Z",
    });
    const next = reduceCodexTraceSnapshot(base, {
      method: "thread/goal/updated",
      params: { goal: "完成登录重构" },
      receivedAt: "2026-07-30T00:00:01.000Z",
    });
    expect(next.threadId).toBe("thread-123");
  });

  it("sets status running on turn/started and completed on turn/completed", () => {
    let snapshot = reduceCodexTraceSnapshot(null, {
      method: "turn/started",
      params: {},
      receivedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(snapshot.status).toBe("running");
    expect(snapshot.startedAt).toBe("2026-07-30T00:00:00.000Z");

    snapshot = reduceCodexTraceSnapshot(snapshot, {
      method: "turn/completed",
      params: {},
      receivedAt: "2026-07-30T00:00:05.000Z",
    });
    expect(snapshot.status).toBe("completed");
    expect(snapshot.completedAt).toBe("2026-07-30T00:00:05.000Z");
  });

  it("records and clears the goal", () => {
    let snapshot = reduceCodexTraceSnapshot(null, {
      method: "thread/goal/updated",
      params: { goal: { objective: "修复登录 bug" } },
      receivedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(snapshot.goal?.objective).toBe("修复登录 bug");

    snapshot = reduceCodexTraceSnapshot(snapshot, {
      method: "thread/goal/cleared",
      params: {},
      receivedAt: "2026-07-30T00:00:01.000Z",
    });
    expect(snapshot.goal).toBeNull();
  });
});

describe("replayCodexTraceEvents", () => {
  it("replays a sequence of events into a snapshot", () => {
    const snapshot = replayCodexTraceEvents([
      {
        method: "thread/started",
        params: { threadId: "thread-1" },
        receivedAt: "2026-07-30T00:00:00.000Z",
      },
      {
        method: "turn/started",
        params: {},
        receivedAt: "2026-07-30T00:00:01.000Z",
      },
      {
        method: "turn/completed",
        params: {},
        receivedAt: "2026-07-30T00:00:02.000Z",
      },
    ]);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.threadId).toBe("thread-1");
    expect(snapshot!.status).toBe("completed");
  });

  it("skips events missing method or receivedAt", () => {
    const snapshot = replayCodexTraceEvents([
      { params: { threadId: "x" } },
      { method: "turn/started" },
      { method: "turn/started", receivedAt: "2026-07-30T00:00:00.000Z" },
    ]);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.status).toBe("running");
    // threadId defaults to null in the base snapshot — skipped events leave it null.
    expect(snapshot!.threadId).toBeNull();
  });

  it("returns null when no valid events exist", () => {
    expect(replayCodexTraceEvents([])).toBeNull();
    expect(replayCodexTraceEvents([{ foo: 1 }])).toBeNull();
  });
});

describe("codexTraceSnapshotToSegments", () => {
  it("emits a running status segment while the turn runs", () => {
    const segments = codexTraceSnapshotToSegments({
      provider: "codex",
      status: "running",
      startedAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:01.000Z",
      items: [],
      approvals: [],
      errors: [],
      finalText: "",
    });
    const runtime = segments.find((segment) => segment.stepId === "runtime-status");
    expect(runtime).toBeDefined();
    expect(runtime?.type).toBe("status");
    expect(runtime?.status).toBe("running");
  });

  it("keeps a completed runtime-status segment for duration bookkeeping", () => {
    const segments = codexTraceSnapshotToSegments({
      provider: "codex",
      status: "completed",
      startedAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:00:05.000Z",
      updatedAt: "2026-07-30T00:00:05.000Z",
      items: [],
      approvals: [],
      errors: [],
      finalText: "完成",
    });
    const runtime = segments.find((segment) => segment.stepId === "runtime-status");
    // Completed turns still emit a runtime-status segment (used to compute
    // total duration), but with a terminal status instead of "running".
    expect(runtime).toBeDefined();
    expect(runtime?.status).toBe("completed");
    expect(runtime?.durationMs).toBe(5000);
  });

  it("renders tool items with terminal statuses", () => {
    const segments = codexTraceSnapshotToSegments({
      provider: "codex",
      status: "completed",
      updatedAt: "2026-07-30T00:00:05.000Z",
      items: [
        {
          id: "tool-1",
          type: "tool",
          title: "读取文件",
          toolName: "read_file",
          status: "running",
          text: "",
          startedAt: "2026-07-30T00:00:01.000Z",
        },
        {
          id: "tool-2",
          type: "tool",
          title: "修改文件",
          toolName: "write_file",
          status: "failed",
          text: "权限不足",
          error: "permission denied",
          startedAt: "2026-07-30T00:00:02.000Z",
          completedAt: "2026-07-30T00:00:03.000Z",
        },
      ],
      approvals: [],
      errors: [],
      finalText: "",
    });
    const tools = segments.filter((segment) => segment.type === "tool");
    expect(tools).toHaveLength(2);
    // running item renders as running
    expect(tools[0].status).toBe("running");
    expect(tools[0].toolName).toBe("read_file");
    // failed item renders as error
    expect(tools[1].status).toBe("error");
    expect(tools[1].summary).toBe("permission denied");
  });
});
