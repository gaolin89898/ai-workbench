<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  desktopApi,
  type CodexAdminEvent,
  type CodexConfigLayer,
  type CodexConfigOrigin,
  type CodexConfigSnapshot,
  type CodexFeature,
  type CodexMcpResource,
  type CodexMcpResourceContent,
  type CodexMcpResourceTemplate,
  type CodexMcpServer,
  type CodexMcpTool,
  type CodexNativeThread,
} from "../services/desktop";

const props = withDefaults(defineProps<{
  cwd?: string | null;
  mode?: "codex" | "mcp";
}>(), {
  cwd: null,
  mode: "codex",
});

type AdminTab = "threads" | "mcp" | "config";
type ThreadScope = "project" | "all";
type McpInventoryTab = "tools" | "resources" | "templates";
type ConfigView = "effective" | "layers" | "features";
type DescriptionLanguage = "zh" | "en";

type ConfigEntry = {
  keyPath: string;
  value: unknown;
  origin: CodexConfigOrigin | null;
};

type BatchRow = {
  id: number;
  keyPath: string;
  valueText: string;
  mergeStrategy: "replace" | "upsert";
};

const storedTab = window.localStorage.getItem("ai-workbench.codexAdminTab");
const activeTab = ref<AdminTab>(props.mode === "mcp" ? "mcp" : storedTab === "config" ? "config" : "threads");
const showAdvanced = ref(window.localStorage.getItem("ai-workbench.codexAdminAdvanced") === "true");
const descriptionLanguage = ref<DescriptionLanguage>(
  window.localStorage.getItem("ai-workbench.mcpDescriptionLanguage") === "en" ? "en" : "zh",
);
const notice = ref("");
const noticeError = ref(false);

const threads = ref<CodexNativeThread[]>([]);
const threadCursor = ref<string | null>(null);
const threadLoading = ref(false);
const threadLoadingMore = ref(false);
const threadLoaded = ref(false);
const threadError = ref("");
const threadSearch = ref("");
const threadArchived = ref(false);
const threadScope = ref<ThreadScope>(props.cwd ? "project" : "all");
const selectedThreadId = ref("");
const selectedThread = ref<CodexNativeThread | null>(null);
const threadDetailLoading = ref(false);
const threadRenameBusy = ref(false);
const threadNameDraft = ref("");
let threadSearchTimer: ReturnType<typeof setTimeout> | null = null;
let threadRequestVersion = 0;

const mcpServers = ref<CodexMcpServer[]>([]);
const mcpLoaded = ref(false);
const mcpLoading = ref(false);
const mcpReloading = ref(false);
const mcpError = ref("");
const selectedMcpName = ref("");
const mcpSearch = ref("");
const mcpInventoryTab = ref<McpInventoryTab>("tools");
const selectedToolName = ref("");
const selectedResourceUri = ref("");
const selectedTemplateUri = ref("");
const resourceLoading = ref(false);
const resourceContents = ref<CodexMcpResourceContent[]>([]);
const oauthBusyName = ref("");

const configSnapshot = ref<CodexConfigSnapshot | null>(null);
const features = ref<CodexFeature[]>([]);
const configLoaded = ref(false);
const configLoading = ref(false);
const configError = ref("");
const featuresError = ref("");
const configView = ref<ConfigView>("effective");
const configSearch = ref("");
const featureSearch = ref("");
const selectedConfigKey = ref("");
const configKeyDraft = ref("");
const configValueDraft = ref("");
const configWriteBusy = ref(false);
const selectedLayerIndex = ref(0);
const featureBusy = ref<Record<string, boolean>>({});
const batchRows = ref<BatchRow[]>([]);
let nextBatchRowId = 1;

let unsubscribeAdminEvent: (() => void) | null = null;
let disposed = false;

const MCP_TOOL_DESCRIPTION_ZH: Record<string, string> = {
  get_openapi_spec: "获取指定 API 端点的 OpenAPI 规范。可按语言筛选代码示例，也可以只返回代码示例。",
  "Get OpenAPI Spec": "获取指定 API 端点的 OpenAPI 规范。可按语言筛选代码示例，也可以只返回代码示例。",
  search_openai_docs: "搜索 OpenAI 官方开发者文档，并返回相关页面和匹配内容。",
  "Search OpenAI Docs": "搜索 OpenAI 官方开发者文档，并返回相关页面和匹配内容。",
  fetch_openai_doc: "读取指定 OpenAI 文档页面的 Markdown 内容，可定位到具体章节。",
  "Fetch OpenAI Doc": "读取指定 OpenAI 文档页面的 Markdown 内容，可定位到具体章节。",
  list_openai_docs: "列出 OpenAI 官方开发者文档页面，支持按目录和分页浏览。",
  "List OpenAI Docs": "列出 OpenAI 官方开发者文档页面，支持按目录和分页浏览。",
  list_api_endpoints: "列出 OpenAI API 端点及其 URL。",
  "List API Endpoints": "列出 OpenAI API 端点及其 URL。",
  js: "在持久化的 Node.js 环境中运行 JavaScript，支持顶层 await。",
  js_reset: "重置持久化 JavaScript 环境并清除已有状态。",
  js_add_node_module_dir: "添加 Node.js 模块目录，使其中的依赖可以在运行环境中导入。",
};

const selectedMcp = computed(() =>
  mcpServers.value.find((server) => server.name === selectedMcpName.value) ?? null,
);

const selectedTool = computed<CodexMcpTool | null>(() =>
  selectedMcp.value?.tools.find((tool) => tool.name === selectedToolName.value) ?? null,
);

const selectedResource = computed<CodexMcpResource | null>(() =>
  selectedMcp.value?.resources.find((resource) => resource.uri === selectedResourceUri.value) ?? null,
);

const selectedTemplate = computed<CodexMcpResourceTemplate | null>(() =>
  selectedMcp.value?.resourceTemplates.find((template) => template.uriTemplate === selectedTemplateUri.value) ?? null,
);

const mcpSummary = computed(() => ({
  servers: mcpServers.value.length,
  ready: mcpServers.value.filter((server) => server.startupStatus === "ready").length,
  tools: mcpServers.value.reduce((sum, server) => sum + server.tools.length, 0),
  resources: mcpServers.value.reduce((sum, server) => sum + server.resources.length, 0),
  authRequired: mcpServers.value.filter((server) => server.authStatus === "notLoggedIn").length,
}));

const filteredMcpServers = computed(() => {
  const query = mcpSearch.value.trim().toLocaleLowerCase();
  if (!query) return mcpServers.value;
  return mcpServers.value.filter((server) =>
    `${server.displayName} ${server.name} ${server.description}`.toLocaleLowerCase().includes(query),
  );
});

const commonConfigKeys = new Set([
  "model",
  "model_provider",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
  "approval_policy",
  "sandbox_mode",
  "web_search",
  "instructions",
]);

const allConfigEntries = computed<ConfigEntry[]>(() => {
  const snapshot = configSnapshot.value;
  if (!snapshot) return [];
  return flattenConfig(snapshot.config).map(({ keyPath, value }) => ({
    keyPath,
    value,
    origin: originForKey(snapshot, keyPath),
  })).sort((left, right) => left.keyPath.localeCompare(right.keyPath));
});

const configEntries = computed<ConfigEntry[]>(() => {
  const entries = showAdvanced.value
    ? allConfigEntries.value
    : allConfigEntries.value.filter((entry) => commonConfigKeys.has(entry.keyPath));
  const query = configSearch.value.trim().toLocaleLowerCase();
  return (query
    ? entries.filter((entry) => {
      const origin = entry.origin?.label ?? "";
      return `${entry.keyPath} ${origin} ${previewValue(entry.value)}`.toLocaleLowerCase().includes(query);
    })
    : entries);
});

const selectedLayer = computed<CodexConfigLayer | null>(() =>
  configSnapshot.value?.layers[selectedLayerIndex.value] ?? null,
);

const selectedConfigOriginLabel = computed(() => {
  const snapshot = configSnapshot.value;
  if (!snapshot || !selectedConfigKey.value) return "默认值";
  return originForKey(snapshot, selectedConfigKey.value)?.label ?? "默认值";
});

const visibleFeatures = computed(() => {
  const query = featureSearch.value.trim().toLocaleLowerCase();
  const available = showAdvanced.value
    ? features.value
    : features.value.filter((feature) => feature.stage === "beta" || Boolean(feature.displayName || feature.description));
  return available.filter((feature) => {
    if (!query) return true;
    return `${feature.name} ${feature.displayName ?? ""} ${feature.description ?? ""} ${feature.stage}`
      .toLocaleLowerCase()
      .includes(query);
  });
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setDescriptionLanguage(language: DescriptionLanguage): void {
  descriptionLanguage.value = language;
  window.localStorage.setItem("ai-workbench.mcpDescriptionLanguage", language);
}

function toolDescription(tool: CodexMcpTool): string {
  if (descriptionLanguage.value === "en") return tool.description || tool.name;
  return MCP_TOOL_DESCRIPTION_ZH[tool.name]
    ?? (tool.title ? MCP_TOOL_DESCRIPTION_ZH[tool.title] : undefined)
    ?? tool.description
    ?? tool.name;
}

function showNotice(message: string, isError = false): void {
  notice.value = message;
  noticeError.value = isError;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value;
  const text = jsonText(value).replace(/\s+/g, " ");
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function flattenConfig(value: Record<string, unknown>): Array<{ keyPath: string; value: unknown }> {
  const output: Array<{ keyPath: string; value: unknown }> = [];
  const visit = (current: unknown, path: string) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length) {
        for (const [key, child] of entries) visit(child, path ? `${path}.${key}` : key);
        return;
      }
    }
    if (path) output.push({ keyPath: path, value: current });
  };
  visit(value, "");
  return output;
}

