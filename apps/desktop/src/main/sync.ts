
import { app, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  PairResponse,
  SavedCloudConfig,
  AiChatOutputEvent,
  AppUpdateInfo,
  ClaudeReasoningEffort,
  CodexModelOption,
  CodexReasoningEffort,
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
import { listCodexModels, respondCodexApproval, runCodexChat, stopCodexChat, warmupCodexSession } from "./codex";
import { clearCredentials } from "./credentials";
import { syncCodexHistoryMirror } from "./codex_sessions";
import { runAiChat, stopAiChat } from "./claude";
import { runOpenCodeChat, stopOpenCodeChat } from "./acp";
import { respondMimoApproval, runMimoChat, stopMimoChat } from "./mimo";
import { codexTraceSnapshotToSegments } from "./codex_trace";

// ---------- Cloud config persistence ----------

const STRUCTURED_MESSAGE_PREFIX = "__AI_WORKBENCH_MESSAGE_V1__";
const configPath = path.join(app.getPath("userData"), "cloud-config.json");
const machineIdPath = path.join(app.getPath("userData"), "machine-id");

export type AiRunSettingsState = {
  codex: {
    providerId: "codex";
    model: string;
    reasoningEffort: string;
    models: CodexModelOption[];
    reasoningOptions: string[];
    serviceTier: string | null;
  };
  claude: {
    providerId: "claude";
    model: string;
    reasoningEffort: string;
    models: CodexModelOption[];
    reasoningOptions: string[];
  };
};

const defaultRunSettings: AiRunSettingsState = {
  codex: {
    providerId: "codex",
    model: "",
    reasoningEffort: "",
    models: [],
    reasoningOptions: ["low", "medium", "high", "ultra"],
    serviceTier: null,
  },
  claude: {
    providerId: "claude",
    model: "sonnet",
    reasoningEffort: "high",
    models: [
      { id: "sonnet", model: "sonnet", displayName: "Sonnet" },
      { id: "opus", model: "opus", displayName: "Opus" },
      { id: "fable", model: "fable", displayName: "Fable" },
      { id: "default", model: "", displayName: "默认" },
    ],
    reasoningOptions: ["low", "medium", "high", "xhigh", "max"],
  },
};

function cloneRunSettings(settings: AiRunSettingsState): AiRunSettingsState {
  return JSON.parse(JSON.stringify(settings)) as AiRunSettingsState;
}

function codexReasoningEffort(value: string): CodexReasoningEffort | null {
  return value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    || value === "ultra"
    ? value
    : null;
}

const fallbackCodexReasoningOptions: CodexReasoningEffort[] = ["low", "medium", "high", "ultra"];

function normalizeCodexRunSettings(settings: AiRunSettingsState["codex"]): AiRunSettingsState["codex"] {
  const selectedModel = settings.models.find((model) => model.model === settings.model)
    ?? (!settings.model ? settings.models.find((model) => model.isDefault) ?? settings.models[0] : undefined);
  const model = settings.model || selectedModel?.model || "";
  const advertisedEfforts = selectedModel?.supportedReasoningEfforts?.map((option) => option.reasoningEffort) ?? [];
  const reasoningOptions = advertisedEfforts.length ? advertisedEfforts : fallbackCodexReasoningOptions;
  const requestedEffort = codexReasoningEffort(settings.reasoningEffort);
  const modelDefault = selectedModel?.defaultReasoningEffort;
  const reasoningEffort = requestedEffort && reasoningOptions.includes(requestedEffort)
    ? requestedEffort
    : modelDefault && reasoningOptions.includes(modelDefault)
      ? modelDefault
      : reasoningOptions.includes("high")
        ? "high"
        : reasoningOptions[0] ?? "";
  const serviceTier = settings.serviceTier
    && selectedModel?.serviceTiers?.some((tier) => tier.id === settings.serviceTier)
    ? settings.serviceTier
    : null;
  return {
    ...settings,
    model,
    reasoningEffort,
    reasoningOptions,
    serviceTier,
  };
}

function claudeReasoningEffort(value: string): ClaudeReasoningEffort | null {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : null;
}

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

function listSyncableAiSessions() {
  return listLocalAiSessions();
}

function isTraceProvider(providerId?: string | null) {
  return providerId === "codex" || providerId === "claude" || providerId === "opencode" || providerId === "mimo";
}

function traceKindForProvider(providerId?: string | null) {
  if (providerId === "claude" || providerId === "opencode" || providerId === "mimo") return providerId;
  return "codex";
}

function isTraceProviderSession(aiSessionId: string) {
  return isTraceProvider(getLocalAiSession(aiSessionId)?.providerId);
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
    return config;
  } catch {
    return null;
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

export async function fetchDesktopAppRelease(currentVersion: string): Promise<AppUpdateInfo | null> {
  const config = loadStoredConfig();
  if (!config?.serverUrl || !config.accessToken) return null;
  try {
    const url = new URL(`${config.serverUrl.replace(/\/+$/, "")}/app/releases`);
    url.searchParams.set("platform", "desktop");
    url.searchParams.set("currentVersion", currentVersion);
    url.searchParams.set("os", process.platform);
    const info = await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    }) as {
      available?: boolean;
      latestVersion?: string;
      currentVersion?: string;
      releaseNotes?: string | null;
      required?: boolean;
      force?: boolean;
      downloadUrl?: string | null;
      windowsDownloadUrl?: string | null;
      linuxDownloadUrl?: string | null;
      releaseUrl?: string | null;
      source?: string;
    };
    return {
      available: info.available === true,
      version: info.latestVersion,
      currentVersion: info.currentVersion || currentVersion,
      body: info.releaseNotes ?? null,
      installable: appIsPackaged(),
      required: info.required === true,
      force: info.force === true,
      downloadUrl: info.downloadUrl ?? null,
      windowsDownloadUrl: info.windowsDownloadUrl ?? null,
      linuxDownloadUrl: info.linuxDownloadUrl ?? null,
      releaseUrl: info.releaseUrl ?? null,
      source: info.source,
    };
  } catch {
    return null;
  }
}

