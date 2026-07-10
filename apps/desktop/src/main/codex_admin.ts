import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as os from "node:os";
import { createInterface, type Interface } from "node:readline";
import type {
  CodexAdminEvent,
  CodexConfigBatchWriteRequest,
  CodexConfigLayer,
  CodexConfigOrigin,
  CodexConfigSnapshot,
  CodexConfigWriteRequest,
  CodexConfigWriteResult,
  CodexFeature,
  CodexFeatureSetRequest,
  CodexMcpOauthRequest,
  CodexMcpOauthResponse,
  CodexMcpResourceContent,
  CodexMcpResourceReadRequest,
  CodexMcpServer,
  CodexNativeThread,
  CodexNativeThreadItem,
  CodexNativeThreadStatus,
  CodexNativeTurn,
  CodexThreadListRequest,
  CodexThreadListResponse,
  CodexThreadReadRequest,
  CodexThreadRenameRequest,
} from "../services/desktop";
import { spawnCodexAppServerProcess } from "./codex";

type Sender = {
  send: (channel: string, ...args: unknown[]) => void;
  isDestroyed?: () => boolean;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type McpRuntimeStatus = {
  startupStatus: CodexMcpServer["startupStatus"];
  error: string | null;
  failureReason: string | null;
};

const ADMIN_REQUEST_TIMEOUT_MS = 45_000;
const ADMIN_CLIENT_INFO = { name: "CodeHub AI Management", version: "0.1.0" };

let adminClient: CodexAdminClient | null = null;
let adminClientPromise: Promise<CodexAdminClient> | null = null;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function safeJson(value: unknown, maxLength = 40_000): string {
  let output: string;
  try {
    output = JSON.stringify(value, null, 2);
  } catch {
    output = String(value);
  }
  return output.length > maxLength ? `${output.slice(0, maxLength)}\n...内容已截断` : output;
}

function statusFrom(value: unknown): CodexNativeThreadStatus {
  const status = record(value);
  const type = status.type;
  return {
    type: type === "idle" || type === "systemError" || type === "active" ? type : "notLoaded",
    activeFlags: stringArray(status.activeFlags),
  };
}

function sourceLabel(value: unknown): string {
  if (typeof value === "string") return value;
  const source = record(value);
  if (typeof source.custom === "string") return source.custom;
  if (source.subAgent) return "subAgent";
  return "unknown";
}

function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const item = record(entry);
    const text = stringValue(item.text) ?? stringValue(item.value) ?? stringValue(item.content);
    if (text) return [text];
    if (item.type === "image" || item.type === "localImage") return ["[图片]"];
    return [];
  }).join("\n");
}

function threadItemText(item: Record<string, unknown>): string | null {
  const direct = stringValue(item.text)
    ?? stringValue(item.message)
    ?? stringValue(item.command)
    ?? stringValue(item.query);
  if (direct) return direct;
  const error = stringValue(record(item.error).message);
  if (error) return error;
  const content = textFromContent(item.content);
  if (content) return content;
  const summary = textFromContent(item.summary);
  if (summary) return summary;
  if (Array.isArray(item.changes)) {
    return item.changes.flatMap((change) => {
      const path = stringValue(record(change).path);
      return path ? [path] : [];
    }).join("\n") || null;
  }
  return null;
}

function threadItemTitle(item: Record<string, unknown>): string {
  const type = stringValue(item.type) ?? "unknown";
  if (type === "userMessage") return "用户消息";
  if (type === "agentMessage") return "Codex 回复";
  if (type === "reasoning") return "思考过程";
  if (type === "commandExecution") return stringValue(item.command) ?? "命令执行";
  if (type === "fileChange") return "文件修改";
  if (type === "mcpToolCall") {
    const server = stringValue(item.server);
    const tool = stringValue(item.tool);
    return [server, tool].filter(Boolean).join(" / ") || "MCP 工具调用";
  }
  if (type === "dynamicToolCall") return stringValue(item.tool) ?? "动态工具调用";
  if (type === "webSearch") return "网页搜索";
  if (type === "plan") return "执行计划";
  return type;
}

function mapThreadItem(value: unknown, index: number): CodexNativeThreadItem {
  const item = record(value);
  return {
    id: stringValue(item.id) ?? `item-${index}`,
    type: stringValue(item.type) ?? "unknown",
    title: threadItemTitle(item),
    status: stringValue(item.status),
    text: threadItemText(item),
    detail: safeJson(item),
    durationMs: numberValue(item.durationMs),
  };
}