function originForKey(snapshot: CodexConfigSnapshot, keyPath: string): CodexConfigOrigin | null {
  let candidate = keyPath;
  while (candidate) {
    if (snapshot.origins[candidate]) return snapshot.origins[candidate];
    const separator = candidate.lastIndexOf(".");
    if (separator < 0) break;
    candidate = candidate.slice(0, separator);
  }
  return null;
}

function timestampMs(value: number): number {
  return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
}

function formatDate(value?: number | null): string {
  if (!value) return "时间未知";
  const date = new Date(timestampMs(value));
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(value?: number | null): string {
  if (value === null || value === undefined) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function compactPath(value: string): string {
  if (!value) return "未记录工作目录";
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : value;
}

function threadTitle(thread: CodexNativeThread): string {
  return thread.name?.trim() || thread.preview.trim().split(/\r?\n/)[0] || "未命名会话";
}

function threadStatusLabel(thread: CodexNativeThread): string {
  if (thread.status.type === "active") return "运行中";
  if (thread.status.type === "idle") return "空闲";
  if (thread.status.type === "systemError") return "异常";
  return "未加载";
}

function threadStatusTone(thread: CodexNativeThread): string {
  if (thread.status.type === "active") return "active";
  if (thread.status.type === "idle") return "ready";
  if (thread.status.type === "systemError") return "error";
  return "muted";
}

async function loadThreads(reset = true): Promise<void> {
  if (!reset && (threadLoadingMore.value || !threadCursor.value)) return;
  const requestVersion = ++threadRequestVersion;
  if (reset) {
    threadLoading.value = true;
    threadError.value = "";
  } else {
    threadLoadingMore.value = true;
  }
  try {
    const response = await desktopApi.listCodexThreads({
      cursor: reset ? null : threadCursor.value,
      limit: 30,
      searchTerm: threadSearch.value.trim() || null,
      archived: threadArchived.value,
      cwd: threadScope.value === "project" ? props.cwd?.trim() || null : null,
    });
    if (requestVersion !== threadRequestVersion) return;
    threads.value = reset ? response.data : [...threads.value, ...response.data];
    threadCursor.value = response.nextCursor;
    threadLoaded.value = true;
    if (reset) {
      const stillVisible = threads.value.some((thread) => thread.id === selectedThreadId.value);
      if (!stillVisible) {
        selectedThreadId.value = "";
        selectedThread.value = null;
      }
    }
  } catch (error) {
    if (requestVersion === threadRequestVersion) threadError.value = errorText(error);
  } finally {
    if (requestVersion === threadRequestVersion) {
      threadLoading.value = false;
      threadLoadingMore.value = false;
    }
  }
}

function scheduleThreadSearch(): void {
  if (threadSearchTimer) clearTimeout(threadSearchTimer);
  threadSearchTimer = setTimeout(() => void loadThreads(true), 280);
}

async function selectThread(thread: CodexNativeThread): Promise<void> {
  selectedThreadId.value = thread.id;
  selectedThread.value = thread;
  threadNameDraft.value = thread.name || threadTitle(thread);
  threadDetailLoading.value = true;
  threadError.value = "";
  try {
    const detail = await desktopApi.readCodexThread({ threadId: thread.id, archived: thread.archived });
    if (selectedThreadId.value !== thread.id) return;
    selectedThread.value = detail;
    threadNameDraft.value = detail.name || threadTitle(detail);
  } catch (error) {
    if (selectedThreadId.value === thread.id) threadError.value = errorText(error);
  } finally {
    if (selectedThreadId.value === thread.id) threadDetailLoading.value = false;
  }
}

async function renameSelectedThread(): Promise<void> {
  const thread = selectedThread.value;
  const name = threadNameDraft.value.trim();
  if (!thread || !name || threadRenameBusy.value) return;
  threadRenameBusy.value = true;
  try {
    await desktopApi.renameCodexThread({ threadId: thread.id, name });
    selectedThread.value = { ...thread, name };
    threads.value = threads.value.map((item) => item.id === thread.id ? { ...item, name } : item);
    showNotice("会话名称已更新");
  } catch (error) {
    showNotice(`改名失败：${errorText(error)}`, true);
  } finally {
    threadRenameBusy.value = false;
  }
}

function mcpStatusLabel(server: CodexMcpServer): string {
  if (server.startupStatus === "ready") return "就绪";
  if (server.startupStatus === "starting") return "启动中";
  if (server.startupStatus === "failed") return "启动失败";
  if (server.startupStatus === "cancelled") return "已取消";
  return "状态未知";
}

function mcpAuthLabel(server: CodexMcpServer): string {
  if (server.authStatus === "oAuth") return "OAuth 已登录";
  if (server.authStatus === "bearerToken") return "Token 已配置";
  if (server.authStatus === "notLoggedIn") return "需要登录";
  return "无需认证";
}

function selectMcpServer(server: CodexMcpServer): void {
  selectedMcpName.value = server.name;
  selectedToolName.value = server.tools[0]?.name ?? "";
  selectedResourceUri.value = server.resources[0]?.uri ?? "";
  selectedTemplateUri.value = server.resourceTemplates[0]?.uriTemplate ?? "";
  resourceContents.value = [];
  if (!showAdvanced.value) mcpInventoryTab.value = "tools";
  else if (!server.tools.length && server.resources.length) mcpInventoryTab.value = "resources";
  else if (!server.tools.length && !server.resources.length && server.resourceTemplates.length) mcpInventoryTab.value = "templates";
}

function ensureMcpSelection(): void {
  const current = mcpServers.value.find((server) => server.name === selectedMcpName.value);
  if (current) {
    selectMcpServer(current);
  } else {
    const preferred = showAdvanced.value
      ? mcpServers.value[0]
      : mcpServers.value.find((server) => server.startupStatus === "ready" && server.tools.length > 0)
        ?? mcpServers.value.find((server) => server.tools.length > 0)
        ?? mcpServers.value[0];
    if (preferred) selectMcpServer(preferred);
    else selectedMcpName.value = "";
  }
}

async function loadMcpServers(reload = false): Promise<void> {
  if (mcpLoading.value || mcpReloading.value) return;
  if (reload) mcpReloading.value = true;
  else mcpLoading.value = true;
  mcpError.value = "";
  try {
    mcpServers.value = reload
      ? await desktopApi.reloadCodexMcpServers()
      : await desktopApi.listCodexMcpServers();
    mcpLoaded.value = true;
    ensureMcpSelection();
    if (reload) showNotice("MCP Server 已重新加载");
  } catch (error) {
    mcpError.value = errorText(error);
    if (reload) showNotice(`重载失败：${mcpError.value}`, true);
  } finally {
    mcpLoading.value = false;
    mcpReloading.value = false;
  }
}

async function readSelectedResource(): Promise<void> {
  const server = selectedMcp.value;
  const resource = selectedResource.value;
  if (!server || !resource || resourceLoading.value) return;
  resourceLoading.value = true;
  resourceContents.value = [];
  try {
    resourceContents.value = await desktopApi.readCodexMcpResource({
      server: server.name,
      uri: resource.uri,
      threadId: null,
    });
  } catch (error) {
    showNotice(`资源读取失败：${errorText(error)}`, true);
  } finally {
    resourceLoading.value = false;
  }
}

async function startOauth(server: CodexMcpServer): Promise<void> {
  if (oauthBusyName.value) return;
  oauthBusyName.value = server.name;
  try {
    const response = await desktopApi.startCodexMcpOauth({
      name: server.name,
      threadId: null,
    });
    await desktopApi.openExternalUrl(response.authorizationUrl);
    showNotice(`已打开 ${server.displayName} 授权页面`);
  } catch (error) {
    showNotice(`OAuth 启动失败：${errorText(error)}`, true);
  } finally {
    oauthBusyName.value = "";
  }
}

async function loadConfig(): Promise<void> {
  if (configLoading.value) return;
  configLoading.value = true;
  configError.value = "";
  featuresError.value = "";
  try {
    configSnapshot.value = await desktopApi.readCodexConfig(props.cwd?.trim() || null);
    configLoaded.value = true;
    if (selectedLayerIndex.value >= configSnapshot.value.layers.length) selectedLayerIndex.value = 0;
    const currentEntry = configEntries.value.find((entry) => entry.keyPath === selectedConfigKey.value);
    if (currentEntry) selectConfigEntry(currentEntry);
    else if (configEntries.value[0]) selectConfigEntry(configEntries.value[0]);
    try {
      features.value = await desktopApi.listCodexFeatures();
    } catch (error) {
      featuresError.value = errorText(error);
    }
  } catch (error) {
    configError.value = errorText(error);
  } finally {
    configLoading.value = false;
  }
}

function selectConfigEntry(entry: ConfigEntry): void {
  selectedConfigKey.value = entry.keyPath;
  configKeyDraft.value = entry.keyPath;
  configValueDraft.value = jsonText(entry.value);
}

function beginNewConfigValue(): void {
  selectedConfigKey.value = "";
  configKeyDraft.value = "";
  configValueDraft.value = "null";
}

function parseConfigValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`配置值必须是有效 JSON：${errorText(error)}`);
  }
}

async function saveConfigValue(): Promise<void> {
  const snapshot = configSnapshot.value;
  const keyPath = configKeyDraft.value.trim();
  if (!snapshot || !keyPath || configWriteBusy.value) return;
  configWriteBusy.value = true;
  try {
    const result = await desktopApi.writeCodexConfigValue({
      keyPath,
      value: parseConfigValue(configValueDraft.value),
      mergeStrategy: "replace",
      filePath: snapshot.userConfigPath ?? null,
      expectedVersion: snapshot.userConfigVersion || null,
    });
    showNotice(result.status === "okOverridden" ? result.overriddenMessage || "配置已写入，但被更高优先级覆盖" : "配置已保存");
    await loadConfig();
    const refreshed = configEntries.value.find((entry) => entry.keyPath === keyPath);
    if (refreshed) selectConfigEntry(refreshed);
  } catch (error) {
    showNotice(`配置保存失败：${errorText(error)}`, true);
  } finally {
    configWriteBusy.value = false;
  }
}

