
import { app, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  PairResponse,
  DesktopPairingRequest,
  DesktopPairingStatus,
  SavedCloudConfig,
  AiChatOutputEvent,
} from "../services/desktop";
import {
  listWorkspaceProjects,
  listLocalAiSessions,
  listLocalAiHistory,
  archiveLocalAiSession,
  createLocalAiSession,
  appendLocalAiMessage,
  getLocalAiSession,
  getLocalAiTrace,
  updateLocalAiSession,
  resolveWorkspaceProjectPath,
} from "./db";
import { detectAiProviders } from "./providers";
import { assessCommandRisk } from "./risk";
import { respondCodexApproval, runCodexChat, warmupCodexSession } from "./codex";
import { clearCredentials } from "./credentials";
import { syncCodexHistoryMirror } from "./codex_sessions";
import { runAiChat } from "./claude";
import { codexTraceSnapshotToSegments } from "./codex_trace";

// ---------- Cloud config persistence ----------

const STRUCTURED_MESSAGE_PREFIX = "__AI_WORKBENCH_MESSAGE_V1__";
const CODEX_APP_SERVER_SESSION_PREFIX = "app-server:";
const DEFAULT_CLOUD_SERVER_URL = "http://8.162.12.148:3000";
const configPath = path.join(app.getPath("userData"), "cloud-config.json");
const machineIdPath = path.join(app.getPath("userData"), "machine-id");

interface StoredCloudConfig {
  serverUrl: string;
  deviceId: string;
  accessToken: string;
  paired: boolean;
  machineId?: string;
  authMode?: "desktop-login" | "pairing";
  displayName?: string;
}

function getMachineId(): string {
  try {
    if (fs.existsSync(machineIdPath)) {
      const existing = fs.readFileSync(machineIdPath, "utf-8").trim();
      if (existing) return existing;
    }
    const id = randomUUID();
    fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
    fs.writeFileSync(machineIdPath, id, "utf-8");
    return id;
  } catch (e) {
    console.error("Failed to persist machine id:", e);
    return randomUUID();
  }
}

function decodeHistoryContent(content: string): unknown {
  if (!content.startsWith(STRUCTURED_MESSAGE_PREFIX)) return content;
  try {
    const parsed = JSON.parse(content.slice(STRUCTURED_MESSAGE_PREFIX.length));
    return parsed && typeof parsed === "object" ? parsed : content;
  } catch {
    return content;
  }
}

function encodeStructuredHistoryContent(content: string, segments: unknown[]): string {
  return `${STRUCTURED_MESSAGE_PREFIX}${JSON.stringify({
    text: content,
    segments,
  })}`;
}

function isCodexExternalMirrorSession(session: { providerId: string; providerSessionId?: string | null }): boolean {
  return session.providerId === "codex"
    && Boolean(session.providerSessionId)
    && !session.providerSessionId!.startsWith(CODEX_APP_SERVER_SESSION_PREFIX);
}

function listSyncableAiSessions() {
  return listLocalAiSessions().filter((session) => !isCodexExternalMirrorSession(session));
}

function isCodexSession(aiSessionId: string) {
  return getLocalAiSession(aiSessionId)?.providerId === "codex";
}

function traceStatus(trace: unknown): string {
  if (!trace || typeof trace !== "object") return "";
  const record = trace as Record<string, unknown>;
  if (typeof record.status === "string") return record.status;
  const snapshot = record.snapshot;
  if (snapshot && typeof snapshot === "object" && typeof (snapshot as Record<string, unknown>).status === "string") {
    return (snapshot as Record<string, unknown>).status as string;
  }
  return "";
}

function isTerminalTraceStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function mergeChatSegment(segments: unknown[], segment: unknown): unknown[] {
  if (!segment || typeof segment !== "object") return segments;
  const record = segment as Record<string, unknown>;
  const stepId = typeof record.stepId === "string" ? record.stepId : "";
  if (!stepId) return [...segments, segment];
  const index = segments.findIndex((item) => (
    item && typeof item === "object" && (item as Record<string, unknown>).stepId === stepId
  ));
  if (index < 0) return [...segments, segment];
  const next = [...segments];
  next[index] = { ...(next[index] as Record<string, unknown>), ...record };
  return next;
}

function mergeChatSegments(segments: unknown[], incoming: unknown): unknown[] {
  if (!Array.isArray(incoming)) return segments;
  return incoming.reduce((next, segment) => mergeChatSegment(next, segment), segments);
}

function segmentStepId(segment: unknown): string | null {
  if (!segment || typeof segment !== "object") return null;
  const stepId = (segment as Record<string, unknown>).stepId;
  return typeof stepId === "string" && stepId ? stepId : null;
}

function firstSegmentStepId(segments: unknown): string | null {
  if (!Array.isArray(segments)) return null;
  for (const segment of segments) {
    const stepId = segmentStepId(segment);
    if (stepId) return stepId;
  }
  return null;
}