function appIsPackaged(): boolean {
  return app.isPackaged;
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

// ---------- WebSocket cloud sync ----------

class DesktopCloudSync {
  private mainWindow: BrowserWindow;
  private generation = 0;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private providerSnapshotCache: { providers: Awaited<ReturnType<typeof detectAiProviders>>; checkedAt: number } | null = null;
  private runSettings: AiRunSettingsState = cloneRunSettings(defaultRunSettings);
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
    void this.pushRunSettingsSnapshot(deviceId);
  }

  publishRunSettings(settings: Partial<AiRunSettingsState>): void {
    this.runSettings = {
      codex: { ...this.runSettings.codex, ...settings.codex },
      claude: { ...this.runSettings.claude, ...settings.claude },
    };
    const config = loadStoredConfig();
    if (!config) return;
    void this.pushRunSettingsSnapshot(config.deviceId);
  }

  private async pushRunSettingsSnapshot(deviceId: string): Promise<void> {
    const settings = cloneRunSettings(this.runSettings);
    if (settings.codex.models.length === 0) {
      try {
        const models = await listCodexModels();
        settings.codex.models = models;
      } catch {
        // Keep the last known/default settings.
      }
    }
    if (settings.codex.models.length > 0) {
      settings.codex = normalizeCodexRunSettings(settings.codex);
      this.runSettings.codex = { ...settings.codex };
    }
    this.send({
      type: "ai.run.settings.snapshot",
      deviceId,
      ...settings,
    });
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
   * Rename a desktop-owned session locally and publish the authoritative
   * session snapshot. The backend PATCH route is for mobile-originated
   * renames and can return 403 while a new desktop session is still being
   * inserted from its first snapshot.
   */
  async renameAiSession(aiSessionId: string, title: string): Promise<void> {
    try {
      updateLocalAiSession(aiSessionId, { title });
    } catch (e) {
      console.error("renameAiSession: local update failed:", e);
    }
    this.notify("workspace-changed");
    this.notify("ai-history-changed", { aiSessionId });
    this.pushSessionSnapshot();
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
      case "ai.message.stop":
        this.handleAiMessageStop(msg, deviceId);
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
        void this.handleAiApprovalRespond(msg, deviceId);
        break;
      case "ai.run.settings.update":
        this.handleAiRunSettingsUpdate(msg, deviceId);
        break;
      case "app.update.available":
        this.notify("app-update-available", {
          available: msg.available === true,
          version: msg.latestVersion,
          currentVersion: msg.currentVersion,
          body: msg.releaseNotes ?? null,
          installable: appIsPackaged(),
          required: msg.required === true,
          force: msg.force === true,
          downloadUrl: msg.downloadUrl ?? null,
          windowsDownloadUrl: msg.windowsDownloadUrl ?? null,
          linuxDownloadUrl: msg.linuxDownloadUrl ?? null,
          releaseUrl: msg.releaseUrl ?? null,
          source: msg.source,
        });
        break;
      default:
        // unknown message type — ignore
        break;
    }
  }

  private handleAiRunSettingsUpdate(msg: any, deviceId: string): void {
    const providerId = typeof msg.providerId === "string" ? msg.providerId : "";
    if (providerId !== "codex" && providerId !== "claude") return;
    const model = typeof msg.model === "string" ? msg.model : "";
    const reasoningEffort = typeof msg.reasoningEffort === "string" ? msg.reasoningEffort : "";
    let appliedModel = model;
    let appliedReasoningEffort = reasoningEffort;
    let appliedServiceTier: string | null | undefined;

    if (providerId === "codex") {
      const hasServiceTier = Object.prototype.hasOwnProperty.call(msg, "serviceTier");
      const serviceTier = typeof msg.serviceTier === "string" && msg.serviceTier.trim()
        ? msg.serviceTier.trim()
        : null;
      const nextSettings: AiRunSettingsState["codex"] = {
        ...this.runSettings.codex,
        ...(model ? { model } : {}),
        ...(codexReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
        ...(hasServiceTier ? { serviceTier } : {}),
      };
      this.runSettings.codex = nextSettings.models.length > 0
        ? normalizeCodexRunSettings(nextSettings)
        : nextSettings;
      appliedModel = this.runSettings.codex.model;
      appliedReasoningEffort = this.runSettings.codex.reasoningEffort;
      appliedServiceTier = this.runSettings.codex.serviceTier;
    } else {
      this.runSettings.claude = {
        ...this.runSettings.claude,
        ...(typeof msg.model === "string" ? { model } : {}),
        ...(claudeReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
      };
    }

    this.notify("ai-run-settings-update", {
      providerId,
      model: appliedModel,
      reasoningEffort: appliedReasoningEffort,
      ...(providerId === "codex" ? { serviceTier: appliedServiceTier ?? null } : {}),
    });
    void this.pushRunSettingsSnapshot(deviceId);
  }

  private handleAiMessageStop(msg: any, deviceId: string): void {
    const aiSessionId = typeof msg.aiSessionId === "string" ? msg.aiSessionId : "";
    if (!aiSessionId) return;
    const stopped = stopCodexChat(aiSessionId)
      || stopOpenCodeChat(aiSessionId)
      || stopMimoChat(aiSessionId)
      || stopAiChat(aiSessionId);
    if (stopped) {
      updateLocalAiSession(aiSessionId, { status: "completed" });
    }
    this.send({
      type: "ai.message.done",
      deviceId,
      aiSessionId,
      status: "canceled",
      summary: stopped ? "stopped by user" : "no running task",
    });
    this.notify("ai-chat-output", {
      aiSessionId,
      kind: "done",
      text: stopped ? "已终止" : "当前没有正在运行的任务",
      segment: {
        type: "status",
        stepId: "mobile-run-stopped",
        label: stopped ? "已终止" : "未在运行",
        icon: "stop",
        status: "canceled",
      },
    });
    this.notify("ai-history-changed", { aiSessionId });
    void this.pushSessionSnapshot();
    void this.pushAiHistory(aiSessionId);
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
      this.pushSessionSnapshot();
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
    const providerId = getLocalAiSession(aiSessionId)?.providerId;
    if (!isTraceProvider(providerId)) return null;
    const trace = getLocalAiTrace(aiSessionId, traceKindForProvider(providerId));
    if (!trace || trace.providerId !== providerId) return null;
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
        const traceProviderSession = isTraceProviderSession(event.aiSessionId);
        if (event.kind === "status" && event.text === "mobile sent message") return;
        const draft = this.mobileAssistantDrafts.get(event.aiSessionId) ?? { text: "", segments: [], savedText: "" };
        if (event.kind === "delta" && event.text) {
          if (event.stepId) draft.currentStepId = event.stepId;
          if (traceProviderSession && event.phase === "process") {
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
        const traceProviderSession = isTraceProviderSession(event.aiSessionId);
        if (event.kind === "status" && event.text === "mobile sent message") return;
        const draft = this.mobileAssistantDrafts.get(event.aiSessionId) ?? { text: "", segments: [], savedText: "" };
        if (event.kind === "delta" && event.text) {
          if (event.stepId) draft.currentStepId = event.stepId;
          if (traceProviderSession && event.phase === "process") {
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
      const selectedModel = typeof msg.model === "string" ? msg.model.trim() : "";
      const reasoningEffort = typeof msg.reasoningEffort === "string" ? msg.reasoningEffort.trim() : "";
      const hasServiceTier = Object.prototype.hasOwnProperty.call(msg, "serviceTier");
      const serviceTier = typeof msg.serviceTier === "string" && msg.serviceTier.trim()
        ? msg.serviceTier.trim()
        : null;

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
      if (!isTraceProvider(session.providerId)) {
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
            {
              aiSessionId,
              projectPath,
              prompt: content,
              codexModel: selectedModel || null,
              codexReasoningEffort: codexReasoningEffort(reasoningEffort),
              ...(hasServiceTier ? { codexServiceTier: serviceTier } : {}),
            },
            aiChatSender
          );
        } else if (session.providerId === "opencode") {
          providerSessionId = await runOpenCodeChat(
            {
              aiSessionId,
              projectPath,
              prompt: content,
              opencodeModel: selectedModel || null,
              opencodeEffort: reasoningEffort || null,
              opencodeMode: "build",
            },
            aiChatSender,
            session.providerSessionId ?? null,
          );
        } else if (session.providerId === "mimo") {
          providerSessionId = await runMimoChat(
            {
              aiSessionId,
              projectPath,
              prompt: content,
              mimoModel: selectedModel || null,
              mimoVariant: reasoningEffort || null,
              mimoAgent: "build",
            },
            aiChatSender,
            session.providerSessionId ?? null,
          );
        } else {
          providerSessionId = await runAiChat(
            {
              aiSessionId,
              projectPath,
              prompt: content,
              claudeModel: selectedModel || null,
              claudeReasoningEffort: claudeReasoningEffort(reasoningEffort),
            },
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
        this.pushSessionSnapshot();
      }
    } catch (e) {
      console.error("handleAiMessageSend failed:", e);
    }
  }

  private async handleAiApprovalRespond(msg: any, deviceId: string): Promise<void> {
    const aiSessionId = typeof msg.aiSessionId === "string" ? msg.aiSessionId : "";
    const approvalId = typeof msg.approvalId === "string" ? msg.approvalId : "";
    const decision = msg.decision === "approved" || msg.decision === "denied" ? msg.decision : null;
    if (!aiSessionId || !approvalId || !decision) return;
    const ok = respondCodexApproval(aiSessionId, approvalId, decision)
      || await respondMimoApproval(aiSessionId, approvalId, decision);
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
    this.pushSessionSnapshot();
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
    this.pushSessionSnapshot();
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
  return (await fetchJson(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })) as TokenUsageSummary;
}