function addBatchRow(entry?: ConfigEntry): void {
  batchRows.value.push({
    id: nextBatchRowId++,
    keyPath: entry?.keyPath ?? "",
    valueText: entry ? jsonText(entry.value) : "null",
    mergeStrategy: "replace",
  });
}

function addEditorToBatch(): void {
  const keyPath = configKeyDraft.value.trim();
  if (!keyPath) return;
  try {
    addBatchRow({
      keyPath,
      value: parseConfigValue(configValueDraft.value),
      origin: null,
    });
  } catch (error) {
    showNotice(errorText(error), true);
  }
}

function removeBatchRow(id: number): void {
  batchRows.value = batchRows.value.filter((row) => row.id !== id);
}

async function saveBatchRows(): Promise<void> {
  const snapshot = configSnapshot.value;
  if (!snapshot || !batchRows.value.length || configWriteBusy.value) return;
  configWriteBusy.value = true;
  try {
    const edits = batchRows.value.map((row) => {
      const keyPath = row.keyPath.trim();
      if (!keyPath) throw new Error("批量修改中存在空配置键");
      return {
        keyPath,
        value: parseConfigValue(row.valueText),
        mergeStrategy: row.mergeStrategy,
      };
    });
    const result = await desktopApi.batchWriteCodexConfig({
      edits,
      filePath: snapshot.userConfigPath ?? null,
      expectedVersion: snapshot.userConfigVersion || null,
    });
    showNotice(result.status === "okOverridden" ? result.overriddenMessage || "配置已写入，但部分值被覆盖" : `已保存 ${edits.length} 项配置`);
    batchRows.value = [];
    await loadConfig();
  } catch (error) {
    showNotice(`批量保存失败：${errorText(error)}`, true);
  } finally {
    configWriteBusy.value = false;
  }
}

async function toggleFeature(feature: CodexFeature, event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  const enabled = target.checked;
  if (featureBusy.value[feature.name]) return;
  featureBusy.value = { ...featureBusy.value, [feature.name]: true };
  try {
    await desktopApi.setCodexFeature({ name: feature.name, enabled, persist: true });
    features.value = features.value.map((item) => item.name === feature.name ? { ...item, enabled } : item);
    showNotice(`${feature.displayName || feature.name} 已${enabled ? "启用" : "关闭"}`);
    await loadConfig();
  } catch (error) {
    target.checked = feature.enabled;
    showNotice(`功能开关更新失败：${errorText(error)}`, true);
  } finally {
    featureBusy.value = { ...featureBusy.value, [feature.name]: false };
  }
}

function handleAdminEvent(event: CodexAdminEvent): void {
  if (event.type === "thread-status") {
    threads.value = threads.value.map((thread) => thread.id === event.threadId ? { ...thread, status: event.status } : thread);
    if (selectedThread.value?.id === event.threadId) selectedThread.value = { ...selectedThread.value, status: event.status };
    return;
  }
  if (event.type === "thread-name") {
    threads.value = threads.value.map((thread) => thread.id === event.threadId ? { ...thread, name: event.name } : thread);
    if (selectedThread.value?.id === event.threadId) {
      selectedThread.value = { ...selectedThread.value, name: event.name };
      threadNameDraft.value = event.name || threadTitle(selectedThread.value);
    }
    return;
  }
  if (event.type === "mcp-status") {
    mcpServers.value = mcpServers.value.map((server) => server.name === event.name ? {
      ...server,
      startupStatus: event.startupStatus,
      error: event.error,
      failureReason: event.failureReason,
    } : server);
    return;
  }
  if (event.type === "mcp-oauth") {
    showNotice(event.success ? `${event.name} OAuth 登录完成` : `${event.name} OAuth 登录失败：${event.error || "未知错误"}`, !event.success);
    if (event.success) void loadMcpServers();
  }
}

async function ensureActiveTabLoaded(force = false): Promise<void> {
  if (activeTab.value === "threads" && (force || !threadLoaded.value)) await loadThreads(true);
  if (activeTab.value === "mcp" && (force || !mcpLoaded.value)) await loadMcpServers();
  if (activeTab.value === "config" && (force || !configLoaded.value)) await loadConfig();
}

function selectAdminTab(tab: AdminTab): void {
  activeTab.value = tab;
  window.localStorage.setItem("ai-workbench.codexAdminTab", tab);
  notice.value = "";
  void ensureActiveTabLoaded();
}

function toggleAdvanced(): void {
  showAdvanced.value = !showAdvanced.value;
  window.localStorage.setItem("ai-workbench.codexAdminAdvanced", String(showAdvanced.value));
  if (!showAdvanced.value) {
    if (mcpInventoryTab.value !== "tools") mcpInventoryTab.value = "tools";
    if (configView.value === "layers") configView.value = "effective";
    batchRows.value = [];
  }
}

function refreshActiveTab(): void {
  void ensureActiveTabLoaded(true);
}

watch(threadArchived, () => void loadThreads(true));
watch(threadScope, () => void loadThreads(true));
watch(() => props.cwd, (cwd, previousCwd) => {
  const switchedToInitialProject = Boolean(cwd) && !previousCwd && threadScope.value === "all";
  if (switchedToInitialProject) {
    threadScope.value = "project";
  } else if (threadScope.value === "project" && threadLoaded.value) {
    void loadThreads(true);
  }
  if (configLoaded.value) void loadConfig();
});

onMounted(async () => {
  try {
    const unsubscribe = await desktopApi.onCodexAdminEvent(handleAdminEvent);
    if (disposed) unsubscribe();
    else unsubscribeAdminEvent = unsubscribe;
  } catch (error) {
    showNotice(`实时状态订阅失败：${errorText(error)}`, true);
  }
  await ensureActiveTabLoaded();
});

onBeforeUnmount(() => {
  disposed = true;
  if (threadSearchTimer) clearTimeout(threadSearchTimer);
  unsubscribeAdminEvent?.();
});
</script>