interface MobileAssistantDraft {
  text: string;
  segments: unknown[];
  savedText: string;
  currentStepId?: string | null;
}

function processTextStepId(stepId?: string | null) {
  if (!stepId) return "process-text-agent-message";
  return stepId.startsWith("process-text-") ? stepId : `process-text-${stepId}`;
}

function appendDraftProcessText(draft: MobileAssistantDraft, event: AiChatOutputEvent): void {
  const stepId = event.stepId
    || segmentStepId(event.segment)
    || firstSegmentStepId(event.segments)
    || draft.currentStepId;
  if (stepId) draft.currentStepId = stepId;

  const text = event.text ?? "";
  if (!text) return;
  const processStepId = processTextStepId(stepId);
  const existing = draft.segments.find((segment) => (
    segment && typeof segment === "object" && (segment as Record<string, unknown>).stepId === processStepId
  )) as Record<string, unknown> | undefined;
  draft.segments = mergeChatSegment(draft.segments, {
    type: "text",
    stepId: processStepId,
    text: `${typeof existing?.text === "string" ? existing.text : ""}${text}`,
  });
}

function loadStoredConfig(): StoredCloudConfig | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as StoredCloudConfig;
    if (!sameServerUrl(config.serverUrl, DEFAULT_CLOUD_SERVER_URL)) {
      console.info(`Ignoring cloud config for ${config.serverUrl}; expected ${DEFAULT_CLOUD_SERVER_URL}.`);
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

function sameServerUrl(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    return normalizeServerUrl(left) === normalizeServerUrl(right);
  } catch {
    return false;
  }
}

function saveStoredConfig(config: StoredCloudConfig): void {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save cloud config:", e);
  }
}

export function getCloudConfig(): SavedCloudConfig | null {
  const config = loadStoredConfig();
  if (!config) return null;
  return {
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    paired: config.paired,
    authMode: config.authMode,
    displayName: config.displayName,
  };
}

function getStoredAccessToken(): string | null {
  const config = loadStoredConfig();
  return config?.accessToken ?? null;
}

// ---------- HTTP helpers (Node.js built-in fetch) ----------

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const text = await resp.text();
      if (text) detail = text;
    } catch {
      // ignore body read error
    }
    throw new Error(`HTTP ${resp.status}: ${detail}`);
  }
  return resp.json();
}

function normalizeServerUrl(server: string): string {
  const trimmed = server.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const value = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(value);
  if ((url.protocol === "http:" || url.protocol === "https:") && !url.port) {
    url.port = "3000";
  }
  return url.toString().replace(/\/+$/, "");
}

function saveCloudConfig(
  serverUrl: string,
  deviceId: string | undefined,
  accessToken: string | undefined,
  authMode: StoredCloudConfig["authMode"],
  displayName?: string
): void {
  if (!deviceId || !accessToken) return;
  saveStoredConfig({
    serverUrl,
    deviceId,
    accessToken,
    paired: true,
    machineId: getMachineId(),
    authMode,
    displayName,
  });
  syncInstance?.restart(serverUrl, accessToken, deviceId);
}