function mapTurn(value: unknown): CodexNativeTurn {
  const turn = record(value);
  const error = record(turn.error);
  return {
    id: stringValue(turn.id) ?? "",
    status: stringValue(turn.status) ?? "completed",
    startedAt: numberValue(turn.startedAt),
    completedAt: numberValue(turn.completedAt),
    durationMs: numberValue(turn.durationMs),
    error: stringValue(error.message) ?? (turn.error ? safeJson(turn.error, 4_000) : null),
    items: Array.isArray(turn.items) ? turn.items.map(mapThreadItem) : [],
  };
}

function mapThread(value: unknown, archived: boolean): CodexNativeThread {
  const thread = record(value);
  return {
    id: stringValue(thread.id) ?? "",
    sessionId: stringValue(thread.sessionId) ?? "",
    forkedFromId: stringValue(thread.forkedFromId),
    parentThreadId: stringValue(thread.parentThreadId),
    name: stringValue(thread.name),
    preview: stringValue(thread.preview) ?? "",
    cwd: stringValue(thread.cwd) ?? "",
    modelProvider: stringValue(thread.modelProvider) ?? "unknown",
    cliVersion: stringValue(thread.cliVersion) ?? "",
    source: sourceLabel(thread.source),
    createdAt: numberValue(thread.createdAt) ?? 0,
    updatedAt: numberValue(thread.updatedAt) ?? 0,
    recencyAt: numberValue(thread.recencyAt),
    archived,
    status: statusFrom(thread.status),
    turns: Array.isArray(thread.turns) ? thread.turns.map(mapTurn) : [],
  };
}

function layerSource(value: unknown): CodexConfigOrigin {
  const source = record(value);
  const type = stringValue(source.type) ?? "unknown";
  if (type === "user") {
    const profile = stringValue(source.profile);
    return { type, label: profile ? `用户配置 · ${profile}` : "用户配置", version: "", path: stringValue(source.file) };
  }
  if (type === "project") return { type, label: "项目配置", version: "", path: stringValue(source.dotCodexFolder) };
  if (type === "system") return { type, label: "系统配置", version: "", path: stringValue(source.file) };
  if (type === "enterpriseManaged") return { type, label: stringValue(source.name) ?? "企业配置", version: "" };
  if (type === "mdm") return { type, label: `MDM · ${stringValue(source.domain) ?? "managed"}`, version: "" };
  if (type === "sessionFlags") return { type, label: "本次会话参数", version: "" };
  return { type, label: type, version: "" };
}

function mapConfigOrigin(value: unknown): CodexConfigOrigin {
  const metadata = record(value);
  return {
    ...layerSource(metadata.name),
    version: stringValue(metadata.version) ?? "",
  };
}

function mapConfigWriteResult(value: unknown): CodexConfigWriteResult {
  const result = record(value);
  const overridden = record(result.overriddenMetadata);
  return {
    status: stringValue(result.status) ?? "ok",
    version: stringValue(result.version) ?? "",
    filePath: stringValue(result.filePath) ?? "",
    overriddenMessage: stringValue(overridden.message),
    effectiveValue: overridden.effectiveValue,
  };
}

class CodexAdminClient {
  private child: ChildProcessWithoutNullStreams;
  private rl: Interface;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private senders = new Set<Sender>();
  private stderr = "";
  private closed = false;
  private mcpRuntime = new Map<string, McpRuntimeStatus>();