<template>
  <div class="codex-admin">
    <div class="codex-admin-toolbar" :class="{ 'mcp-only': mode === 'mcp' }">
      <div v-if="mode === 'codex'" class="codex-admin-tabs" role="tablist" aria-label="Codex 管理类别">
        <button :class="{ active: activeTab === 'threads' }" type="button" role="tab" :aria-selected="activeTab === 'threads'" @click="selectAdminTab('threads')">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 8h10M7 12h7M5 19l-2 2v-4a8 8 0 1 1 4 2h-2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
          <span>会话</span>
        </button>
        <button :class="{ active: activeTab === 'config' }" type="button" role="tab" :aria-selected="activeTab === 'config'" @click="selectAdminTab('config')">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          <span>配置</span>
        </button>
      </div>
      <div v-else class="codex-mcp-toolbar-title">
        <span>
          <span class="codex-mcp-title-line"><strong>MCP 管理</strong><em>全局 Server</em></span>
          <small>{{ mcpLoading ? "正在同步服务状态" : "管理全局 MCP Server、工具、资源和认证状态。" }}</small>
        </span>
      </div>
      <div class="codex-admin-context">
        <label v-if="mode === 'codex'" class="codex-advanced-toggle">
          <span>高级功能</span>
          <input class="settings-switch" type="checkbox" :checked="showAdvanced" @change="toggleAdvanced" />
        </label>
        <template v-if="mode === 'codex'">
          <span class="codex-admin-context-label">项目</span>
          <code :title="cwd || '未选择项目'">{{ cwd ? compactPath(cwd) : "全部" }}</code>
        </template>
        <button class="codex-action-button" type="button" :disabled="mode === 'mcp' && mcpReloading" @click="refreshActiveTab">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.5-2.5L20 11M4 13l2.4 4.5A7 7 0 0 0 18 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
          {{ mode === "mcp" ? (mcpReloading ? "刷新中" : "刷新状态") : "刷新" }}
        </button>
      </div>
    </div>

    <p v-if="notice" class="codex-admin-notice" :class="{ error: noticeError }">{{ notice }}</p>

    <section v-if="activeTab === 'threads'" class="codex-admin-page" aria-label="Codex 会话中心">
      <div class="codex-admin-filterbar">
        <label class="codex-search-field">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8" /><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          <input v-model="threadSearch" type="search" placeholder="搜索会话" @input="scheduleThreadSearch" />
        </label>
        <div class="codex-segmented" aria-label="会话范围">
          <button type="button" :class="{ active: threadScope === 'project' }" :disabled="!cwd" @click="threadScope = 'project'">当前项目</button>
          <button type="button" :class="{ active: threadScope === 'all' }" @click="threadScope = 'all'">全部</button>
        </div>
        <label class="codex-checkbox">
          <input v-model="threadArchived" type="checkbox" />
          <span>已归档</span>
        </label>
      </div>

      <p v-if="threadError" class="codex-inline-error">{{ threadError }}</p>

      <div class="codex-admin-split codex-thread-layout">
        <aside class="codex-list-pane">
          <div class="codex-pane-title">
            <strong>会话</strong>
            <span>{{ threads.length }}</span>
          </div>
          <div class="codex-thread-list">
            <div v-if="threadLoading" class="codex-loading">正在读取会话...</div>
            <div v-else-if="!threads.length" class="codex-empty">没有匹配的会话</div>
            <button
              v-for="thread in threads"
              v-else
              :key="thread.id"
              class="codex-thread-row"
              :class="{ active: selectedThreadId === thread.id }"
              type="button"
              @click="selectThread(thread)"
            >
              <span class="codex-thread-row-head">
                <strong>{{ threadTitle(thread) }}</strong>
                <span class="codex-status" :class="threadStatusTone(thread)">{{ threadStatusLabel(thread) }}</span>
              </span>
              <span class="codex-thread-preview">{{ thread.preview || "暂无预览" }}</span>
              <span class="codex-thread-meta">
                <code :title="thread.cwd">{{ compactPath(thread.cwd) }}</code>
                <time>{{ formatDate(thread.recencyAt || thread.updatedAt) }}</time>
              </span>
            </button>
          </div>
          <button v-if="threadCursor" class="codex-load-more" type="button" :disabled="threadLoadingMore" @click="loadThreads(false)">
            {{ threadLoadingMore ? "加载中..." : "加载更多" }}
          </button>
        </aside>

        <div class="codex-detail-pane">
          <div v-if="!selectedThread" class="codex-empty codex-empty-detail">选择一个会话查看详情</div>
          <template v-else>
            <header class="codex-thread-detail-head">
              <div class="codex-thread-title-editor">
                <input v-model="threadNameDraft" type="text" maxlength="160" aria-label="会话名称" @keydown.enter="renameSelectedThread" />
                <button class="codex-icon-button" type="button" title="保存会话名称" aria-label="保存会话名称" :disabled="threadRenameBusy || !threadNameDraft.trim()" @click="renameSelectedThread">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h12l2 2v14H5V4Zm3 0v6h8V4M8 20v-6h8v6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>
                </button>
              </div>
              <span class="codex-status large" :class="threadStatusTone(selectedThread)">{{ threadStatusLabel(selectedThread) }}</span>
            </header>

            <dl class="codex-thread-facts">
              <div><dt>Thread ID</dt><dd><code :title="selectedThread.id">{{ selectedThread.id }}</code></dd></div>
              <div><dt>来源</dt><dd>{{ selectedThread.source }}</dd></div>
              <div><dt>Provider</dt><dd>{{ selectedThread.modelProvider }}</dd></div>
              <div><dt>CLI</dt><dd>{{ selectedThread.cliVersion || "未知" }}</dd></div>
              <div class="wide"><dt>工作目录</dt><dd><code :title="selectedThread.cwd">{{ selectedThread.cwd }}</code></dd></div>
            </dl>

            <div class="codex-pane-title codex-turns-title">
              <strong>Turn</strong>
              <span>{{ selectedThread.turns.length }}</span>
            </div>
            <div v-if="threadDetailLoading" class="codex-loading">正在读取完整记录...</div>
            <div v-else-if="!selectedThread.turns.length" class="codex-empty">该会话没有可读取的 Turn</div>
            <div v-else class="codex-turn-list">
              <article v-for="(turn, turnIndex) in selectedThread.turns" :key="turn.id || turnIndex" class="codex-turn">
                <header>
                  <span class="codex-turn-index">{{ turnIndex + 1 }}</span>
                  <strong>{{ turn.status }}</strong>
                  <time>{{ formatDate(turn.startedAt) }}</time>
                  <span v-if="turn.durationMs !== null" class="codex-duration">{{ formatDuration(turn.durationMs) }}</span>
                </header>
                <p v-if="turn.error" class="codex-inline-error">{{ turn.error }}</p>
                <div class="codex-turn-items">
                  <details v-for="(item, itemIndex) in turn.items" :key="item.id || itemIndex" class="codex-turn-item">
                    <summary>
                      <span class="codex-item-type">{{ item.type }}</span>
                      <strong>{{ item.title }}</strong>
                      <span v-if="item.status" class="codex-item-status">{{ item.status }}</span>
                      <span v-if="item.durationMs !== null && item.durationMs !== undefined" class="codex-duration">{{ formatDuration(item.durationMs) }}</span>
                    </summary>
                    <p v-if="item.text" class="codex-item-text">{{ item.text }}</p>
                    <pre v-if="showAdvanced && item.detail"><code>{{ item.detail }}</code></pre>
                  </details>
                </div>
              </article>
            </div>
          </template>
        </div>
      </div>
    </section>

    <section v-else-if="activeTab === 'mcp'" class="codex-admin-page" aria-label="MCP 管理中心">
      <div class="codex-summary-strip">
        <div class="codex-summary-card"><small>Server 总数</small><strong>{{ mcpSummary.servers }}</strong></div>
        <div class="codex-summary-card success"><small>就绪</small><strong>{{ mcpSummary.ready }}</strong></div>
        <div class="codex-summary-card primary"><small>工具</small><strong>{{ mcpSummary.tools }}</strong></div>
        <div class="codex-summary-card"><small>资源</small><strong>{{ mcpSummary.resources }}</strong></div>
        <div class="codex-summary-card warning"><small>需要认证</small><strong>{{ mcpSummary.authRequired }}</strong></div>
      </div>
      <p v-if="mcpError" class="codex-inline-error">{{ mcpError }}</p>

      <div class="codex-mcp-layout">
        <aside class="codex-mcp-panel codex-list-pane">
          <div class="codex-pane-title"><strong>Server 列表</strong><span>{{ filteredMcpServers.length }} 项</span></div>
          <label class="codex-mcp-search">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8" /><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            <input v-model="mcpSearch" type="search" placeholder="搜索服务" />
          </label>
          <div v-if="mcpLoading" class="codex-loading">正在读取 MCP 状态...</div>
          <div v-else-if="!mcpServers.length" class="codex-empty">没有已配置的 MCP Server</div>
          <div v-else-if="!filteredMcpServers.length" class="codex-empty">没有匹配的服务</div>
          <div v-else class="codex-mcp-server-list">
            <button v-for="server in filteredMcpServers" :key="server.name" type="button" :class="{ active: selectedMcpName === server.name }" @click="selectMcpServer(server)">
              <span class="codex-server-copy">
                <span><strong>{{ server.displayName }}</strong><i class="codex-status" :class="server.startupStatus === 'ready' ? 'ready' : server.startupStatus === 'failed' ? 'error' : 'muted'">{{ mcpStatusLabel(server) }}</i></span>
                <small>{{ server.name }}</small>
                <span class="codex-server-tags"><i>{{ mcpAuthLabel(server) }}</i><i>{{ server.tools.length }} 工具</i></span>
              </span>
            </button>
          </div>
        </aside>

        <section class="codex-mcp-panel codex-inventory-panel">
          <div class="codex-mcp-panel-head">
            <div class="codex-mcp-panel-title"><strong>清单</strong><div class="codex-language-toggle" role="group" aria-label="工具简介语言"><button type="button" :class="{ active: descriptionLanguage === 'zh' }" @click="setDescriptionLanguage('zh')">中</button><button type="button" :class="{ active: descriptionLanguage === 'en' }" @click="setDescriptionLanguage('en')">EN</button><label class="codex-advanced-toggle"><input class="settings-switch" type="checkbox" :checked="showAdvanced" @change="toggleAdvanced" /><span>高级</span></label></div></div>
            <div class="codex-subtabs" role="tablist" aria-label="MCP 清单"><button type="button" :class="{ active: mcpInventoryTab === 'tools' }" @click="mcpInventoryTab = 'tools'">工具</button><button type="button" :class="{ active: mcpInventoryTab === 'resources' }" @click="mcpInventoryTab = 'resources'">资源</button><button type="button" :class="{ active: mcpInventoryTab === 'templates' }" @click="mcpInventoryTab = 'templates'">模板</button></div>
          </div>
          <div v-if="!selectedMcp" class="codex-empty">选择一个 MCP Server</div>
          <template v-else>
            <div v-if="mcpInventoryTab === 'tools'" class="codex-inventory-list">
                <button v-for="tool in selectedMcp.tools" :key="tool.name" type="button" :class="{ active: selectedToolName === tool.name }" @click="selectedToolName = tool.name">
                  <span><strong>{{ tool.title || tool.name }}</strong><i>tool</i></span><small>{{ toolDescription(tool) }}</small>
                </button>
                <div v-if="!selectedMcp.tools.length" class="codex-empty">没有工具</div>
            </div>
            <div v-else-if="mcpInventoryTab === 'resources'" class="codex-inventory-list">
                <button v-for="resource in selectedMcp.resources" :key="resource.uri" type="button" :class="{ active: selectedResourceUri === resource.uri }" @click="selectedResourceUri = resource.uri; resourceContents = []">
                  <span><strong>{{ resource.title || resource.name }}</strong><i>resource</i></span><small>{{ resource.uri }}</small>
                </button>
                <div v-if="!selectedMcp.resources.length" class="codex-empty">没有资源</div>
            </div>
            <div v-else class="codex-inventory-list">
                <button v-for="template in selectedMcp.resourceTemplates" :key="template.uriTemplate" type="button" :class="{ active: selectedTemplateUri === template.uriTemplate }" @click="selectedTemplateUri = template.uriTemplate">
                  <span><strong>{{ template.title || template.name }}</strong><i>template</i></span><small>{{ template.uriTemplate }}</small>
                </button>
                <div v-if="!selectedMcp.resourceTemplates.length" class="codex-empty">没有资源模板</div>
            </div>
          </template>
        </section>

        <section class="codex-mcp-panel codex-mcp-detail-panel">
          <div v-if="!selectedMcp" class="codex-empty codex-empty-detail">选择清单项查看详情</div>
          <template v-else>
            <header class="codex-mcp-detail-head"><div><h3>{{ mcpInventoryTab === "tools" ? (selectedTool?.title || selectedTool?.name || "未选择工具") : mcpInventoryTab === "resources" ? (selectedResource?.title || selectedResource?.name || "未选择资源") : (selectedTemplate?.title || selectedTemplate?.name || "未选择模板") }}</h3><p>{{ selectedMcp.name }} · {{ mcpInventoryTab === "tools" ? "tool" : mcpInventoryTab === "resources" ? "resource" : "template" }}</p></div><span class="codex-status" :class="selectedMcp.startupStatus === 'ready' ? 'ready' : selectedMcp.startupStatus === 'failed' ? 'error' : 'muted'">{{ mcpStatusLabel(selectedMcp) }}</span></header>
            <div class="codex-topology"><span>Server</span><i></i><span :class="{ active: mcpInventoryTab === 'tools' }">Tools</span><i></i><span :class="{ active: mcpInventoryTab !== 'tools' }">Resources</span><i></i><span :class="{ warning: selectedMcp.authStatus === 'notLoggedIn' }">Auth</span></div>
            <div class="codex-mcp-detail-body">
              <section><div class="codex-detail-section-title"><strong>认证状态</strong><button v-if="selectedMcp.authStatus === 'notLoggedIn'" class="codex-action-button" type="button" :disabled="Boolean(oauthBusyName)" @click="startOauth(selectedMcp)">{{ oauthBusyName === selectedMcp.name ? "登录中" : "OAuth 登录" }}</button></div><div class="codex-meta-grid"><div><span>认证</span><strong>{{ mcpAuthLabel(selectedMcp) }}</strong></div><div><span>版本</span><strong>{{ selectedMcp.version || "未知" }}</strong></div><div><span>工具</span><strong>{{ selectedMcp.tools.length }}</strong></div><div><span>资源</span><strong>{{ selectedMcp.resources.length }}</strong></div></div></section>
              <p v-if="selectedMcp.error || selectedMcp.failureReason" class="codex-inline-error">{{ selectedMcp.error || selectedMcp.failureReason }}</p>
              <section v-if="mcpInventoryTab === 'tools' && selectedTool"><div class="codex-detail-section-title"><strong>元数据</strong><i>只读</i></div><div class="codex-dense-table"><div><span>名称</span><code>{{ selectedTool.name }}</code></div><div><span>简介</span><code>{{ toolDescription(selectedTool) }}</code></div></div><div class="codex-detail-section-title schema"><strong>输入 Schema</strong><i>JSON</i></div><pre><code>{{ jsonText(selectedTool.inputSchema) }}</code></pre><template v-if="selectedTool.outputSchema"><div class="codex-detail-section-title schema"><strong>输出 Schema</strong><i>JSON</i></div><pre><code>{{ jsonText(selectedTool.outputSchema) }}</code></pre></template></section>
              <section v-else-if="mcpInventoryTab === 'resources' && selectedResource"><div class="codex-detail-section-title"><strong>资源详情</strong><button class="codex-action-button" type="button" :disabled="resourceLoading" @click="readSelectedResource">{{ resourceLoading ? "读取中" : "读取资源" }}</button></div><code class="codex-identifier">{{ selectedResource.uri }}</code><p>{{ selectedResource.description }}</p><div v-if="resourceContents.length" class="codex-resource-content"><div v-for="(content, index) in resourceContents" :key="`${content.uri}-${index}`"><span>{{ content.mimeType || "text/plain" }}</span><pre v-if="content.text"><code>{{ content.text }}</code></pre><pre v-else-if="content.blob"><code>Base64 · {{ content.blob.length }} 字符</code></pre></div></div></section>
              <section v-else-if="mcpInventoryTab === 'templates' && selectedTemplate"><div class="codex-detail-section-title"><strong>模板详情</strong><i>只读</i></div><code class="codex-identifier">{{ selectedTemplate.uriTemplate }}</code><p>{{ selectedTemplate.description }}</p><span v-if="selectedTemplate.mimeType" class="codex-meta-chip">{{ selectedTemplate.mimeType }}</span></section>
              <div v-else class="codex-empty">选择一个清单项</div>
            </div>
          </template>
        </section>
      </div>
    </section>

    <section v-else class="codex-admin-page" aria-label="Codex 配置中心">
      <div class="codex-config-head">
        <div class="codex-subtabs" role="tablist" aria-label="配置视图">
          <button type="button" :class="{ active: configView === 'effective' }" @click="configView = 'effective'">{{ showAdvanced ? "全部配置" : "常用配置" }} <span>{{ configEntries.length }}</span></button>
          <button v-if="showAdvanced" type="button" :class="{ active: configView === 'layers' }" @click="configView = 'layers'">来源分层 <span>{{ configSnapshot?.layers.length || 0 }}</span></button>
          <button type="button" :class="{ active: configView === 'features' }" @click="configView = 'features'">功能开关 <span>{{ visibleFeatures.length }}</span></button>
        </div>
        <code v-if="showAdvanced && configSnapshot?.userConfigPath" class="codex-config-path" :title="configSnapshot.userConfigPath">{{ compactPath(configSnapshot.userConfigPath) }}</code>
      </div>
      <p v-if="configError" class="codex-inline-error">{{ configError }}</p>
      <div v-if="configLoading && !configSnapshot" class="codex-loading">正在读取 Codex 配置...</div>

      <template v-else-if="configView === 'effective'">
        <div class="codex-admin-filterbar config-filterbar">
          <label class="codex-search-field">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8" /><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            <input v-model="configSearch" type="search" placeholder="搜索配置键或值" />
          </label>
          <button v-if="showAdvanced" class="codex-action-button" type="button" @click="beginNewConfigValue">新增配置</button>
          <button v-if="showAdvanced" class="codex-action-button" type="button" @click="addBatchRow()">批量修改</button>
        </div>

        <div class="codex-admin-split codex-config-layout">
          <div class="codex-config-list">
            <button v-for="entry in configEntries" :key="entry.keyPath" type="button" :class="{ active: selectedConfigKey === entry.keyPath }" @click="selectConfigEntry(entry)">
              <code>{{ entry.keyPath }}</code>
              <span>{{ previewValue(entry.value) }}</span>
              <small>{{ entry.origin?.label || "默认值" }}</small>
            </button>
            <div v-if="!configEntries.length" class="codex-empty">没有匹配的配置</div>
          </div>
          <div class="codex-config-editor">
            <div class="codex-editor-head">
              <strong>{{ selectedConfigKey ? "编辑配置" : "新增配置" }}</strong>
              <span v-if="selectedConfigKey">{{ selectedConfigOriginLabel }}</span>
            </div>
            <label>
              <span>键路径</span>
              <input v-model="configKeyDraft" type="text" spellcheck="false" placeholder="例如 model_reasoning_effort" />
            </label>
            <label>
              <span>JSON 值</span>
              <textarea v-model="configValueDraft" spellcheck="false" rows="10" placeholder="null"></textarea>
            </label>
            <div class="codex-editor-actions">
              <button v-if="showAdvanced" class="codex-action-button" type="button" :disabled="!configKeyDraft.trim()" @click="addEditorToBatch">加入批量</button>
              <button class="codex-action-button primary" type="button" :disabled="configWriteBusy || !configKeyDraft.trim()" @click="saveConfigValue">{{ configWriteBusy ? "保存中" : "保存" }}</button>
            </div>
          </div>
        </div>

        <div v-if="batchRows.length" class="codex-batch-panel">
          <div class="codex-pane-title"><strong>待批量写入</strong><span>{{ batchRows.length }}</span></div>
          <div class="codex-batch-rows">
            <div v-for="row in batchRows" :key="row.id" class="codex-batch-row">
              <input v-model="row.keyPath" type="text" aria-label="配置键" spellcheck="false" placeholder="配置键" />
              <input v-model="row.valueText" type="text" aria-label="JSON 值" spellcheck="false" placeholder="JSON 值" />
              <select v-model="row.mergeStrategy" aria-label="合并方式"><option value="replace">替换</option><option value="upsert">合并</option></select>
              <button class="codex-icon-button danger" type="button" title="移除" aria-label="移除批量修改" @click="removeBatchRow(row.id)">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
            </div>
          </div>
          <div class="codex-batch-actions">
            <button class="codex-action-button" type="button" @click="addBatchRow()">添加一项</button>
            <button class="codex-action-button primary" type="button" :disabled="configWriteBusy" @click="saveBatchRows">{{ configWriteBusy ? "写入中" : "全部写入" }}</button>
          </div>
        </div>
      </template>

      <div v-else-if="configView === 'layers'" class="codex-admin-split codex-layer-layout">
        <div class="codex-layer-list">
          <button v-for="(layer, index) in configSnapshot?.layers || []" :key="`${layer.type}-${index}`" type="button" :class="{ active: selectedLayerIndex === index }" @click="selectedLayerIndex = index">
            <span class="codex-layer-order">{{ index + 1 }}</span>
            <span><strong>{{ layer.label }}</strong><small>{{ layer.path || layer.type }}</small></span>
            <span v-if="layer.disabledReason" class="codex-status error">禁用</span>
          </button>
          <div v-if="!configSnapshot?.layers.length" class="codex-empty">没有配置层信息</div>
        </div>
        <div class="codex-layer-detail">
          <template v-if="selectedLayer">
            <div class="codex-editor-head"><strong>{{ selectedLayer.label }}</strong><span>版本 {{ selectedLayer.version || "未知" }}</span></div>
            <code v-if="selectedLayer.path" class="codex-identifier">{{ selectedLayer.path }}</code>
            <p v-if="selectedLayer.disabledReason" class="codex-inline-error">{{ selectedLayer.disabledReason }}</p>
            <pre><code>{{ jsonText(selectedLayer.config) }}</code></pre>
          </template>
        </div>
      </div>

      <template v-else>
        <div class="codex-admin-filterbar config-filterbar">
          <label class="codex-search-field">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8" /><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
            <input v-model="featureSearch" type="search" placeholder="搜索功能开关" />
          </label>
          <span class="codex-feature-count">已启用 {{ visibleFeatures.filter((feature) => feature.enabled).length }} / {{ visibleFeatures.length }}</span>
        </div>
        <p v-if="featuresError" class="codex-inline-error">{{ featuresError }}</p>
        <div class="codex-feature-list">
          <label v-for="feature in visibleFeatures" :key="feature.name" class="codex-feature-row">
            <span class="codex-feature-copy">
              <span class="codex-feature-title"><strong>{{ feature.displayName || feature.name }}</strong><span class="codex-stage" :class="feature.stage">{{ feature.stage }}</span></span>
              <code>{{ feature.name }}</code>
              <small>{{ feature.description || feature.announcement || "" }}</small>
            </span>
            <span class="codex-feature-default">默认 {{ feature.defaultEnabled ? "开启" : "关闭" }}</span>
            <input class="settings-switch" type="checkbox" :checked="feature.enabled" :disabled="featureBusy[feature.name]" @change="toggleFeature(feature, $event)" />
          </label>
          <div v-if="!visibleFeatures.length" class="codex-empty">没有匹配的功能开关</div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.codex-admin {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
}

