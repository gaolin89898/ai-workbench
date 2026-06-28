
import { app, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import type {
  PairResponse,
  DesktopPairingRequest,
  DesktopPairingStatus,
  SavedCloudConfig,
} from "../services/desktop";
import {
  listWorkspaceProjects,
  listLocalAiSessions,
  listLocalAiHistory,
  archiveLocalAiSession,
  createLocalAiSession,
  appendLocalAiMessage,
  getLocalAiSession,
  getWorkspaceProjectByPath,
  addWorkspaceProject,
  updateLocalAiSession,
} from "./db";
import { detectAiProviders } from "./providers";
import { assessCommandRisk } from "./risk";
import { runCodexChat } from "./codex";
import { runAiChat } from "./claude";

// ---------- Cloud config persistence ----------

const STRUCTURED_MESSAGE_PREFIX = "__AI_WORKBENCH_MESSAGE_V1__";
const configPath = path.join(app.getPath("userData"), "cloud-config.json");

interface StoredCloudConfig {
  serverUrl: string;
  deviceId: string;
  accessToken: string;
  paired: boolean;
  authMode?: "desktop-login" | "pairing";
}

function decodeHistoryContent(content: string): string {
  if (!content.startsWith(STRUCTURED_MESSAGE_PREFIX)) return content;
  try {
    const parsed = JSON.parse(content.slice(STRUCTURED_MESSAGE_PREFIX.length));
    return typeof parsed?.text === "string" ? parsed.text : content;
  } catch {
    return content;
  }
}

function loadStoredConfig(): StoredCloudConfig | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as StoredCloudConfig;
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
  authMode: StoredCloudConfig["authMode"]
): void {
  if (!deviceId || !accessToken) return;
  saveStoredConfig({
    serverUrl,
    deviceId,
    accessToken,
    paired: true,
    authMode,
  });
  syncInstance?.restart(serverUrl, accessToken, deviceId);
}

export async function loginDesktop(
  server: string,
  email: string,
  password: string
): Promise<PairResponse> {
  const normalizedServer = normalizeServerUrl(server);
  const url = `${normalizedServer}/desktop/login`;
  const resp = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      name: os.hostname(),
      os: process.platform,
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

  saveCloudConfig(normalizedServer, deviceId, accessToken, "desktop-login");

  return result;
}

export async function pairDesktop(
  server: string,
  code: string
): Promise<PairResponse> {
  const normalizedServer = normalizeServerUrl(server);
  const url = `${normalizedServer}/desktop/pair`;
  const resp = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      name: os.hostname(),
      os: process.platform,
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
  const url = `${normalizedServer}/desktop/pairing-requests`;
  const resp = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: os.hostname(), os: process.platform }),
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
  private stopped = false;
  // Tracks projectPath per session for mobile-originated sessions, since the
  // local DB schema does not store project_path on local_ai_sessions.
  private sessionProjectPaths = new Map<string, string>();

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

  // ----- snapshots: push providers/projects/ai-sessions every 10s -----
  private startSnapshot(deviceId: string): void {
    this.snapshotTimer = setInterval(() => {
      this.pushSnapshots(deviceId);
    }, 10_000);
    // Push immediately on connect.
    this.pushSnapshots(deviceId);
  }

  private pushSnapshots(deviceId: string): void {
    const projects = listWorkspaceProjects();
    const sessions = listLocalAiSessions();
    this.send({ type: "projects.snapshot", deviceId, projects });
    this.send({ type: "ai.sessions.snapshot", deviceId, sessions });
    // Provider detection is async (spawns CLI processes); send when ready.
    detectAiProviders()
      .then((providers) => {
        this.send({ type: "providers.snapshot", deviceId, providers });
      })
      .catch(() => {
        // best-effort — skip this cycle on failure
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
    const sessions = listLocalAiSessions();
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
        this.handleAiHistoryRequest(msg, deviceId);
        break;
      case "ai.session.archive":
        this.handleAiSessionArchive(msg, deviceId);
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
      if (!getWorkspaceProjectByPath(project.path)) {
        await addWorkspaceProject(project.path);
      }
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

      if (projectPath) {
        this.sessionProjectPaths.set(aiSessionId, projectPath);
        // Best-effort: register the workspace project so it appears in lists.
        try {
          if (!getWorkspaceProjectByPath(projectPath)) {
            await addWorkspaceProject(projectPath);
          }
        } catch {
          // project may not exist or git may be unavailable — ignore
        }
      }

      if (!getLocalAiSession(aiSessionId)) {
        createLocalAiSession({
          id: aiSessionId,
          providerId: providerId || "claude",
          terminalSessionId: terminalSessionId ?? null,
          title: title || "Mobile session",
          status: "idle",
          summary: projectPath ?? null,
        });
      }

      this.notify("ai-chat-output", { aiSessionId, kind: "status", text: "created" });
      this.notify("workspace-changed");
      this.notify("ai-history-changed", { aiSessionId });
    } catch (e) {
      console.error("handleAiSessionCreate failed:", e);
    }
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

      appendLocalAiMessage(aiSessionId, "user", content);

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
      this.notify("ai-chat-output", {
        aiSessionId,
        kind: "status",
        text: "mobile sent message",
      });

      try {
        let providerSessionId: string | null = null;
        if (session.providerId === "codex") {
          providerSessionId = await runCodexChat(
            { aiSessionId, projectPath, prompt: content },
            this.mainWindow.webContents
          );
        } else {
          providerSessionId = await runAiChat(
            { aiSessionId, projectPath, prompt: content },
            this.mainWindow.webContents,
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

  /** ai.history.request: reply with the local message history. */
  private handleAiHistoryRequest(msg: any, deviceId: string): void {
    const aiSessionId: string = msg.aiSessionId;
    const requestId: string = msg.requestId;
    const messages = listLocalAiHistory(aiSessionId).map((message) => ({
      ...message,
      content: decodeHistoryContent(message.content),
    }));
    this.send({
      type: "ai.history.response",
      deviceId,
      aiSessionId,
      requestId,
      messages,
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