  constructor(cwd: string) {
    this.child = spawnCodexAppServerProcess(cwd || os.homedir());
    this.rl = createInterface({ input: this.child.stdout, terminal: false });
    this.rl.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.stdin.on("error", () => undefined);
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.fail(new Error(this.stderr.trim() || `Codex management app-server exited: code=${code} signal=${signal}`));
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  addSender(sender?: Sender): void {
    if (sender) this.senders.add(sender);
  }

  getMcpRuntime(name: string): McpRuntimeStatus | null {
    return this.mcpRuntime.get(name) ?? null;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: ADMIN_CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = ADMIN_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex 管理连接已关闭"));
    const id = this.nextRequestId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时${this.stderr.trim() ? `：${this.stderr.trim().slice(-500)}` : ""}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Codex 管理连接已关闭");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try { this.rl.close(); } catch { /* ignore */ }
    try { this.child.stdin.end(); } catch { /* ignore */ }
    try { this.child.kill(); } catch { /* ignore */ }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const msg = record(message);
    if ((typeof msg.id === "number" || typeof msg.id === "string") && typeof msg.method === "string") {
      try {
        this.child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `Unsupported management request: ${msg.method}` },
        })}\n`);
      } catch {
        // connection failure is handled by the child process event
      }
      return;
    }
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        const error = record(msg.error);
        const errorMessage = stringValue(error.message);
        if (errorMessage) pending.reject(new Error(errorMessage));
        else pending.resolve(msg.result);
      }
    }
    if (typeof msg.method === "string") this.handleNotification(msg.method, msg.params);
  }

  private handleNotification(method: string, value: unknown): void {
    const params = record(value);
    let event: CodexAdminEvent | null = null;
    if (method === "thread/status/changed") {
      const threadId = stringValue(params.threadId);
      if (threadId) event = { type: "thread-status", threadId, status: statusFrom(params.status) };
    } else if (method === "thread/name/updated") {
      const threadId = stringValue(params.threadId);
      if (threadId) event = { type: "thread-name", threadId, name: stringValue(params.threadName) };
    } else if (method === "mcpServer/startupStatus/updated") {
      const name = stringValue(params.name);
      const rawStatus = stringValue(params.status);
      if (name && (rawStatus === "starting" || rawStatus === "ready" || rawStatus === "failed" || rawStatus === "cancelled")) {
        const runtime = {
          startupStatus: rawStatus,
          error: stringValue(params.error),
          failureReason: stringValue(params.failureReason),
        } satisfies McpRuntimeStatus;
        this.mcpRuntime.set(name, runtime);
        event = { type: "mcp-status", name, ...runtime };
      }
    } else if (method === "mcpServer/oauthLogin/completed") {
      const name = stringValue(params.name);
      if (name) {
        event = {
          type: "mcp-oauth",
          name,
          success: params.success === true,
          error: stringValue(params.error),
        };
      }
    }
    if (event) this.broadcast(event);
  }

  private broadcast(event: CodexAdminEvent): void {
    for (const sender of [...this.senders]) {
      if (sender.isDestroyed?.()) {
        this.senders.delete(sender);
        continue;
      }
      try {
        sender.send("codex-admin-event", event);
      } catch {
        this.senders.delete(sender);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (adminClient === this) adminClient = null;
    adminClientPromise = null;
  }
}

async function getAdminClient(sender?: Sender): Promise<CodexAdminClient> {
  if (adminClient && !adminClient.isClosed()) {
    adminClient.addSender(sender);
    return adminClient;
  }
  if (!adminClientPromise) {
    adminClientPromise = (async () => {
      // Management APIs use the user's global Codex context. Project-specific
      // thread and config calls pass cwd explicitly in their request params.
      const client = new CodexAdminClient(os.homedir());
      try {
        await client.initialize();
        adminClient = client;
        return client;
      } catch (error) {
        client.close();
        throw error;
      } finally {
        adminClientPromise = null;
      }
    })();
  }
  const client = await adminClientPromise;
  client.addSender(sender);
  return client;
}

export async function listCodexThreads(
  request: CodexThreadListRequest,
  sender?: Sender,
): Promise<CodexThreadListResponse> {
  const client = await getAdminClient(sender);
  const params: Record<string, unknown> = {
    cursor: request.cursor ?? null,
    limit: Math.min(100, Math.max(1, request.limit ?? 30)),
    sortKey: "updated_at",
    sortDirection: "desc",
    archived: request.archived ?? false,
  };
  if (request.searchTerm?.trim()) params.searchTerm = request.searchTerm.trim();
  if (request.cwd?.trim()) params.cwd = request.cwd.trim();
  const response = record(await client.request("thread/list", params));
  const archived = request.archived ?? false;
  return {
    data: Array.isArray(response.data) ? response.data.map((thread) => mapThread(thread, archived)) : [],
    nextCursor: stringValue(response.nextCursor),
  };
}

export async function readCodexThread(
  request: CodexThreadReadRequest,
  sender?: Sender,
): Promise<CodexNativeThread> {
  const client = await getAdminClient(sender);
  const response = record(await client.request("thread/read", {
    threadId: request.threadId,
    includeTurns: true,
  }));
  return mapThread(response.thread, request.archived ?? false);
}

export async function renameCodexThread(
  request: CodexThreadRenameRequest,
  sender?: Sender,
): Promise<boolean> {
  const name = request.name.trim();
  if (!request.threadId || !name) throw new Error("Thread ID 和名称不能为空");
  const client = await getAdminClient(sender);
  await client.request("thread/name/set", { threadId: request.threadId, name });
  return true;
}

function mapMcpServer(value: unknown, client: CodexAdminClient): CodexMcpServer {
  const server = record(value);
  const info = record(server.serverInfo);
  const runtime = client.getMcpRuntime(stringValue(server.name) ?? "");
  const tools = record(server.tools);
  return {
    name: stringValue(server.name) ?? "",
    displayName: stringValue(info.title) ?? stringValue(info.name) ?? stringValue(server.name) ?? "MCP Server",
    version: stringValue(info.version),
    description: stringValue(info.description),
    websiteUrl: stringValue(info.websiteUrl),
    authStatus: stringValue(server.authStatus) ?? "unsupported",
    startupStatus: runtime?.startupStatus ?? (server.serverInfo ? "ready" : "unknown"),
    error: runtime?.error ?? null,
    failureReason: runtime?.failureReason ?? null,
    tools: Object.entries(tools).map(([key, value]) => {
      const tool = record(value);
      return {
        name: stringValue(tool.name) ?? key,
        title: stringValue(tool.title),
        description: stringValue(tool.description),
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      };
    }),
    resources: Array.isArray(server.resources) ? server.resources.map((value) => {
      const resource = record(value);
      return {
        uri: stringValue(resource.uri) ?? "",
        name: stringValue(resource.name) ?? stringValue(resource.uri) ?? "resource",
        title: stringValue(resource.title),
        description: stringValue(resource.description),
        mimeType: stringValue(resource.mimeType),
        size: numberValue(resource.size),
      };
    }) : [],
    resourceTemplates: Array.isArray(server.resourceTemplates) ? server.resourceTemplates.map((value) => {
      const template = record(value);
      return {
        uriTemplate: stringValue(template.uriTemplate) ?? "",
        name: stringValue(template.name) ?? stringValue(template.uriTemplate) ?? "template",
        title: stringValue(template.title),
        description: stringValue(template.description),
        mimeType: stringValue(template.mimeType),
      };
    }) : [],
  };
}

export async function listCodexMcpServers(sender?: Sender): Promise<CodexMcpServer[]> {
  const client = await getAdminClient(sender);
  const servers: CodexMcpServer[] = [];
  let cursor: string | null = null;
  do {
    const response = record(await client.request("mcpServerStatus/list", {
      cursor,
      limit: 100,
      detail: "full",
    }, 90_000));
    if (Array.isArray(response.data)) servers.push(...response.data.map((server) => mapMcpServer(server, client)));
    cursor = stringValue(response.nextCursor);
  } while (cursor);
  return servers.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
}

export async function readCodexMcpResource(
  request: CodexMcpResourceReadRequest,
  sender?: Sender,
): Promise<CodexMcpResourceContent[]> {
  if (!request.server || !request.uri) throw new Error("MCP Server 和资源 URI 不能为空");
  const client = await getAdminClient(sender);
  const response = record(await client.request("mcpServer/resource/read", {
    server: request.server,
    uri: request.uri,
    threadId: request.threadId ?? null,
  }, 90_000));
  return Array.isArray(response.contents) ? response.contents.map((value) => {
    const content = record(value);
    return {
      uri: stringValue(content.uri) ?? request.uri,
      mimeType: stringValue(content.mimeType),
      text: stringValue(content.text),
      blob: stringValue(content.blob),
    };
  }) : [];
}

export async function startCodexMcpOauth(
  request: CodexMcpOauthRequest,
  sender?: Sender,
): Promise<CodexMcpOauthResponse> {
  if (!request.name) throw new Error("MCP Server 名称不能为空");
  const client = await getAdminClient(sender);
  const response = record(await client.request("mcpServer/oauth/login", {
    name: request.name,
    threadId: request.threadId ?? null,
    scopes: request.scopes ?? null,
  }, 90_000));
  const authorizationUrl = stringValue(response.authorizationUrl);
  if (!authorizationUrl) throw new Error("MCP Server 未返回 OAuth 授权地址");
  return { authorizationUrl };
}

export async function reloadCodexMcpServers(sender?: Sender): Promise<CodexMcpServer[]> {
  const client = await getAdminClient(sender);
  await client.request("config/mcpServer/reload", undefined, 90_000);
  return listCodexMcpServers(sender);
}

export async function readCodexConfig(cwd?: string | null, sender?: Sender): Promise<CodexConfigSnapshot> {
  const client = await getAdminClient(sender);
  const response = record(await client.request("config/read", {
    includeLayers: true,
    cwd: cwd?.trim() || null,
  }));
  const origins: Record<string, CodexConfigOrigin> = {};
  for (const [key, value] of Object.entries(record(response.origins))) origins[key] = mapConfigOrigin(value);
  const layers: CodexConfigLayer[] = Array.isArray(response.layers) ? response.layers.map((value) => {
    const layer = record(value);
    const origin = layerSource(layer.name);
    return {
      ...origin,
      version: stringValue(layer.version) ?? "",
      disabledReason: stringValue(layer.disabledReason),
      config: layer.config ?? {},
    };
  }) : [];
  const userLayer = layers.find((layer) => layer.type === "user" && !layer.label.includes(" · "))
    ?? layers.find((layer) => layer.type === "user");
  return {
    config: record(response.config),
    origins,
    layers,
    userConfigPath: userLayer?.path ?? null,
    userConfigVersion: userLayer?.version ?? null,
  };
}

export async function writeCodexConfigValue(
  request: CodexConfigWriteRequest,
  sender?: Sender,
): Promise<CodexConfigWriteResult> {
  const keyPath = request.keyPath.trim();
  if (!keyPath) throw new Error("配置键不能为空");
  const client = await getAdminClient(sender);
  const response = await client.request("config/value/write", {
    keyPath,
    value: request.value,
    mergeStrategy: request.mergeStrategy ?? "replace",
    filePath: request.filePath ?? null,
    expectedVersion: request.expectedVersion ?? null,
  });
  return mapConfigWriteResult(response);
}

export async function batchWriteCodexConfig(
  request: CodexConfigBatchWriteRequest,
  sender?: Sender,
): Promise<CodexConfigWriteResult> {
  const edits = request.edits
    .map((edit) => ({
      keyPath: edit.keyPath.trim(),
      value: edit.value,
      mergeStrategy: edit.mergeStrategy ?? "replace",
    }))
    .filter((edit) => edit.keyPath);
  if (!edits.length) throw new Error("至少需要一个配置修改项");
  const client = await getAdminClient(sender);
  const response = await client.request("config/batchWrite", {
    edits,
    filePath: request.filePath ?? null,
    expectedVersion: request.expectedVersion ?? null,
    reloadUserConfig: true,
  });
  return mapConfigWriteResult(response);
}

export async function listCodexFeatures(sender?: Sender): Promise<CodexFeature[]> {
  const client = await getAdminClient(sender);
  const features: CodexFeature[] = [];
  let cursor: string | null = null;
  do {
    const response = record(await client.request("experimentalFeature/list", { cursor, limit: 100 }));
    if (Array.isArray(response.data)) {
      features.push(...response.data.map((value) => {
        const feature = record(value);
        return {
          name: stringValue(feature.name) ?? "",
          stage: stringValue(feature.stage) ?? "underDevelopment",
          displayName: stringValue(feature.displayName),
          description: stringValue(feature.description),
          announcement: stringValue(feature.announcement),
          enabled: feature.enabled === true,
          defaultEnabled: feature.defaultEnabled === true,
        };
      }));
    }
    cursor = stringValue(response.nextCursor);
  } while (cursor);
  return features.filter((feature) => feature.name).sort((left, right) => left.name.localeCompare(right.name));
}

export async function setCodexFeature(
  request: CodexFeatureSetRequest,
  sender?: Sender,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_.-]+$/.test(request.name)) throw new Error("功能开关键格式无效");
  const client = await getAdminClient(sender);
  if (request.persist !== false) {
    await client.request("config/value/write", {
      keyPath: `features.${request.name}`,
      value: request.enabled,
      mergeStrategy: "replace",
      filePath: null,
      expectedVersion: null,
    });
  }
  try {
    await client.request("experimentalFeature/enablement/set", {
      enablement: { [request.name]: request.enabled },
    });
  } catch (error) {
    if (request.persist === false) throw error;
  }
  return true;
}

export function disposeCodexAdmin(): void {
  adminClient?.close();
  adminClient = null;
  adminClientPromise = null;
}