.codex-admin-toolbar,
.codex-admin-filterbar,
.codex-config-head,
.codex-summary-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.codex-admin-toolbar {
  min-height: 46px;
  border-bottom: 1px solid var(--color-border);
}

.codex-admin-toolbar.mcp-only {
  min-height: 68px;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  border-radius: 0;
  background: transparent;
  padding: 4px 0 14px;
}

.codex-mcp-toolbar-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.codex-mcp-toolbar-icon {
  display: inline-grid;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 11px;
  background: var(--color-primary-muted);
  color: var(--color-primary);
}

.codex-mcp-toolbar-icon svg {
  width: 18px;
  height: 18px;
}

.codex-mcp-toolbar-title > span:last-child {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.codex-mcp-toolbar-title strong {
  color: var(--color-text-body);
  font-size: 18px;
  font-weight: 820;
  line-height: 1.2;
}

.codex-mcp-toolbar-title small {
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 680;
  line-height: 1.2;
}

.codex-admin-tabs,
.codex-subtabs,
.codex-segmented {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-bg-elevated);
  padding: 3px;
}

.codex-admin-tabs button,
.codex-subtabs button,
.codex-segmented button {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--color-text-secondary);
  padding: 0 12px;
  font-size: 12px;
  font-weight: 760;
  white-space: nowrap;
}