export async function loginDesktop(
  server: string,
  email: string,
  password: string
): Promise<PairResponse> {
  const normalizedServer = normalizeServerUrl(server);
  const machineId = getMachineId();
  const resp = await fetchJson(`${normalizedServer}/desktop/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      name: os.hostname(),
      os: process.platform,
      machineId,
    }),
  });

  const deviceId: string | undefined = resp.deviceId ?? resp.device_id;
  const accessToken: string | undefined = resp.accessToken ?? resp.access_token;

  const result: PairResponse = {
    deviceId,
    device_id: deviceId,
    accessToken,
    access_token: accessToken,
  };

  saveCloudConfig(normalizedServer, deviceId, accessToken, "desktop-login", email);

  return result;
}

// logoutDesktop clears the persisted cloud config and stops the WebSocket sync,
// effectively signing the user out and returning them to the login page.
export function logoutDesktop(): void {
  syncInstance?.stop();
  try {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  } catch (e) {
    console.error("Failed to remove cloud config on logout:", e);
  }
  clearCredentials();
}

// OAuth desktop login completes in the renderer, then calls this to register
// the current desktop device and persist the real device id in cloud-config.
export async function saveOAuthLogin(
  serverUrl: string,
  accessToken: string,
  userId: string,
  displayName: string
): Promise<void> {
  const normalizedServer = normalizeServerUrl(serverUrl);
  const machineId = getMachineId();
  const resp = await fetchJson(`${normalizedServer}/desktop/register-device`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ name: os.hostname(), os: process.platform, machineId }),
  });
  const deviceId: string | undefined = resp.deviceId ?? resp.device_id;
  const finalToken: string = resp.accessToken ?? resp.access_token ?? accessToken;
  if (!deviceId) {
    throw new Error("server did not return deviceId; cannot complete device binding");
  }
  saveCloudConfig(normalizedServer, deviceId, finalToken, "desktop-login", displayName || userId);
  syncInstance?.restart(normalizedServer, finalToken, deviceId);
}
export async function pairDesktop(
  server: string,
  code: string
): Promise<PairResponse> {
  const normalizedServer = normalizeServerUrl(server);
  const machineId = getMachineId();
  const url = `${normalizedServer}/desktop/pair`;
  const resp = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      name: os.hostname(),
      os: process.platform,
      machineId,
    }),
  });
  const deviceId: string | undefined = resp.deviceId ?? resp.device_id;
  const accessToken: string | undefined = resp.accessToken ?? resp.access_token;

  const result: PairResponse = {
    deviceId,
    device_id: deviceId,
    accessToken,
    access_token: accessToken,
  };

  saveCloudConfig(normalizedServer, deviceId, accessToken, "pairing");

  return result;
}

export async function createDesktopPairingRequest(
  server: string
): Promise<DesktopPairingRequest> {
  const normalizedServer = normalizeServerUrl(server);
  const machineId = getMachineId();
  const url = `${normalizedServer}/desktop/pairing-requests`;
  const resp = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: os.hostname(), os: process.platform, machineId }),
  });
  return {
    code: resp.code,
    expiresAt: resp.expiresAt ?? resp.expires_at,
  };
}

export async function getDesktopPairingStatus(
  server: string,
  code: string
): Promise<DesktopPairingStatus> {
  const normalizedServer = normalizeServerUrl(server);
  const url = `${normalizedServer}/desktop/pairing-requests/${encodeURIComponent(code)}`;
  const resp = await fetchJson(url, { method: "GET" });
  const deviceId: string | undefined = resp.deviceId ?? resp.device_id;
  const accessToken: string | undefined = resp.accessToken ?? resp.access_token;
  if (resp.status === "approved") {
    saveCloudConfig(normalizedServer, deviceId, accessToken, "pairing");
  }
  return {
    status: resp.status,
    expiresAt: resp.expiresAt ?? resp.expires_at,
    deviceId: deviceId ?? null,
    accessToken: accessToken ?? null,
  };
}

export async function buildDesktopPairingQrPayload(
  server: string,
  code: string
): Promise<string> {
  const normalizedServer = normalizeServerUrl(server);
  return JSON.stringify({
    kind: "ai-workbench.desktop-pairing",
    serverUrl: normalizedServer,
    code,
  });
}

// ---------- WebSocket cloud sync ----------

class DesktopCloudSync {
  private mainWindow: BrowserWindow;
  private generation = 0;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private providerSnapshotCache: { providers: Awaited<ReturnType<typeof detectAiProviders>>; checkedAt: number } | null = null;
  private stopped = false;
  // Tracks projectPath per session for mobile-originated sessions, since the
  // local DB schema does not store project_path on local_ai_sessions.
  private sessionProjectPaths = new Map<string, string>();
  private mobileAssistantDrafts = new Map<string, MobileAssistantDraft>();
  private mobileDeltaBuffers = new Map<string, { text: string; segments: unknown[]; timer: ReturnType<typeof setTimeout> | null; deviceId: string }>();

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  /** Start the connection if a paired config is stored. */
  start(): void {
    const config = loadStoredConfig();
    if (!config || !config.paired || !config.accessToken) return;
    this.connect(config.serverUrl, config.accessToken, config.deviceId);
  }

  private connect(
    serverUrl: string,
    accessToken: string,
    deviceId: string
  ): void {
    const myGeneration = ++this.generation;
    const url = `${serverUrl.replace(/^http/, "ws")}/ws/desktop?token=${encodeURIComponent(accessToken)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      if (myGeneration !== this.generation) return;
      this.startHeartbeat(deviceId);
      this.startSnapshot(deviceId);
    });

    ws.on("message", (data) => {
      if (myGeneration !== this.generation) return;
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg, deviceId);
      } catch (e) {
        console.error("Failed to parse cloud message:", e);
      }
    });

    ws.on("close", () => {
      if (myGeneration !== this.generation) return;
      this.stopTimers();
      this.scheduleReconnect(serverUrl, accessToken, deviceId);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
    });
  }

  // ----- heartbeat: send desktop.heartbeat every 30s -----
  private startHeartbeat(deviceId: string): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: "desktop.heartbeat",
        deviceId,
        timestamp: new Date().toISOString(),
      });
    }, 30_000);
  }

  // ----- snapshots: push providers/projects/ai-sessions every 30s -----
  private startSnapshot(deviceId: string): void {
    this.snapshotTimer = setInterval(() => {
      this.pushSnapshots(deviceId);
    }, 30_000);
    // Push immediately on connect.
    this.pushSnapshots(deviceId);
  }

  private pushSnapshots(deviceId: string): void {
    const projects = listWorkspaceProjects();
    const sessions = listSyncableAiSessions();
    this.send({ type: "projects.snapshot", deviceId, projects });
    this.send({ type: "ai.sessions.snapshot", deviceId, sessions });
    this.pushProviderSnapshot(deviceId);
  }

  private pushProviderSnapshot(deviceId: string): void {
    const now = Date.now();
    if (this.providerSnapshotCache && now - this.providerSnapshotCache.checkedAt < 5 * 60_000) {
      this.send({ type: "providers.snapshot", deviceId, providers: this.providerSnapshotCache.providers });
      return;
    }
    detectAiProviders()
      .then((providers) => {
        this.providerSnapshotCache = { providers, checkedAt: Date.now() };
        this.send({ type: "providers.snapshot", deviceId, providers });
      })
      .catch(() => {
        if (this.providerSnapshotCache) {
          this.send({ type: "providers.snapshot", deviceId, providers: this.providerSnapshotCache.providers });
        }
      });
  }

  /**
   * Immediately push an ai.sessions.snapshot to the cloud so mobile clients
   * see desktop-created sessions without waiting for the next 10s tick.
   * No-op if the WebSocket is not connected.
   */
  pushSessionSnapshot(): void {
    const config = loadStoredConfig();
    if (!config) return;
    const sessions = listSyncableAiSessions();
    this.send({ type: "ai.sessions.snapshot", deviceId: config.deviceId, sessions });
  }

  /**
   * Immediately push a projects.snapshot to the cloud so mobile clients see
   * desktop-added projects without waiting for the next 10s tick.
   * No-op if the WebSocket is not connected.
   */
  pushProjectSnapshot(): void {
    const config = loadStoredConfig();
    if (!config) return;
    const projects = listWorkspaceProjects();
    this.send({ type: "projects.snapshot", deviceId: config.deviceId, projects });
  }

  /**
   * Push the latest local history for one AI session to mobile clients.
   * Desktop-originated user messages are written to SQLite before provider
   * output starts, so mobile needs this explicit history push to see them.
   */
  async pushAiHistory(aiSessionId: string): Promise<void> {
    const config = loadStoredConfig();
    if (!config) return;
    try {
      await syncCodexHistoryMirror(aiSessionId);
    } catch (e) {
      console.error("pushAiHistory: codex history sync failed:", e);
    }
    this.send({
      type: "ai.history.response",
      deviceId: config.deviceId,
      aiSessionId,
      requestId: `push-${Date.now()}`,
      messages: this.buildHistoryMessages(aiSessionId),
      trace: this.buildHistoryTrace(aiSessionId),
    });
  }

  beginAiTurn(aiSessionId: string): void {
    this.discardMobileDelta(aiSessionId);
    this.mobileAssistantDrafts.delete(aiSessionId);
  }

  /**
   * Rename an AI session everywhere: update local SQLite, then call the
   * backend PATCH /ai-sessions/{id} so PostgreSQL is updated and the server
   * forwards ai.session.rename to other clients (e.g. mobile).
   * Best-effort: backend failure is logged but does not revert the local
   * change, since the local UI already shows the new title.
   */
  async renameAiSession(aiSessionId: string, title: string): Promise<void> {
    try {
      updateLocalAiSession(aiSessionId, { title });
    } catch (e) {
      console.error("renameAiSession: local update failed:", e);
    }
    this.notify("workspace-changed");
    this.notify("ai-history-changed", { aiSessionId });

    const config = loadStoredConfig();
    if (!config || !config.accessToken) return;
    try {
      const url = `${normalizeServerUrl(config.serverUrl)}/ai-sessions/${encodeURIComponent(aiSessionId)}`;
      await fetchJson(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify({ title }),
      });
    } catch (e) {
      console.error("renameAiSession: backend PATCH failed:", e);
    }
  }

  // ----- message dispatch -----
  private handleMessage(msg: any, deviceId: string): void {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "project.created":
        void this.handleProjectCreated(msg, deviceId);
        break;
      case "ai.session.create":
        void this.handleAiSessionCreate(msg, deviceId);
        break;
      case "ai.message.send":
        void this.handleAiMessageSend(msg, deviceId);
        break;
      case "ai.history.request":
        void this.handleAiHistoryRequest(msg, deviceId);
        break;
      case "ai.session.archive":
        this.handleAiSessionArchive(msg, deviceId);
        break;
      case "ai.session.rename":
        this.handleAiSessionRename(msg, deviceId);
        break;
      case "ai.approval.respond":
        this.handleAiApprovalRespond(msg, deviceId);
        break;
      default:
        // unknown message type — ignore
        break;
    }
  }

  /** project.created: register the project locally and notify the UI. */
  private async handleProjectCreated(msg: any, _deviceId: string): Promise<void> {
    const project = msg.project;
    if (!project?.path) return;
    try {
      await resolveWorkspaceProjectPath(project.path);
    } catch {
      // project path may not exist on this machine — ignore
    }
    this.notify("workspace-changed");
  }

  /** ai.session.create: create a local AI session record and notify the UI. */
  private async handleAiSessionCreate(msg: any, _deviceId: string): Promise<void> {
    try {
      const aiSessionId: string = msg.aiSessionId;
      const providerId: string = msg.providerId;
      const projectPath: string | undefined = msg.projectPath;
      const title: string = msg.title;
      const terminalSessionId: string | undefined | null = msg.terminalSessionId;
      let sessionProjectPath = projectPath ?? null;

      if (projectPath) {
        // 如果移动端传入的是已有项目里的子文件夹，会归到已有项目，避免自动新增子项目。
        try {
          sessionProjectPath = await resolveWorkspaceProjectPath(projectPath);
        } catch {
          // project may not exist or git may be unavailable — ignore
        }
        this.sessionProjectPaths.set(aiSessionId, sessionProjectPath ?? projectPath);
      }

      if (!getLocalAiSession(aiSessionId)) {
        createLocalAiSession({
          id: aiSessionId,
          providerId: providerId || "claude",
          terminalSessionId: terminalSessionId ?? null,
          title: title || "Mobile session",
          status: "idle",
          summary: sessionProjectPath,
        });
      }

      this.notify("workspace-changed");
      this.notify("ai-history-changed", { aiSessionId });
      if ((providerId || "claude") === "codex") {
        void this.warmupCreatedCodexSession(aiSessionId);
      }
    } catch (e) {
      console.error("handleAiSessionCreate failed:", e);
    }
  }

  private async warmupCreatedCodexSession(aiSessionId: string): Promise<void> {
    try {
      const warmed = await warmupCodexSession(aiSessionId, { send: () => undefined });
      if (!warmed.providerSessionId) return;
      updateLocalAiSession(aiSessionId, { providerSessionId: warmed.providerSessionId });
      this.notify("workspace-changed");
      this.notify("ai-history-changed", { aiSessionId });
      this.pushSessionSnapshot();
    } catch (e) {
      console.error("warmupCreatedCodexSession failed:", e);
    }
  }

  private static readonly DELTA_FLUSH_MS = 100;

  private flushMobileDelta(sessionId: string): void {
    const buffer = this.mobileDeltaBuffers.get(sessionId);
    if (!buffer) return;
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    if (buffer.text) {
      this.send({
        type: "ai.chat.output",
        deviceId: buffer.deviceId,
        aiSessionId: sessionId,
        kind: "delta",
        text: buffer.text,
        segments: buffer.segments,
      });
    }
    this.mobileDeltaBuffers.delete(sessionId);
  }

  private discardMobileDelta(sessionId: string): void {
    const buffer = this.mobileDeltaBuffers.get(sessionId);
    if (buffer?.timer) {
      clearTimeout(buffer.timer);
    }
    this.mobileDeltaBuffers.delete(sessionId);
  }

  private scheduleMobileDeltaFlush(deviceId: string, sessionId: string, text: string, segments: unknown[]): void {
    let buffer = this.mobileDeltaBuffers.get(sessionId);
    if (!buffer) {
      buffer = { text: "", segments: [], timer: null, deviceId };
      this.mobileDeltaBuffers.set(sessionId, buffer);
    }
    buffer.text += text;
    buffer.segments = segments;
    buffer.deviceId = deviceId;
    if (!buffer.timer) {
      const captured = buffer;
      buffer.timer = setTimeout(() => {
        captured.timer = null;
        this.flushMobileDelta(sessionId);
      }, DesktopCloudSync.DELTA_FLUSH_MS);
    }
  }

  private buildHistoryMessages(aiSessionId: string): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = listLocalAiHistory(aiSessionId).map((message) => ({
      ...message,
      content: decodeHistoryContent(message.content),
    }));
    const draft = this.mobileAssistantDrafts.get(aiSessionId);
    if (draft && (draft.text.trim() || draft.segments.length)) {
      messages.push({
        role: "assistant",
        content: {
          text: draft.text,
          segments: draft.segments,
        },
        createdAt: new Date().toISOString(),
        pending: true,
      });
    }
    return messages;
  }

  private buildHistoryTrace(aiSessionId: string): Record<string, unknown> | null {
    const trace = getLocalAiTrace(aiSessionId, "codex");
    if (!trace || trace.providerId !== "codex") return null;
    const snapshot = trace.snapshot as Record<string, unknown>;
    return {
      ...trace,
      segments: codexTraceSnapshotToSegments(snapshot as any),
    };
  }

  createRendererAndMobileAiChatSender(rendererSender: { send: (channel: string, ...args: unknown[]) => void }) {
    const config = loadStoredConfig();
    const deviceId = config?.deviceId;
    return {
      send: (channel: string, ...args: unknown[]) => {
        rendererSender.send(channel, ...args);
        if (channel === "ai-trace-update") {
          const event = args[0] as { aiSessionId?: string; trace?: unknown } | undefined;
          if (!deviceId || !event?.aiSessionId || !event.trace) return;
          const status = traceStatus(event.trace);
          this.send({
            type: "ai.trace.update",
            deviceId,
            aiSessionId: event.aiSessionId,
            trace: {
              ...(event.trace as Record<string, unknown>),
              segments: codexTraceSnapshotToSegments((event.trace as Record<string, unknown>).snapshot as any),
            },
          });
          if (isTerminalTraceStatus(status)) {
            void this.pushAiHistory(event.aiSessionId);
          }
          return;
        }
        if (!deviceId || channel !== "ai-chat-output") return;
        const event = args[0] as AiChatOutputEvent | undefined;
        if (!event?.aiSessionId) return;
        const codexSession = isCodexSession(event.aiSessionId);
        if (event.kind === "status" && event.text === "mobile sent message") return;
        const draft = this.mobileAssistantDrafts.get(event.aiSessionId) ?? { text: "", segments: [], savedText: "" };
        if (event.kind === "delta" && event.text) {
          if (event.stepId) draft.currentStepId = event.stepId;
          if (codexSession && event.phase === "process") {
            draft.text += event.text;
            this.mobileAssistantDrafts.set(event.aiSessionId, draft);
            this.scheduleMobileDeltaFlush(deviceId, event.aiSessionId, event.text, draft.segments);
            return;
          }
          if (event.phase === "process") {
            appendDraftProcessText(draft, event);
            this.flushMobileDelta(event.aiSessionId);
            this.mobileAssistantDrafts.set(event.aiSessionId, draft);
            this.send({
              type: "ai.chat.output",
              deviceId,
              ...event,
              text: "",
              segments: draft.segments,
            });
            return;
          }
          draft.text += event.text;
          this.mobileAssistantDrafts.set(event.aiSessionId, draft);
          this.scheduleMobileDeltaFlush(deviceId, event.aiSessionId, event.text, draft.segments);
          return;
        }
        draft.segments = mergeChatSegments(draft.segments, event.segments);
        if (event.segment) {
          draft.segments = mergeChatSegment(draft.segments, event.segment);
        }
        if (event.kind === "done") {
          this.flushMobileDelta(event.aiSessionId);
          const finalText = event.text?.trim() ? event.text : draft.text;
          this.mobileAssistantDrafts.set(event.aiSessionId, draft);
          this.send({
            type: "ai.chat.output",
            deviceId,
            ...event,
            text: finalText,
            segments: draft.segments,
          });
          this.mobileAssistantDrafts.delete(event.aiSessionId);
          void this.pushAiHistory(event.aiSessionId);
          return;
        }
        this.flushMobileDelta(event.aiSessionId);
        this.mobileAssistantDrafts.set(event.aiSessionId, draft);
        this.send({
          type: "ai.chat.output",
          deviceId,
          ...event,
          segments: draft.segments,
        });
      },
    };
  }

  private createAiChatSender(deviceId: string) {
    return {
      send: (channel: string, ...args: unknown[]) => {
        this.notify(channel, ...args);
        if (channel === "ai-trace-update") {
          const event = args[0] as { aiSessionId?: string; trace?: unknown } | undefined;
          if (!event?.aiSessionId || !event.trace) return;
          const status = traceStatus(event.trace);
          this.send({
            type: "ai.trace.update",
            deviceId,
            aiSessionId: event.aiSessionId,
            trace: {
              ...(event.trace as Record<string, unknown>),
              segments: codexTraceSnapshotToSegments((event.trace as Record<string, unknown>).snapshot as any),
            },
          });
          if (isTerminalTraceStatus(status)) {
            void this.pushAiHistory(event.aiSessionId);
          }
          return;
        }
        if (channel !== "ai-chat-output") return;
        const event = args[0] as AiChatOutputEvent | undefined;
        if (!event?.aiSessionId) return;
        const codexSession = isCodexSession(event.aiSessionId);
        if (event.kind === "status" && event.text === "mobile sent message") return;
        const draft = this.mobileAssistantDrafts.get(event.aiSessionId) ?? { text: "", segments: [], savedText: "" };
        if (event.kind === "delta" && event.text) {
          if (event.stepId) draft.currentStepId = event.stepId;
          if (codexSession && event.phase === "process") {
            draft.text += event.text;
            this.mobileAssistantDrafts.set(event.aiSessionId, draft);
            this.scheduleMobileDeltaFlush(deviceId, event.aiSessionId, event.text, draft.segments);
            return;
          }
          if (event.phase === "process") {
            appendDraftProcessText(draft, event);
            this.flushMobileDelta(event.aiSessionId);
            this.mobileAssistantDrafts.set(event.aiSessionId, draft);
            this.send({
              type: "ai.chat.output",
              deviceId,
              ...event,
              text: "",
              segments: draft.segments,
            });
            return;
          }
          draft.text += event.text;
          this.mobileAssistantDrafts.set(event.aiSessionId, draft);
          this.scheduleMobileDeltaFlush(deviceId, event.aiSessionId, event.text, draft.segments);
          return;
        }
        draft.segments = mergeChatSegments(draft.segments, event.segments);
        if (event.segment) {
          draft.segments = mergeChatSegment(draft.segments, event.segment);
        }
        if (event.kind === "done") {
          this.flushMobileDelta(event.aiSessionId);
          const finalText = event.text?.trim() ? event.text : draft.text;
          if (finalText.trim() && finalText !== draft.savedText) {
            appendLocalAiMessage(event.aiSessionId, "assistant", encodeStructuredHistoryContent(finalText, draft.segments));
            draft.savedText = finalText;
          }
          this.mobileAssistantDrafts.set(event.aiSessionId, draft);
          this.send({
            type: "ai.chat.output",
            deviceId,
            ...event,
            text: finalText,
            segments: draft.segments,
          });
          this.mobileAssistantDrafts.delete(event.aiSessionId);
          this.notify("ai-history-changed", { aiSessionId: event.aiSessionId });
          void this.pushAiHistory(event.aiSessionId);
          return;
        }
        this.flushMobileDelta(event.aiSessionId);
        this.mobileAssistantDrafts.set(event.aiSessionId, draft);
        this.send({
          type: "ai.chat.output",
          deviceId,
          ...event,
          segments: draft.segments,
        });
      },
    };
  }

  /** ai.message.send: risk-check, then run the AI chat turn locally. */
  private async handleAiMessageSend(msg: any, deviceId: string): Promise<void> {
    try {
      const aiSessionId: string = msg.aiSessionId;
      const content: string = msg.content;
      const confirmedRisk: boolean = !!msg.confirmedRisk;

      const risk = assessCommandRisk(content);
      if (risk.risky && !confirmedRisk) {
        this.send({
          type: "ai.message.done",
          deviceId,
          aiSessionId,
          status: "failed",
          summary: "RISK_CONFIRMATION_REQUIRED",
        });
        this.notify("ai-chat-output", {
          aiSessionId,
          kind: "error",
          text: "高风险命令需确认",
        });
        return;
      }

      this.beginAiTurn(aiSessionId);
      appendLocalAiMessage(aiSessionId, "user", content);
      this.notify("ai-history-changed", { aiSessionId });
      await this.pushAiHistory(aiSessionId);

      const session = getLocalAiSession(aiSessionId);
      if (!session) {
        this.send({
          type: "ai.message.done",
          deviceId,
          aiSessionId,
          status: "failed",
          summary: "session not found",
        });
        return;
      }

      const projectPath = this.sessionProjectPaths.get(aiSessionId) ?? session.summary ?? os.homedir();
      const aiChatSender = this.createAiChatSender(deviceId);
      if (session.providerId !== "codex") {
        aiChatSender.send("ai-chat-output", {
          aiSessionId,
          kind: "status",
          text: "running",
          segment: {
            type: "status",
            stepId: "mobile-run-started",
            label: "正在处理",
            icon: "think",
          },
        });
      }

      try {
        let providerSessionId: string | null = null;
        if (session.providerId === "codex") {
          providerSessionId = await runCodexChat(
            { aiSessionId, projectPath, prompt: content },
            aiChatSender
          );
        } else {
          providerSessionId = await runAiChat(
            { aiSessionId, projectPath, prompt: content },
            aiChatSender,
            session.providerSessionId ?? null
          );
        }

        if (providerSessionId) {
          updateLocalAiSession(aiSessionId, {
            providerSessionId,
            status: "completed",
          });
        } else {
          updateLocalAiSession(aiSessionId, { status: "completed" });
        }
        this.send({
          type: "ai.message.done",
          deviceId,
          aiSessionId,
          status: "completed",
          summary: null,
        });
      } catch (err) {
        try {
          updateLocalAiSession(aiSessionId, { status: "failed" });
        } catch {
          // ignore — session may already be gone
        }
        this.send({
          type: "ai.message.done",
          deviceId,
          aiSessionId,
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.notify("ai-history-changed", { aiSessionId });
      }
    } catch (e) {
      console.error("handleAiMessageSend failed:", e);
    }
  }

  private handleAiApprovalRespond(msg: any, deviceId: string): void {
    const aiSessionId = typeof msg.aiSessionId === "string" ? msg.aiSessionId : "";
    const approvalId = typeof msg.approvalId === "string" ? msg.approvalId : "";
    const decision = msg.decision === "approved" || msg.decision === "denied" ? msg.decision : null;
    if (!aiSessionId || !approvalId || !decision) return;
    const ok = respondCodexApproval(aiSessionId, approvalId, decision);
    if (!ok) {
      this.send({
        type: "ai.chat.output",
        deviceId,
        aiSessionId,
        kind: "error",
        text: "审批请求已失效或无法处理",
      });
    }
  }

  /** ai.history.request: reply with the local message history. */
  private async handleAiHistoryRequest(msg: any, deviceId: string): Promise<void> {
    const aiSessionId: string = msg.aiSessionId;
    const requestId: string = msg.requestId;
    try {
      await syncCodexHistoryMirror(aiSessionId);
    } catch (e) {
      console.error("handleAiHistoryRequest: codex history sync failed:", e);
    }
    this.send({
      type: "ai.history.response",
      deviceId,
      aiSessionId,
      requestId,
      messages: this.buildHistoryMessages(aiSessionId),
      trace: this.buildHistoryTrace(aiSessionId),
    });
  }

  /** ai.session.archive: archive (or unarchive) a local session. */
  private handleAiSessionArchive(msg: any, _deviceId: string): void {
    const aiSessionId: string = msg.aiSessionId;
    const archived: boolean = !!msg.archived;
    try {
      archiveLocalAiSession(aiSessionId, archived);
    } catch {
      // session may not exist locally — ignore
    }
    this.notify("workspace-changed");
    this.notify("ai-history-changed", { aiSessionId });
  }

  /** ai.session.rename: a mobile client renamed the session via HTTP PATCH.
   *  Update the local SQLite title so the desktop UI matches. */
  private handleAiSessionRename(msg: any, _deviceId: string): void {
    const aiSessionId: string = msg.aiSessionId;
    const title: string = msg.title;
    if (!aiSessionId || !title) return;
    try {
      updateLocalAiSession(aiSessionId, { title });
    } catch {
      // session may not exist locally — ignore
    }
    this.notify("workspace-changed");
    this.notify("ai-history-changed", { aiSessionId });
  }

  // ----- low-level send / notify -----

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        console.error("Failed to send cloud message:", e);
      }
    }
  }

  /** Send an event to the renderer, guarded against a destroyed window. */
  private notify(channel: string, ...args: unknown[]): void {
    try {
      if (!this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, ...args);
      }
    } catch (e) {
      console.error(`Failed to send '${channel}' to renderer:`, e);
    }
  }

  // ----- timers / lifecycle -----

  private stopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private scheduleReconnect(
    serverUrl: string,
    accessToken: string,
    deviceId: string
  ): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect(serverUrl, accessToken, deviceId);
    }, 5_000);
  }

  restart(serverUrl: string, accessToken: string, deviceId: string): void {
    this.stopped = false;
    this.stopTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connect(serverUrl, accessToken, deviceId);
  }

  stop(): void {
    this.stopped = true;
    this.stopTimers();
    for (const [, buffer] of this.mobileDeltaBuffers) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    this.mobileDeltaBuffers.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

// ---------- Module exports ----------

let syncInstance: DesktopCloudSync | null = null;

export function initDesktopCloudSync(mainWindow: BrowserWindow): void {
  syncInstance = new DesktopCloudSync(mainWindow);
  syncInstance.start();
}

export function getDesktopCloudSync(): DesktopCloudSync | null {
  return syncInstance;
}

// ---- Token 用量上报与查询 ----

export interface TokenUsageReport {
  aiSessionId: string;
  providerId: string;
  deviceId?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface TokenUsageSummaryItem {
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turnCount: number;
}

export interface TokenUsageSummary {
  providers: TokenUsageSummaryItem[];
  totals: TokenUsageSummaryItem;
}

/**
 * 上报一次 AI turn 的 token 用量到后端。best-effort：失败仅打日志，不影响主流程。
 */
export async function reportTokenUsage(report: TokenUsageReport): Promise<void> {
  const config = loadStoredConfig();
  if (!config || !config.accessToken || !report.providerId) return;
  const url = `${normalizeServerUrl(config.serverUrl)}/token-usage`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        aiSessionId: report.aiSessionId || undefined,
        deviceId: report.deviceId || config.deviceId || undefined,
        providerId: report.providerId,
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        reasoningTokens: report.reasoningTokens,
        totalTokens: report.totalTokens,
      }),
    });
    if (!resp.ok) {
      let detail = resp.statusText;
      try {
        const text = await resp.text();
        if (text) detail = text;
      } catch {
        // ignore body read error
      }
      throw new Error(`HTTP ${resp.status}: ${detail}`);
    }
  } catch (e) {
    console.error("reportTokenUsage failed:", e);
  }
}

/**
 * 查询当前用户按工具聚合的 token 用量。
 */
export async function fetchTokenUsageSummary(): Promise<TokenUsageSummary | null> {
  const config = loadStoredConfig();
  if (!config || !config.accessToken) return null;
  const url = `${normalizeServerUrl(config.serverUrl)}/token-usage/summary`;
  try {
    return (await fetchJson(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.accessToken}` },
    })) as TokenUsageSummary;
  } catch (e) {
    console.error("fetchTokenUsageSummary failed:", e);
    return null;
  }
}