.codex-admin-tabs button:hover,
.codex-subtabs button:hover,
.codex-segmented button:hover {
  color: var(--color-text-body);
}

.codex-admin-tabs button.active,
.codex-subtabs button.active,
.codex-segmented button.active {
  background: var(--color-bg-content);
  box-shadow: var(--shadow-sm);
  color: var(--color-primary);
}

.codex-admin-tabs svg,
.codex-action-button svg {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}

.codex-subtabs button span {
  color: var(--color-text-muted);
  font-size: 10px;
}

.codex-admin-context {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.codex-advanced-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-right: 2px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 740;
  white-space: nowrap;
}

.codex-advanced-toggle .settings-switch {
  display: block;
  flex: 0 0 auto;
  margin: 0;
}

.codex-admin-toolbar.mcp-only .codex-admin-context {
  height: 34px;
}

.codex-admin-toolbar.mcp-only .codex-advanced-toggle {
  height: 34px;
  margin: 0;
  line-height: 1;
}

.codex-admin-toolbar.mcp-only .codex-advanced-toggle > span {
  display: inline-flex;
  height: 22px;
  align-items: center;
}

.codex-admin-toolbar.mcp-only .codex-icon-button {
  width: 34px;
  height: 34px;
  flex-basis: 34px;
}

.codex-admin-context-label,
.codex-feature-count {
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 760;
}

.codex-admin-context code,
.codex-config-path {
  max-width: 240px;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-icon-button {
  display: inline-grid;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-content);
  color: var(--color-text-secondary);
  padding: 0;
}

.codex-icon-button:hover:not(:disabled) {
  border-color: var(--color-border-active);
  color: var(--color-primary);
}

.codex-icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.codex-icon-button svg {
  width: 16px;
  height: 16px;
}

.codex-icon-button.danger:hover {
  border-color: var(--state-error);
  color: var(--state-error);
}

.codex-admin-notice,
.codex-inline-error {
  margin: 0;
  border: 1px solid rgba(22, 163, 74, 0.2);
  border-radius: 7px;
  background: var(--state-success-bg);
  color: var(--state-success);
  padding: 9px 12px;
  font-size: 12px;
  line-height: 1.45;
}

.codex-admin-notice.error,
.codex-inline-error {
  border-color: rgba(220, 38, 38, 0.2);
  background: var(--state-error-bg);
  color: var(--state-error);
}

.codex-admin-page {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
}

.codex-admin-filterbar {
  justify-content: flex-start;
}

.codex-search-field {
  display: flex;
  min-width: 220px;
  max-width: 420px;
  flex: 1 1 320px;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-bg-input);
  padding: 0 10px;
}

.codex-search-field:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.codex-search-field svg {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--color-text-muted);
}

.codex-search-field input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--color-text-body);
  font: inherit;
  font-size: 12px;
}

.codex-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.codex-checkbox input {
  width: 15px;
  height: 15px;
  accent-color: var(--color-primary);
}

.codex-admin-split {
  display: grid;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-content);
}

.codex-thread-layout {
  grid-template-columns: minmax(280px, 0.38fr) minmax(0, 0.62fr);
  height: clamp(520px, calc(100vh - 300px), 650px);
  min-height: 0;
}

.codex-mcp-layout {
  grid-template-columns: 300px minmax(0, 1fr);
  height: clamp(520px, calc(100vh - 300px), 650px);
  min-height: 0;
}

.codex-list-pane,
.codex-detail-pane {
  min-width: 0;
}

.codex-list-pane {
  display: flex;
  min-height: 0;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-surface);
}

.codex-detail-pane {
  overflow: auto;
  padding: 16px;
}

.codex-pane-title {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--color-border-subtle);
  padding: 0 14px;
}

.codex-pane-title strong {
  color: var(--color-text-body);
  font-size: 13px;
  font-weight: 820;
}

.codex-pane-title span,
.codex-server-count {
  display: inline-grid;
  min-width: 22px;
  min-height: 22px;
  place-items: center;
  border-radius: 6px;
  background: var(--color-bg-elevated);
  color: var(--color-text-muted);
  padding: 0 6px;
  font-size: 10px;
  font-weight: 800;
}

.codex-thread-list,
.codex-mcp-server-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
}

.codex-thread-row {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  background: transparent;
  padding: 12px 14px;
  text-align: left;
}

.codex-thread-row:hover,
.codex-thread-row.active {
  background: var(--color-bg-hover);
}

.codex-thread-row.active {
  box-shadow: inset 3px 0 0 var(--color-primary);
}

.codex-thread-row-head,
.codex-thread-meta,
.codex-thread-detail-head,
.codex-server-detail-head,
.codex-server-actions,
.codex-resource-head,
.codex-editor-head,
.codex-editor-actions,
.codex-batch-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.codex-thread-row-head strong {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-body);
  font-size: 12px;
  font-weight: 790;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-thread-preview {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.codex-thread-meta code,
.codex-thread-meta time {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-load-more {
  min-height: 36px;
  border: 0;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-content);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 760;
}

.codex-status {
  display: inline-flex;
  min-height: 21px;
  flex: 0 0 auto;
  align-items: center;
  border-radius: 6px;
  background: var(--color-bg-elevated);
  color: var(--color-text-muted);
  padding: 0 7px;
  font-size: 10px;
  font-weight: 800;
  white-space: nowrap;
}

.codex-status.ready {
  background: var(--state-success-bg);
  color: var(--state-success);
}

.codex-status.active {
  background: var(--state-info-bg);
  color: var(--state-info);
}

.codex-status.error {
  background: var(--state-error-bg);
  color: var(--state-error);
}

.codex-status.large {
  min-height: 26px;
  padding: 0 9px;
  font-size: 11px;
}

.codex-thread-title-editor {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 7px;
}

.codex-thread-title-editor input {
  min-width: 0;
  max-width: 560px;
  flex: 1;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: 0;
  background: transparent;
  color: var(--color-text-primary);
  padding: 6px 8px;
  font-size: 17px;
  font-weight: 830;
}

.codex-thread-title-editor input:hover,
.codex-thread-title-editor input:focus {
  border-color: var(--color-border);
  background: var(--color-bg-input);
}

.codex-thread-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  margin: 14px 0 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 7px;
  background: var(--color-bg-surface);
}

.codex-thread-facts div {
  min-width: 0;
  border-right: 1px solid var(--color-border-subtle);
  padding: 10px;
}

.codex-thread-facts div:nth-child(4),
.codex-thread-facts div.wide {
  border-right: 0;
}

.codex-thread-facts .wide {
  grid-column: 1 / -1;
  border-top: 1px solid var(--color-border-subtle);
}

.codex-thread-facts dt {
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 780;
}

.codex-thread-facts dd {
  min-width: 0;
  margin: 5px 0 0;
  overflow: hidden;
  color: var(--color-text-body);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-thread-facts code {
  font-family: var(--font-mono);
}

.codex-turns-title {
  padding: 0;
}

.codex-turn-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.codex-turn {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-bg-content);
}

.codex-turn > header {
  display: flex;
  min-height: 38px;
  align-items: center;
  gap: 8px;
  background: var(--color-bg-surface);
  padding: 0 10px;
}

.codex-turn > header strong {
  color: var(--color-text-body);
  font-size: 11px;
}

.codex-turn > header time {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: 10px;
}

.codex-turn-index {
  display: inline-grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 5px;
  background: var(--color-primary-muted);
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 850;
}

.codex-duration,
.codex-item-status {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
}

.codex-turn-items {
  display: flex;
  flex-direction: column;
}

.codex-turn-item {
  border-top: 1px solid var(--color-border-subtle);
}

.codex-turn-item summary {
  display: flex;
  min-height: 36px;
  cursor: pointer;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  list-style: none;
}

.codex-turn-item summary::-webkit-details-marker {
  display: none;
}

.codex-turn-item summary::before {
  color: var(--color-text-muted);
  content: "›";
  font-size: 16px;
  transition: transform var(--transition-fast);
}

.codex-turn-item[open] summary::before {
  transform: rotate(90deg);
}

.codex-turn-item summary strong {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-body);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-item-type {
  color: var(--color-primary);
  font-family: var(--font-mono);
  font-size: 9px;
}

.codex-turn-item .codex-duration {
  margin-left: auto;
}

.codex-item-text {
  margin: 0;
  white-space: pre-wrap;
  color: var(--color-text-secondary);
  padding: 0 12px 10px 30px;
  font-size: 11px;
  line-height: 1.5;
}

.codex-turn-item pre,
.codex-inventory-detail pre,
.codex-resource-content pre,
.codex-layer-detail pre {
  max-height: 320px;
  margin: 0;
  overflow: auto;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
  color: var(--color-text-body);
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.codex-loading,
.codex-empty {
  display: grid;
  min-height: 110px;
  place-items: center;
  color: var(--color-text-muted);
  padding: 20px;
  font-size: 12px;
  text-align: center;
}

.codex-empty-detail {
  min-height: 480px;
}

.codex-summary-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(130px, 1fr)) auto;
  align-items: stretch;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.codex-summary-strip > .codex-summary-card {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-content);
  padding: 13px 14px;
  box-shadow: var(--shadow-sm);
}

.codex-summary-icon {
  display: inline-grid;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  place-items: center;
  border-radius: 9px;
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
}

.codex-summary-card.primary .codex-summary-icon {
  background: var(--color-primary-muted);
  color: var(--color-primary);
}

.codex-summary-card.success .codex-summary-icon {
  background: var(--state-success-bg);
  color: var(--state-success);
}

.codex-summary-icon svg {
  width: 18px;
  height: 18px;
}

.codex-summary-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.codex-summary-strip .codex-summary-copy small {
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 700;
}

.codex-summary-strip .codex-summary-copy strong {
  color: var(--color-text-body);
  font-size: 20px;
  line-height: 1.1;
}

.codex-summary-card.success .codex-summary-copy strong {
  color: var(--state-success);
}

.codex-summary-strip > button {
  min-height: 100%;
  padding: 0 16px;
}

.codex-action-button {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-content);
  color: var(--color-text-secondary);
  padding: 0 11px;
  font-size: 11px;
  font-weight: 780;
  white-space: nowrap;
}

.codex-action-button:hover:not(:disabled) {
  border-color: var(--color-border-active);
  color: var(--color-primary);
}

.codex-action-button.primary {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: var(--color-text-inverse);
}

.codex-action-button.primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
  color: var(--color-text-inverse);
}

.codex-action-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.codex-mcp-server-list button {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 10px;
  min-height: 66px;
  border: 0;
  background: transparent;
  margin: 4px 8px;
  width: calc(100% - 16px);
  border-radius: 8px;
  padding: 9px 10px;
  text-align: left;
}

.codex-mcp-server-list button:hover,
.codex-mcp-server-list button.active {
  background: var(--color-bg-hover);
}

.codex-mcp-server-list button.active {
  background: var(--color-bg-active);
  box-shadow: inset 0 0 0 1px var(--color-primary-ring);
}

.codex-server-avatar {
  position: relative;
  display: inline-grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 9px;
  background: var(--color-primary-muted);
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 850;
}

.codex-server-avatar.large {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border-radius: 11px;
  font-size: 16px;
}

.codex-server-mark {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-muted);
  box-shadow: 0 0 0 2px var(--color-bg-surface);
}

.codex-server-mark.ready {
  background: var(--state-success);
}

.codex-server-mark.starting {
  background: var(--state-warning);
}

.codex-server-mark.failed {
  background: var(--state-error);
}

.codex-server-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.codex-server-copy strong,
.codex-server-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-server-copy strong {
  color: var(--color-text-body);
  font-size: 12px;
}

.codex-server-copy small {
  color: var(--color-text-muted);
  font-size: 10px;
}

.codex-server-chevron {
  width: 15px;
  height: 15px;
  color: var(--color-text-muted);
}

.codex-mcp-search {
  position: relative;
  display: block;
  margin: 10px 10px 6px;
}

.codex-mcp-search svg {
  position: absolute;
  top: 50%;
  left: 10px;
  width: 15px;
  height: 15px;
  color: var(--color-text-muted);
  transform: translateY(-50%);
}

.codex-mcp-search input {
  width: 100%;
  height: 34px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  outline: 0;
  background: var(--color-bg-content);
  color: var(--color-text-body);
  padding: 0 10px 0 32px;
  font: inherit;
  font-size: 11px;
}

.codex-mcp-search input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.codex-pane-title > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.codex-pane-title > div small {
  color: var(--color-text-muted);
  font-size: 9px;
}

.codex-server-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.codex-server-detail-head h3,
.codex-inventory-detail h4 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 17px;
  font-weight: 840;
}

.codex-server-detail-head p,
.codex-inventory-detail p {
  margin: 5px 0 0;
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.codex-server-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 10px 0 14px;
  color: var(--color-text-muted);
  font-size: 10px;
}

.codex-server-meta a {
  color: var(--color-primary);
  text-decoration: none;
}

.codex-inventory-toolbar {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}

.codex-language-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-elevated);
  padding: 2px;
}

.codex-language-toggle button {
  min-width: 38px;
  height: 26px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  padding: 0 8px;
  font-size: 10px;
  font-weight: 780;
}

.codex-language-toggle button:hover {
  color: var(--color-text-body);
}

.codex-language-toggle button.active {
  background: var(--color-bg-content);
  box-shadow: var(--shadow-sm);
  color: var(--color-primary);
}

.codex-inventory-split {
  display: grid;
  grid-template-columns: minmax(190px, 0.34fr) minmax(0, 0.66fr);
  min-height: 390px;
  margin-top: 8px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-content);
}

.codex-inventory-list {
  overflow: auto;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-surface);
}

.codex-inventory-list button {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  background: transparent;
  padding: 10px;
  text-align: left;
}

.codex-inventory-list button:hover,
.codex-inventory-list button.active {
  background: var(--color-bg-hover);
}

.codex-inventory-list button.active {
  box-shadow: inset 3px 0 0 var(--color-primary);
}

.codex-inventory-list strong,
.codex-inventory-list small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-inventory-list strong {
  color: var(--color-text-body);
  font-size: 11px;
}

.codex-inventory-list small {
  max-width: 100%;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 9px;
}

.codex-inventory-detail {
  min-width: 0;
  overflow: auto;
  padding: 14px;
}

.codex-inventory-detail h4 {
  font-size: 14px;
}

.codex-inventory-detail h5 {
  margin: 16px 0 7px;
  color: var(--color-text-secondary);
  font-size: 10px;
  text-transform: uppercase;
}

.codex-identifier {
  display: block;
  max-width: 100%;
  margin-top: 6px;
  overflow-wrap: anywhere;
  color: var(--color-primary);
  font-family: var(--font-mono);
  font-size: 10px;
}

.codex-inventory-detail pre,
.codex-resource-content pre,
.codex-layer-detail pre {
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
}

.codex-resource-head {
  align-items: flex-start;
}

.codex-resource-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}

.codex-resource-content > div > span,
.codex-meta-chip {
  display: inline-block;
  margin-bottom: 5px;
  color: var(--color-text-muted);
  font-size: 9px;
}

.codex-config-head {
  align-items: center;
}

.config-filterbar {
  margin-top: 2px;
}

.codex-config-layout {
  grid-template-columns: minmax(300px, 0.55fr) minmax(300px, 0.45fr);
  min-height: 500px;
}

.codex-config-list {
  max-height: 600px;
  overflow: auto;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-surface);
}

.codex-config-list button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px 10px;
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  background: transparent;
  padding: 9px 11px;
  text-align: left;
}

.codex-config-list button:hover,
.codex-config-list button.active {
  background: var(--color-bg-hover);
}

.codex-config-list button.active {
  box-shadow: inset 3px 0 0 var(--color-primary);
}

.codex-config-list code,
.codex-config-list span,
.codex-config-list small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-config-list code {
  color: var(--color-text-body);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 760;
}

.codex-config-list span {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 9px;
  text-align: right;
}

.codex-config-list small {
  grid-column: 1 / -1;
  color: var(--color-text-muted);
  font-size: 9px;
}

.codex-config-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}

.codex-editor-head {
  min-height: 28px;
  border-bottom: 1px solid var(--color-border-subtle);
  padding-bottom: 10px;
}

.codex-editor-head strong {
  color: var(--color-text-body);
  font-size: 12px;
}

.codex-editor-head span {
  color: var(--color-text-muted);
  font-size: 10px;
}

.codex-config-editor label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.codex-config-editor label > span {
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 760;
}

.codex-config-editor input,
.codex-config-editor textarea,
.codex-batch-row input,
.codex-batch-row select {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  outline: 0;
  background: var(--color-bg-input);
  color: var(--color-text-body);
  padding: 8px 9px;
  font-family: var(--font-mono);
  font-size: 10px;
}

.codex-config-editor input:focus,
.codex-config-editor textarea:focus,
.codex-batch-row input:focus,
.codex-batch-row select:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-ring);
}

.codex-config-editor textarea {
  min-height: 240px;
  resize: vertical;
  line-height: 1.55;
}

.codex-editor-actions,
.codex-batch-actions {
  justify-content: flex-end;
}

.codex-batch-panel {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-content);
}

.codex-batch-rows {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
}

.codex-batch-row {
  display: grid;
  grid-template-columns: minmax(160px, 0.9fr) minmax(180px, 1.2fr) 86px 32px;
  gap: 7px;
  align-items: center;
}

.codex-batch-actions {
  border-top: 1px solid var(--color-border-subtle);
  padding: 10px;
}

.codex-layer-layout {
  grid-template-columns: 300px minmax(0, 1fr);
  min-height: 510px;
}

.codex-layer-list {
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-surface);
}

.codex-layer-list button {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  gap: 9px;
  width: 100%;
  align-items: center;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  background: transparent;
  padding: 10px;
  text-align: left;
}

.codex-layer-list button:hover,
.codex-layer-list button.active {
  background: var(--color-bg-hover);
}

.codex-layer-list button.active {
  box-shadow: inset 3px 0 0 var(--color-primary);
}

.codex-layer-order {
  display: inline-grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 6px;
  background: var(--color-bg-elevated);
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 800;
}

.codex-layer-list button > span:nth-child(2) {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.codex-layer-list strong,
.codex-layer-list small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-layer-list strong {
  color: var(--color-text-body);
  font-size: 11px;
}

.codex-layer-list small {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 9px;
}

.codex-layer-detail {
  min-width: 0;
  overflow: auto;
  padding: 14px;
}

.codex-layer-detail pre {
  max-height: 470px;
  margin-top: 12px;
}

.codex-feature-list {
  max-height: clamp(480px, calc(100vh - 330px), 650px);
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-content);
}

.codex-feature-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 82px 38px;
  align-items: center;
  gap: 14px;
  min-height: 72px;
  border-bottom: 1px solid var(--color-border-subtle);
  padding: 11px 14px;
}

.codex-feature-row:last-child {
  border-bottom: 0;
}

.codex-feature-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.codex-feature-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.codex-feature-title strong {
  overflow: hidden;
  color: var(--color-text-body);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-feature-copy code {
  color: var(--color-primary);
  font-family: var(--font-mono);
  font-size: 9px;
}

.codex-feature-copy small {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-stage {
  display: inline-flex;
  min-height: 19px;
  flex: 0 0 auto;
  align-items: center;
  border-radius: 5px;
  background: var(--state-warning-bg);
  color: var(--state-warning);
  padding: 0 6px;
  font-size: 8px;
  font-weight: 800;
}

.codex-stage.stable {
  background: var(--state-success-bg);
  color: var(--state-success);
}

.codex-stage.deprecated,
.codex-stage.removed {
  background: var(--state-error-bg);
  color: var(--state-error);
}

.codex-feature-default {
  color: var(--color-text-muted);
  font-size: 9px;
  text-align: right;
}

.codex-mcp-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.codex-mcp-title-line em {
  border-radius: var(--radius-full);
  background: var(--color-primary-muted);
  color: var(--color-primary);
  padding: 3px 8px;
  font-size: 10px;
  font-style: normal;
  font-weight: 800;
}

.codex-summary-strip {
  grid-template-columns: repeat(5, minmax(100px, 1fr));
  gap: 10px;
}

.codex-summary-strip > .codex-summary-card {
  min-height: 70px;
  align-items: flex-start;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
  padding: 12px 14px;
}

.codex-summary-card > small {
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 750;
}

.codex-summary-card > strong {
  color: var(--color-text-primary);
  font-size: 24px;
  font-weight: 900;
  line-height: 1.2;
}

.codex-summary-card.primary > strong {
  color: var(--color-primary);
}

.codex-summary-card.success > strong {
  color: var(--state-success);
}

.codex-summary-card.warning > strong {
  color: var(--state-warning);
}

.codex-mcp-layout {
  display: grid;
  grid-template-columns: minmax(220px, 0.82fr) minmax(300px, 1.18fr) minmax(300px, 1fr);
  height: clamp(600px, calc(100vh - 310px), 680px);
  min-height: 0;
  gap: 12px;
}

.codex-mcp-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
}

.codex-mcp-layout .codex-list-pane {
  border-right: 1px solid var(--color-border);
  border-bottom: 0;
}

.codex-mcp-layout .codex-pane-title {
  min-height: auto;
  padding: 14px 14px 8px;
  border-bottom: 0;
}

.codex-mcp-layout .codex-pane-title strong,
.codex-mcp-panel-title > strong {
  font-size: 16px;
  font-weight: 840;
}

.codex-mcp-layout .codex-mcp-search {
  margin: 0 14px 12px;
}

.codex-mcp-server-list {
  overflow: auto;
  padding: 0 8px 8px;
}

.codex-mcp-server-list button {
  display: block;
  min-height: 84px;
  margin: 0 0 6px;
  width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  padding: 10px;
}

.codex-mcp-server-list button.active {
  border-color: var(--color-border-active);
  box-shadow: none;
}

.codex-server-copy > span:first-child,
.codex-server-tags {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.codex-server-copy > small {
  margin-top: 4px;
  font-family: var(--font-mono);
}

.codex-server-tags {
  justify-content: flex-start;
  margin-top: 8px;
}

.codex-server-tags i,
.codex-inventory-list button i,
.codex-detail-section-title i {
  border-radius: 5px;
  background: var(--color-bg-elevated);
  color: var(--color-text-muted);
  padding: 3px 6px;
  font-size: 9px;
  font-style: normal;
  font-weight: 760;
}

.codex-server-copy .codex-status {
  flex: 0 0 auto;
}

.codex-mcp-panel-head,
.codex-mcp-detail-head {
  border-bottom: 1px solid var(--color-border-subtle);
  padding: 14px;
}

.codex-mcp-panel-title,
.codex-mcp-detail-head,
.codex-detail-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.codex-mcp-panel-head .codex-subtabs {
  display: flex;
  margin-top: 12px;
}

.codex-mcp-panel-head .codex-subtabs button {
  flex: 1;
}

.codex-mcp-panel-title .codex-language-toggle {
  gap: 3px;
  border: 0;
  background: transparent;
  padding: 0;
}

.codex-mcp-panel-title .codex-advanced-toggle {
  margin-left: 5px;
}

.codex-inventory-panel {
  display: flex;
  flex-direction: column;
}

.codex-inventory-panel > .codex-inventory-list {
  flex: 1;
  overflow: auto;
  border: 0;
  background: transparent;
  padding: 8px;
}

.codex-inventory-panel .codex-inventory-list button {
  gap: 4px;
  margin-bottom: 6px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  padding: 10px 12px;
}

.codex-inventory-panel .codex-inventory-list button.active {
  border-color: var(--color-border-active);
  background: var(--color-bg-active);
  box-shadow: none;
}

.codex-inventory-list button > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.codex-inventory-panel .codex-inventory-list strong {
  font-size: 12px;
}

.codex-inventory-panel .codex-inventory-list small {
  font-family: var(--font-sans);
  font-size: 10px;
}

.codex-mcp-detail-panel {
  display: flex;
  flex-direction: column;
}

.codex-mcp-detail-head {
  align-items: flex-start;
}

.codex-mcp-detail-head h3 {
  margin: 0;
  color: var(--color-text-body);
  font-size: 16px;
}

.codex-mcp-detail-head p {
  margin: 3px 0 0;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 10px;
}

.codex-topology {
  display: flex;
  align-items: center;
  padding: 0 14px 14px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.codex-topology span {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  padding: 4px 7px;
  font-size: 8px;
  font-weight: 800;
}

.codex-topology span.active {
  border-color: var(--color-border-active);
  background: var(--color-primary-muted);
  color: var(--color-primary);
}

.codex-topology span.warning {
  color: var(--state-warning);
}

.codex-topology i {
  min-width: 6px;
  flex: 1;
  height: 1px;
  background: var(--color-border);
}

.codex-mcp-detail-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: auto;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
}

.codex-detail-section-title {
  margin-bottom: 8px;
}

.codex-detail-section-title.schema {
  margin-top: 14px;
}

.codex-detail-section-title strong {
  color: var(--color-text-body);
  font-size: 13px;
}

.codex-meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.codex-meta-grid > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-content);
  padding: 8px 10px;
}

.codex-meta-grid span,
.codex-dense-table span {
  color: var(--color-text-muted);
  font-size: 9px;
}

.codex-meta-grid strong {
  color: var(--color-text-body);
  font-size: 11px;
}

.codex-dense-table {
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
}

.codex-dense-table > div {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  gap: 10px;
  border-bottom: 1px solid var(--color-border-subtle);
  padding: 8px 10px;
}

.codex-dense-table > div:last-child {
  border-bottom: 0;
}

.codex-dense-table code {
  overflow-wrap: anywhere;
  color: var(--color-text-body);
  font-size: 9px;
}

.codex-mcp-detail-body pre {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-bg-content);
  padding: 12px;
  color: var(--color-text-body);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1.55;
  white-space: pre-wrap;
}

@media (max-width: 1180px) {
  .codex-thread-layout {
    grid-template-columns: 270px minmax(0, 1fr);
  }

  .codex-mcp-layout {
    grid-template-columns: 230px minmax(280px, 1fr) minmax(280px, 1fr);
  }

  .codex-thread-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .codex-summary-strip {
    grid-template-columns: repeat(5, minmax(90px, 1fr));
  }

  .codex-summary-strip > button {
    min-height: 48px;
  }

  .codex-thread-facts div:nth-child(2) {
    border-right: 0;
  }

  .codex-thread-facts div:nth-child(3),
  .codex-thread-facts div:nth-child(4) {
    border-top: 1px solid var(--color-border-subtle);
  }
}

@media (max-width: 900px) {
  .codex-admin-toolbar,
  .codex-admin-filterbar,
  .codex-config-head {
    align-items: stretch;
    flex-direction: column;
  }

  .codex-admin-context {
    justify-content: flex-end;
  }

  .codex-admin-tabs,
  .codex-subtabs {
    align-self: stretch;
  }

  .codex-inventory-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .codex-language-toggle {
    align-self: flex-end;
  }

  .codex-admin-tabs button,
  .codex-subtabs button {
    min-width: 0;
    flex: 1;
  }

  .codex-admin-split,
  .codex-thread-layout,
  .codex-config-layout,
  .codex-layer-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .codex-mcp-layout {
    height: auto;
    grid-template-columns: minmax(0, 1fr);
  }

  .codex-mcp-panel {
    min-height: 420px;
  }

  .codex-list-pane,
  .codex-config-list,
  .codex-layer-list {
    max-height: 320px;
    border-right: 0;
    border-bottom: 1px solid var(--color-border);
  }

  .codex-inventory-split {
    grid-template-columns: minmax(0, 1fr);
  }

  .codex-inventory-list {
    max-height: 220px;
    border-right: 0;
    border-bottom: 1px solid var(--color-border);
  }

  .codex-summary-strip {
    flex-wrap: wrap;
    grid-template-columns: minmax(0, 1fr);
  }

  .codex-summary-strip > button {
    margin-left: 0;
  }

  .codex-batch-row {
    grid-template-columns: minmax(0, 1fr) 86px 32px;
  }

  .codex-batch-row input:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
