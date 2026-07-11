<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi, type AiProvider, type DesktopRuntimeInfo, type ProviderActionKind, type ProviderStatus, type TokenUsageSummary, type TokenUsageSummaryItem } from "../services/desktop";
import CodexManagementPanel from "./CodexManagementPanel.vue";

const settingsIcon = new URL("../assets/icons/settings.svg", import.meta.url).href;
const riskGuardIcon = new URL("../assets/icons/risk-guard.svg", import.meta.url).href;
const aiProvidersIcon = new URL("../assets/icons/ai-providers.svg", import.meta.url).href;
const archiveBoxIcon = new URL("../assets/icons/archive-box.svg", import.meta.url).href;
const clipboardIcon = new URL("../assets/icons/clipboard.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerOpencodeIcon = new URL("../assets/icons/provider-opencode.svg", import.meta.url).href;
const providerMimoIcon = new URL("../assets/icons/provider-mimo.svg", import.meta.url).href;

type SettingsPanel = "connection" | "codex" | "mcp" | "security" | "about" | "archive" | "tokenUsage";
type ProviderRow = {
  provider: AiProvider;
  status?: ProviderStatus;
};
type SettingsPanelItem = {
  id: SettingsPanel;
  label: string;
  eyebrow: string;
  description: string;
  icon: string;
};

const ws = useWorkspace();
const router = useRouter();

const settingsPanel = ref<SettingsPanel>("connection");
const riskGuard = ref(true);
const commandLog = ref(true);
const localHistory = ref(true);
const autoReconnect = ref(true);
const cloudDeviceId = ref<string>("");
const cloudPaired = ref<boolean>(false);
const desktopRuntimeInfo = ref<DesktopRuntimeInfo | null>(null);
const providerRefreshLoading = ref(false);
const providerRefreshMessage = ref("");
const providerRefreshError = ref(false);
const providerActionMessages = ref<Record<string, string>>({});
const providerActionLoading = ref<Record<string, boolean>>({});
const npmRegistry = ref("");
const npmRegistryLoading = ref(false);
const npmRegistryMessage = ref("");
const npmRegistryError = ref(false);
const npmRegistryOptions = ref([
  { label: "npm 官方源", registry: "https://registry.npmjs.org/" },
  { label: "清华 TUNA", registry: "https://mirrors.tuna.tsinghua.edu.cn/npm/" },
  { label: "淘宝 npmmirror", registry: "https://registry.npmmirror.com/" },
  { label: "腾讯云镜像", registry: "https://mirrors.cloud.tencent.com/npm/" },
  { label: "华为云镜像", registry: "https://repo.huaweicloud.com/repository/npm/" },
]);
const npmRegistryProbeResults = ref<Record<string, number | null>>({});
const npmRegistryDropdownOpen = ref(false);
const manualInstallCommands = computed(() => {
  const registryArg = npmRegistry.value ? ` --registry=${npmRegistry.value}` : "";
  const mimoCommand = desktopRuntimeInfo.value?.platform === "linux"
    ? "curl -fsSL https://mimo.xiaomi.com/install | bash"
    : `npm install -g @mimo-ai/cli${registryArg}`;
  return [
    "# Claude Code",
    `npm i -g @anthropic-ai/claude-code@latest${registryArg}`,
    "# Codex",
    `npm i -g @openai/codex@latest${registryArg}`,
    "# OpenCode",
    `npm i -g opencode-ai@latest${registryArg}`,
    "# MiMo Code",
    mimoCommand,
  ].join("\n");
});

const settingsPanels: SettingsPanelItem[] = [
  {
    id: "connection",
    label: "连接",
    eyebrow: "基础",
    description: "账号状态、设备信息和本机历史位置",
    icon: settingsIcon,
  },
  {
    id: "codex",
    label: "Codex 管理",
    eyebrow: "原生",
    description: "管理 Codex 原生会话和本机配置",
    icon: providerCodexIcon,
  },
  {
    id: "mcp",
    label: "MCP 管理",
    eyebrow: "全局",
    description: "管理全局 MCP Server、工具和认证状态",
    icon: aiProvidersIcon,
  },
  {
    id: "security",
    label: "安全与历史",
    eyebrow: "保护",
    description: "高危确认、命令摘要和重连策略",
    icon: riskGuardIcon,
  },
  {
    id: "archive",
    label: "已归档对话",
    eyebrow: "历史",
    description: "查看和恢复已归档的 AI 会话",
    icon: archiveBoxIcon,
  },
  {
    id: "tokenUsage",
    label: "用量统计",
    eyebrow: "用量",
    description: "按 AI 工具聚合的 Token 用量,数据来自云端",
    icon: aiProvidersIcon,
  },
  {
    id: "about",
    label: "关于",
    eyebrow: "信息",
    description: "版本更新、Provider 诊断和桌面端信息",
    icon: aiProvidersIcon,
  },
];

const builtInProviders: AiProvider[] = [
  { id: "codex", name: "Codex", command: "codex", builtIn: true, enabled: true },
  { id: "claude", name: "Claude Code", command: "claude", builtIn: true, enabled: true },
  { id: "opencode", name: "OpenCode", command: "opencode", builtIn: true, enabled: true },
  { id: "mimo", name: "MiMo Code", command: "mimo", builtIn: true, enabled: true },
];
const providerOrder = new Map(builtInProviders.map((provider, index) => [provider.id, index]));

const providerRows = computed<ProviderRow[]>(() => {
  const map = new Map<string, ProviderRow>();
  for (const provider of builtInProviders) map.set(provider.id, { provider });
  for (const provider of ws.providers.value) {
    if (!map.has(provider.id)) map.set(provider.id, { provider });
  }
  for (const status of ws.providerStatuses.value) {
    const existing = map.get(status.providerId);
    if (existing) {
      existing.status = status;
    } else {
      map.set(status.providerId, {
        provider: {
          id: status.providerId,
          name: status.providerId,
          command: status.providerId,
          builtIn: false,
          enabled: true,
        },
        status,
      });
    }
  }
  return [...map.values()].sort((left, right) => (providerOrder.get(left.provider.id) ?? 99) - (providerOrder.get(right.provider.id) ?? 99));
});

const activePanelMeta = computed(() => {
  return settingsPanels.find((panel) => panel.id === settingsPanel.value) ?? settingsPanels[0];
});

const selectedNpmRegistryOption = computed(() => {
  return npmRegistryOptions.value.find((option) => option.registry === npmRegistry.value) ?? null;
});

const providerActionBusy = computed(() => Object.values(providerActionLoading.value).some(Boolean));

const updateSummaryText = computed(() => {
  if (ws.updateInstalling.value) return "正在下载并安装";
  if (ws.updateChecking.value) return "正在检查更新";
  if (ws.updateAvailableVersion.value) return `发现新版本 ${ws.updateAvailableVersion.value}`;
  if (ws.updateResultError.value) return "检查失败";
  if (ws.updateResult.value === "尚未检查更新。") return "尚未检查";
  return "已是最新";
});

const updateDetailText = computed(() => {
  if (ws.updateInstalling.value) return "";
  const text = ws.updateResult.value.trim();
  if (!text || text === "尚未检查更新。") return "";
  if (ws.updateChecking.value && text === "正在检查 GitHub Releases...") return "";
  if (!ws.updateResultError.value && !ws.updateAvailableVersion.value && text.startsWith("当前已经是最新版本")) return "";
  return text;
});

const desktopPlatformLabel = computed(() => {
  const platform = desktopRuntimeInfo.value?.platform;
  if (platform === "win32") return "Win";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform) return platform;
  return "系统";
});

function installedLabel(status?: ProviderStatus) {
  if (!status) return "待检测";
  return status.installed ? "已安装" : "未安装";
}

function installedTone(status?: ProviderStatus) {
  if (!status) return "neutral";
  return status.installed ? "success" : "warning";
}

function authLabel(status?: ProviderStatus) {
  if (!status?.installed) return "未检测";
  if (status.authStatus === "signedIn") return "已登录";
  if (status.authStatus === "signedOut") return "未登录";
  return "未知";
}

function authTone(status?: ProviderStatus) {
  if (!status?.installed) return "muted";
  if (status.authStatus === "signedIn") return "success";
  if (status.authStatus === "signedOut") return "warning";
  return "neutral";
}

function providerDetail(row: ProviderRow) {
  if (!row.status) return `等待检测 ${row.provider.command}`;
  if (!row.status.installed) return `未找到命令：${row.provider.command}`;
  return row.status.version ?? `${row.provider.command} 可执行`;
}

function latestVersionLabel(status?: ProviderStatus) {
  if (!status) return "待检测";
  if (status.latestVersion) return status.latestVersion;
  if (status.versionCheckError === "暂未配置版本源") return "未配置";
  if (status.versionCheckError) return "检查失败";
  return "未知";
}

function latestVersionTone(status?: ProviderStatus) {
  if (!status) return "muted";
  if (status.updateAvailable) return "warning";
  if (status.versionCheckError) return "muted";
  if (status.latestVersion) return "success";
  return "muted";
}

function providerVersionNote(status?: ProviderStatus) {
  if (!status) return "";
  if (status.updateAvailable) return "发现新版本";
  if (status.versionCheckError && status.versionCheckError !== "暂未配置版本源") return "版本检查失败";
  if (status.installed && status.latestVersion && status.updateAvailable === false) return "已是最新";
  if (status.installed && status.latestVersion && status.updateAvailable === null) return "版本待确认";
  if (!status.installed && status.latestVersion) return "可安装最新版";
  return "";
}

function providerActionKind(row: ProviderRow): ProviderActionKind | null {
  if (!row.status) return null;
  if (!row.status.installed && (row.status.installCommand || row.status.installUrl)) return "install";
  if (row.status.installed && row.status.updateAvailable && (row.status.updateCommand || row.status.installUrl)) return "update";
  return null;
}

function providerActionLabel(row: ProviderRow) {
  const kind = providerActionKind(row);
  if (kind === "install") return "安装";
  if (kind === "update") return "更新";
  return "";
}

function providerActionFeedback(row: ProviderRow) {
  return providerActionMessages.value[row.provider.id] ?? providerVersionNote(row.status);
}

function runningSessionUpdateMessage() {
  return "当前有会话正在运行，请先停止当前会话后再更新。";
}

async function installAppUpdateSafely() {
  if (await ws.hasBlockingAiRun()) {
    ws.updateResultError.value = true;
    ws.updateResult.value = runningSessionUpdateMessage();
    return;
  }
  await ws.installAppUpdate();
}

async function runProviderAction(row: ProviderRow) {
  const kind = providerActionKind(row);
  const label = providerActionLabel(row);
  if (!kind || !label || !row.status || providerActionBusy.value || providerRefreshLoading.value) return;
  npmRegistryDropdownOpen.value = false;
  providerActionLoading.value = { ...providerActionLoading.value, [row.provider.id]: true };
  try {
    if (await ws.hasBlockingAiRun()) {
      providerActionMessages.value = {
        ...providerActionMessages.value,
        [row.provider.id]: runningSessionUpdateMessage(),
      };
      return;
    }
    providerActionMessages.value = { ...providerActionMessages.value, [row.provider.id]: `正在${label}...` };
    const hasCommand = kind === "install"
      ? Boolean(row.status.installCommand)
      : Boolean(row.status.updateCommand || row.status.installCommand);
    if (!hasCommand && row.status.installUrl) {
      await desktopApi.openExternalUrl(row.status.installUrl);
      providerActionMessages.value = { ...providerActionMessages.value, [row.provider.id]: "已打开安装说明" };
      return;
    }
    const result = await desktopApi.runProviderAction(row.provider.id, kind);
    if (!result.success) {
      const detail = result.output ? `：${result.output.slice(0, 180)}` : "";
      throw new Error(`${label}命令执行失败${detail}`);
    }
    providerActionMessages.value = { ...providerActionMessages.value, [row.provider.id]: `${label}命令已完成，正在重新检测...` };
    const refreshed = await refreshProviderDiagnosticsNow();
    const refreshedStatus = ws.providerStatuses.value.find((status) => status.providerId === row.provider.id);
    let message: string;
    if (!refreshed) {
      message = `${label}命令已完成，但重新检测失败，请手动刷新`;
    } else if (kind === "install") {
      message = refreshedStatus?.installed ? "安装完成" : "安装命令已完成，但未检测到本机命令";
    } else if (refreshedStatus?.updateAvailable === false) {
      message = "更新完成";
    } else if (refreshedStatus?.updateAvailable === true) {
      message = "更新命令已完成，但当前版本仍低于最新版本";
    } else {
      message = "更新命令已完成，版本待确认";
    }
    providerActionMessages.value = { ...providerActionMessages.value, [row.provider.id]: message };
  } catch (error) {
    providerActionMessages.value = {
      ...providerActionMessages.value,
      [row.provider.id]: `${label}失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    providerActionLoading.value = { ...providerActionLoading.value, [row.provider.id]: false };
  }
}

function providerIcon(providerId: string) {
  if (providerId === "codex") return providerCodexIcon;
  if (providerId === "claude") return providerClaudeIcon;
  if (providerId === "opencode") return providerOpencodeIcon;
  if (providerId === "mimo") return providerMimoIcon;
  return aiProvidersIcon;
}

function checkedAt(status?: ProviderStatus) {
  if (!status?.lastCheckedAt) return "尚未检测";
  const date = new Date(status.lastCheckedAt);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleTimeString();
}

async function refreshProviderDiagnosticsNow(): Promise<boolean> {
  providerRefreshLoading.value = true;
  providerRefreshError.value = false;
  providerRefreshMessage.value = "正在重新检测本机命令...";
  try {
    await Promise.all([ws.detectProviders(), refreshDesktopRuntimeInfo()]);
    const checkedTimes = ws.providerStatuses.value
      .map((status) => new Date(status.lastCheckedAt).getTime())
      .filter((value) => Number.isFinite(value));
    const lastCheckedAt = checkedTimes.length ? new Date(Math.max(...checkedTimes)).toLocaleTimeString() : "";
    providerRefreshMessage.value = lastCheckedAt ? `已刷新：${lastCheckedAt}` : "已刷新";
    return true;
  } catch (error) {
    providerRefreshError.value = true;
    providerRefreshMessage.value = `刷新失败：${error instanceof Error ? error.message : String(error)}`;
    return false;
  } finally {
    providerRefreshLoading.value = false;
  }
}

async function refreshProviderDiagnostics() {
  if (providerRefreshLoading.value || providerActionBusy.value) return;
  await refreshProviderDiagnosticsNow();
}

function updateNpmRegistryState(info: Awaited<ReturnType<typeof desktopApi.getNpmRegistry>>) {
  npmRegistry.value = info.registry;
  if (info.options?.length) npmRegistryOptions.value = info.options;
  if (info.probeResults?.length) {
    npmRegistryProbeResults.value = Object.fromEntries(info.probeResults.map((result) => [
      result.registry,
      result.ok ? result.latencyMs ?? null : null,
    ]));
  }
}

function npmRegistryLatencyLabel(registry: string) {
  const latency = npmRegistryProbeResults.value[registry];
  return latency ? ` · ${latency}ms` : "";
}

function npmRegistryLatencyText(registry: string) {
  const latency = npmRegistryProbeResults.value[registry];
  return latency ? `${latency}ms` : "";
}

async function loadNpmRegistry() {
  npmRegistryLoading.value = true;
  npmRegistryError.value = false;
  npmRegistryMessage.value = "正在检测 npm 源...";
  try {
    const info = await desktopApi.getNpmRegistry();
    updateNpmRegistryState(info);
    npmRegistryError.value = !info.success;
    npmRegistryMessage.value = info.success ? `当前源：${info.registry}` : info.error ?? "读取 npm 源失败";
  } catch (error) {
    npmRegistryError.value = true;
    npmRegistryMessage.value = `读取 npm 源失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    npmRegistryLoading.value = false;
  }
}

async function changeNpmRegistry(registry: string) {
  if (!registry || npmRegistryLoading.value || providerActionBusy.value || providerRefreshLoading.value) return;
  npmRegistryDropdownOpen.value = false;
  npmRegistryLoading.value = true;
  npmRegistryError.value = false;
  npmRegistryMessage.value = "正在切换 npm 源...";
  try {
    const info = await desktopApi.setNpmRegistry(registry);
    updateNpmRegistryState(info);
    npmRegistryError.value = !info.success;
    npmRegistryMessage.value = info.success ? `已切换 npm 源：${info.registry}` : info.error ?? "切换 npm 源失败";
    if (info.success) await refreshProviderDiagnostics();
  } catch (error) {
    npmRegistryError.value = true;
    npmRegistryMessage.value = `切换 npm 源失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    npmRegistryLoading.value = false;
  }
}

function toggleNpmRegistryDropdown() {
  if (npmRegistryLoading.value || providerActionBusy.value || providerRefreshLoading.value) return;
  npmRegistryDropdownOpen.value = !npmRegistryDropdownOpen.value;
}

function closeNpmRegistryDropdown() {
  npmRegistryDropdownOpen.value = false;
}

function handleNpmRegistryDropdownFocusout(event: FocusEvent) {
  const current = event.currentTarget as HTMLElement | null;
  const next = event.relatedTarget as Node | null;
  if (current && next && current.contains(next)) return;
  closeNpmRegistryDropdown();
}

function selectNpmRegistry(registry: string) {
  void changeNpmRegistry(registry);
}

async function probeNpmRegistries() {
  if (npmRegistryLoading.value || providerActionBusy.value || providerRefreshLoading.value) return;
  npmRegistryLoading.value = true;
  npmRegistryError.value = false;
  npmRegistryMessage.value = "正在测速 npm 源...";
  try {
    const info = await desktopApi.probeNpmRegistries();
    updateNpmRegistryState(info);
    npmRegistryError.value = !info.success;
    npmRegistryMessage.value = info.success ? `已选择最快源：${info.registry}` : info.error ?? "npm 源测速失败";
    if (info.success) await refreshProviderDiagnostics();
  } catch (error) {
    npmRegistryError.value = true;
    npmRegistryMessage.value = `npm 源测速失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    npmRegistryLoading.value = false;
  }
}

function goBack() {
  if (router.currentRoute.value.path !== "/chat") {
    void router.push("/chat");
  }
}

async function copyDeviceId() {
  if (!cloudDeviceId.value) return;
  try {
    await navigator.clipboard.writeText(cloudDeviceId.value);
  } catch {
    /* ignore clipboard errors */
  }
}

async function copyManualInstallCommands() {
  try {
    await navigator.clipboard.writeText(manualInstallCommands.value);
  } catch {
    /* ignore clipboard errors */
  }
}

async function refreshCloudConfig() {
  try {
    const config = await desktopApi.getCloudConfig();
    cloudDeviceId.value = config?.deviceId ?? "";
    cloudPaired.value = Boolean(config?.paired);
  } catch {
    /* ignore */
  }
}

async function refreshDesktopRuntimeInfo() {
  try {
    desktopRuntimeInfo.value = await desktopApi.getDesktopRuntimeInfo();
  } catch {
    desktopRuntimeInfo.value = null;
  }
}

const deviceIdDisplay = computed(() => {
  if (!cloudDeviceId.value) return "未登录";
  const id = cloudDeviceId.value;
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
});

const tokenUsageSummary = ref<TokenUsageSummary | null>(null);
const tokenUsageLoading = ref(false);
const tokenUsageError = ref<string>("");
const tokenUsageLoaded = ref(false);

const tokenUsageRows = computed<(TokenUsageSummaryItem & { name: string; icon: string })[]>(() => {
  const rows = tokenUsageSummary.value?.providers ?? [];
  return rows.map((row) => ({
    ...row,
    name: providerNameForId(row.providerId),
    icon: providerIcon(row.providerId),
  }));
});

const tokenUsageTotals = computed<TokenUsageSummaryItem>(() => {
  return tokenUsageSummary.value?.totals ?? {
    providerId: "",
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    turnCount: 0,
  };
});

function providerNameForId(id: string) {
  const map: Record<string, string> = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode", mimo: "MiMo Code" };
  return map[id] ?? id;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function refreshTokenUsage() {
  if (tokenUsageLoading.value) return;
  tokenUsageLoading.value = true;
  tokenUsageError.value = "";
  try {
    tokenUsageSummary.value = await desktopApi.getTokenUsageSummary();
    tokenUsageLoaded.value = true;
  } catch (e) {
    tokenUsageError.value = e instanceof Error ? e.message : "加载失败";
    tokenUsageSummary.value = null;
  } finally {
    tokenUsageLoading.value = false;
  }
}

watch(settingsPanel, (panel) => {
  if (panel === "tokenUsage" && !tokenUsageLoaded.value) {
    void refreshTokenUsage();
  }
});

onMounted(() => {
  const requestedPanel = window.localStorage.getItem("ai-workbench.settingsPanel");
  if (requestedPanel && settingsPanels.some((panel) => panel.id === requestedPanel)) {
    settingsPanel.value = requestedPanel as SettingsPanel;
    window.localStorage.removeItem("ai-workbench.settingsPanel");
  }
  void refreshCloudConfig();
  void refreshDesktopRuntimeInfo();
  void loadNpmRegistry();
});

function archivedAtLabel(value?: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function projectNameForSession(path?: string | null) {
  if (!path) return "未关联项目";
  const match = ws.projects.value.find((project) => project.path === path);
  return match?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

async function restoreSession(sessionId: string) {
  await ws.archiveAiSession(sessionId, false);
}
</script>

<template>
  <main class="app-fullscreen">
    <section class="view active settings-page" data-view-panel="settings">
      <aside class="settings-nav">
        <div class="settings-nav-top">
          <button class="settings-back-button" type="button" aria-label="返回首页" @click="goBack">
            <span aria-hidden="true"></span>
            返回首页
          </button>
          <div class="settings-nav-title">
            <strong>设置</strong>
            <small>桌面工作台配置</small>
          </div>
        </div>

        <nav class="settings-nav-list" aria-label="设置分组">
          <button
            v-for="panel in settingsPanels"
            :key="panel.id"
            :class="{ active: settingsPanel === panel.id }"
            type="button"
            @click="settingsPanel = panel.id"
          >
            <span class="settings-nav-marker" aria-hidden="true"></span>
            <span class="settings-nav-copy">
              <span class="settings-nav-title-row">
                <img :src="panel.icon" alt="" class="settings-nav-icon" />
                <strong>{{ panel.label }}</strong>
              </span>
            </span>
            <span class="settings-nav-eyebrow">{{ panel.eyebrow }}</span>
          </button>
        </nav>

        <div class="settings-nav-foot">
          <span>连接状态</span>
          <strong>{{ cloudPaired ? "已登录" : "未登录" }}</strong>
        </div>
      </aside>

      <div class="settings-content">
        <div class="settings-scroll">
          <header class="settings-header">
            <div>
              <span class="settings-kicker">Desktop Settings</span>
              <h1>{{ activePanelMeta.label }}</h1>
              <p>{{ activePanelMeta.description }}。</p>
            </div>
            <button v-if="settingsPanel === 'tokenUsage'" class="button secondary narrow" type="button" :disabled="tokenUsageLoading" @click="refreshTokenUsage">
              {{ tokenUsageLoading ? "刷新中…" : "刷新" }}
            </button>
          </header>

          <div v-if="settingsPanel === 'connection'" class="settings-overview settings-overview-status" aria-label="连接概览">
            <article class="settings-overview-card">
              <div class="settings-overview-card-head">
                <span class="settings-overview-dot" :class="{ on: cloudPaired }" aria-hidden="true"></span>
                <span>状态</span>
              </div>
              <strong :class="{ 'stat-success': cloudPaired, 'stat-muted': !cloudPaired }">{{ cloudPaired ? "已登录" : "未登录" }}</strong>
            </article>
            <article class="settings-overview-card">
              <div class="settings-overview-card-head">
                <span>设备 ID</span>
              </div>
              <div class="settings-overview-device-row">
                <code>{{ deviceIdDisplay }}</code>
                <button
                  v-if="cloudDeviceId"
                  class="settings-overview-copy"
                  type="button"
                  aria-label="复制设备 ID"
                  @click="copyDeviceId"
                >
                  <img :src="clipboardIcon" alt="" />
                </button>
              </div>
            </article>
          </div>

          <section v-if="settingsPanel === 'connection'" class="settings-section">
            <div class="settings-section-heading">
              <div>
                <h2 class="settings-section-title">连接设置</h2>
                <p class="settings-section-description">查看桌面工作台连接状态和本机同步设置。</p>
              </div>
              <span class="settings-section-chip">本机优先</span>
            </div>
            <div class="settings-card settings-connection-card">
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>服务器地址</strong>
                  <small>当前登录使用的后端地址</small>
                </span>
                <input class="settings-input settings-server-input" type="text" :value="ws.settingsServer.value" readonly placeholder="未设置" />
              </label>
              <label class="settings-row settings-toggle-row settings-toggle-divider">
                <span class="settings-row-copy">
                  <strong>自动重连</strong>
                  <small>断开后自动尝试重新连接</small>
                </span>
                <input v-model="autoReconnect" class="settings-switch" type="checkbox" />
              </label>
            </div>
          </section>

          <section v-if="settingsPanel === 'security'" class="settings-section">
            <div class="settings-card">
              <label class="settings-row settings-toggle-row">
                <span class="settings-row-copy">
                  <strong>风险保护</strong>
                  <small>高危命令需要确认</small>
                </span>
                <input v-model="riskGuard" class="settings-switch" type="checkbox" />
              </label>
              <label class="settings-row settings-toggle-row">
                <span class="settings-row-copy">
                  <strong>命令日志</strong>
                  <small>记录命令摘要和风险结果</small>
                </span>
                <input v-model="commandLog" class="settings-switch" type="checkbox" />
              </label>
              <label class="settings-row settings-toggle-row">
                <span class="settings-row-copy">
                  <strong>完整历史</strong>
                  <small>聊天内容默认只保存在桌面本机</small>
                </span>
                <input v-model="localHistory" class="settings-switch" type="checkbox" />
              </label>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'about'" class="settings-section settings-about-page">
            <div class="settings-about-update">
              <h2 class="settings-block-title">应用更新</h2>
              <div class="settings-about-update-card">
                <div class="settings-about-update-main">
                  <div class="settings-about-update-copy">
                    <span class="settings-about-update-label">当前版本</span>
                    <div class="settings-about-update-version-row">
                      <strong>{{ ws.updateCurrentVersion.value }}</strong>
                      <span class="settings-about-update-state" :class="{ error: ws.updateResultError.value, available: ws.updateAvailableVersion.value }">
                        {{ updateSummaryText }}
                      </span>
                    </div>
                  </div>
                  <div class="settings-about-update-actions">
                    <button class="button secondary" type="button" :disabled="ws.updateChecking.value || ws.updateInstalling.value" @click="ws.checkAppUpdate">
                      {{ ws.updateChecking.value ? "检查中" : "检查更新" }}
                    </button>
                    <button class="button primary" type="button" :disabled="!ws.updateAvailableVersion.value || !ws.updateInstallable.value || ws.updateInstalling.value" @click="installAppUpdateSafely">
                      {{ ws.updateInstalling.value ? "安装中" : "下载并安装" }}
                    </button>
                  </div>
                </div>
                <div v-if="ws.updateInstalling.value || ws.updateDownloadProgress.value" class="settings-about-update-progress">
                  <div
                    class="settings-about-update-progress-track"
                    :class="{ indeterminate: ws.updateDownloadPercent.value === null }"
                    role="progressbar"
                    aria-label="下载进度"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="ws.updateDownloadPercent.value ?? undefined"
                  >
                    <span
                      class="settings-about-update-progress-fill"
                      :style="{ width: `${ws.updateDownloadPercent.value ?? 100}%` }"
                    ></span>
                  </div>
                  <p class="settings-about-update-progress-meta">
                    <span>{{ ws.updateDownloadProgressLabel.value }}</span>
                    <small v-if="ws.updateDownloadSizeLabel.value">{{ ws.updateDownloadSizeLabel.value }}</small>
                  </p>
                </div>
                <p v-if="updateDetailText" class="settings-about-update-result" :class="{ error: ws.updateResultError.value }">{{ updateDetailText }}</p>
              </div>
            </div>

            <div class="settings-provider-grid-block">
              <div class="settings-provider-grid-head">
                <div>
                  <h2 class="settings-block-title">本地环境检查</h2>
                  <p class="settings-provider-grid-sub">管理和监控已安装的 AI 编程工具</p>
                </div>
                <div class="settings-provider-grid-actions">
                  <div class="settings-npm-registry-dropdown" @focusout="handleNpmRegistryDropdownFocusout">
                    <button
                      class="settings-npm-registry-trigger"
                      :class="{ open: npmRegistryDropdownOpen }"
                      type="button"
                      :disabled="npmRegistryLoading || providerActionBusy || providerRefreshLoading"
                      aria-haspopup="listbox"
                      :aria-expanded="npmRegistryDropdownOpen"
                      @click="toggleNpmRegistryDropdown"
                    >
                      <span>{{ selectedNpmRegistryOption?.label ?? "选择 npm 源" }}</span>
                      <small v-if="selectedNpmRegistryOption">{{ npmRegistryLatencyText(selectedNpmRegistryOption.registry) }}</small>
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <div v-if="npmRegistryDropdownOpen" class="settings-npm-registry-menu" role="listbox">
                      <button
                        v-for="option in npmRegistryOptions"
                        :key="option.registry"
                        class="settings-npm-registry-option"
                        :class="{ active: option.registry === npmRegistry }"
                        type="button"
                        role="option"
                        :disabled="providerActionBusy || providerRefreshLoading"
                        :aria-selected="option.registry === npmRegistry"
                        @mousedown.prevent
                        @click="selectNpmRegistry(option.registry)"
                      >
                        <span>{{ option.label }}</span>
                        <small>{{ option.registry }}</small>
                        <em v-if="npmRegistryLatencyText(option.registry)">{{ npmRegistryLatencyText(option.registry) }}</em>
                      </button>
                    </div>
                  </div>
                  <button class="button secondary mini" type="button" :disabled="npmRegistryLoading || providerActionBusy || providerRefreshLoading" @click="probeNpmRegistries">
                    {{ npmRegistryLoading ? "检测中" : "测速选源" }}
                  </button>
                  <button class="button secondary mini" type="button" :disabled="providerRefreshLoading || providerActionBusy" @click="refreshProviderDiagnostics">
                    {{ providerRefreshLoading ? "刷新中" : "刷新" }}
                  </button>
                </div>
              </div>
              <p v-if="npmRegistryMessage" :class="['settings-provider-refresh-note', { error: npmRegistryError }]">
                {{ npmRegistryMessage }}
              </p>
              <p v-if="providerRefreshMessage" :class="['settings-provider-refresh-note', { error: providerRefreshError }]">
                {{ providerRefreshMessage }}
              </p>
              <div class="settings-provider-grid">
                <div v-if="!providerRows.length" class="empty-state">暂无 Provider。</div>
                <article v-for="row in providerRows" :key="row.provider.id" class="settings-provider-card">
                  <div class="settings-provider-card-head">
                    <div class="settings-provider-card-id">
                      <img class="settings-provider-card-icon" :src="providerIcon(row.provider.id)" alt="" aria-hidden="true" />
                      <strong>{{ row.provider.name }}</strong>
                    </div>
                    <span class="settings-provider-card-platform">{{ desktopPlatformLabel }}</span>
                  </div>
                  <div class="settings-provider-card-rows">
                    <div class="settings-provider-card-row">
                      <span>当前版本</span>
                      <code v-if="row.status?.installed">{{ row.status?.version || "未知" }}</code>
                      <span v-else class="muted">未安装</span>
                    </div>
                    <div class="settings-provider-card-row">
                      <span>最新版本</span>
                      <span :class="['muted', latestVersionTone(row.status)]">{{ latestVersionLabel(row.status) }}</span>
                    </div>
                    <div class="settings-provider-card-row">
                      <span>登录状态</span>
                      <span :class="['muted', authTone(row.status)]">{{ authLabel(row.status) }}</span>
                    </div>
                  </div>
                  <div class="settings-provider-card-actions">
                    <button
                      v-if="providerActionKind(row)"
                      :class="['button', providerActionKind(row) === 'install' ? 'primary' : 'secondary', 'mini', 'narrow']"
                      type="button"
                      :disabled="providerActionBusy || providerRefreshLoading"
                      @click="runProviderAction(row)"
                    >
                      {{ providerActionLoading[row.provider.id] ? `${providerActionLabel(row)}中` : providerActionLabel(row) }}
                    </button>
                    <span v-if="providerActionFeedback(row)" class="settings-provider-card-action-note">{{ providerActionFeedback(row) }}</span>
                  </div>
                  <div class="settings-provider-card-foot">
                    <span class="badge" :class="installedTone(row.status)">{{ installedLabel(row.status) }}</span>
                    <span class="settings-provider-card-checked">{{ checkedAt(row.status) }}</span>
                    <code class="settings-provider-card-command">{{ row.provider.command }}</code>
                  </div>
                </article>
              </div>
              <details class="settings-manual-install">
                <summary>
                  <span>手动安装命令</span>
                </summary>
                <div class="settings-manual-install-card">
                  <div class="settings-manual-install-head">
                    <span>安装或升级 Claude Code / Codex / OpenCode / MiMo Code</span>
                    <button class="button secondary mini settings-manual-install-copy" type="button" aria-label="复制手动安装命令" @click="copyManualInstallCommands">
                      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                      </svg>
                    </button>
                  </div>
                  <pre><code>{{ manualInstallCommands }}</code></pre>
                </div>
              </details>
            </div>

          </section>

          <section v-else-if="settingsPanel === 'archive'" class="settings-section">
            <div class="settings-archive-list">
              <div v-if="!ws.archivedSessions.value.length" class="empty-state">暂无已归档的 AI 会话。</div>
              <article
                v-for="session in ws.archivedSessions.value"
                :key="session.id"
                class="settings-archive-item"
              >
                <div class="settings-archive-main">
                  <strong>{{ session.title || "未命名会话" }}</strong>
                  <small>{{ archivedAtLabel(session.archivedAt) }} · {{ projectNameForSession(session.summary) }}</small>
                </div>
                <button class="button secondary mini" type="button" @click="restoreSession(session.id)">
                  取消归档
                </button>
              </article>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'tokenUsage'" class="settings-section settings-token-usage">
            <p v-if="tokenUsageError" class="settings-token-usage-error">{{ tokenUsageError }}</p>

            <div class="settings-token-usage-overview">
              <article class="settings-token-usage-card">
                <div class="settings-token-usage-card-head">
                  <span class="settings-token-usage-icon icon-info" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M12 3v12m0 4v2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M12 3l-6 8h12L12 3z" fill="currentColor"/></svg>
                  </span>
                  <span class="settings-token-usage-card-label">总输入</span>
                </div>
                <strong>{{ formatTokens(tokenUsageTotals.inputTokens) }}</strong>
              </article>
              <article class="settings-token-usage-card">
                <div class="settings-token-usage-card-head">
                  <span class="settings-token-usage-icon icon-success" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M12 21V9m0 0L7 4m5 5l5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
                  </span>
                  <span class="settings-token-usage-card-label">总输出</span>
                </div>
                <strong>{{ formatTokens(tokenUsageTotals.outputTokens) }}</strong>
              </article>
              <article class="settings-token-usage-card">
                <div class="settings-token-usage-card-head">
                  <span class="settings-token-usage-icon icon-warning" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M9 4c0-1.7 1.3-3 3-3s3 1.3 3 3v9c0 1.7-1.3 3-3 3s-3-1.3-3-3V4z" fill="currentColor"/><path d="M12 19v3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>
                  </span>
                  <span class="settings-token-usage-card-label">推理 Token</span>
                </div>
                <strong>{{ formatTokens(tokenUsageTotals.reasoningTokens) }}</strong>
              </article>
              <article class="settings-token-usage-card highlight">
                <div class="settings-token-usage-card-head">
                  <span class="settings-token-usage-icon icon-primary" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" fill="currentColor"/></svg>
                  </span>
                  <span class="settings-token-usage-card-label">合计</span>
                </div>
                <strong>{{ formatTokens(tokenUsageTotals.totalTokens) }}</strong>
              </article>
            </div>

            <div class="settings-token-usage-detail">
              <h3>工具用量明细</h3>
              <div v-if="!tokenUsageLoading && tokenUsageRows.length === 0" class="settings-token-usage-empty">
                <span class="settings-token-usage-empty-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 16l3-4 3 2 4-6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </span>
                <strong>暂无 Token 用量数据</strong>
                <span>发起一次 AI 会话后会自动统计。</span>
              </div>
              <div v-else class="settings-token-usage-table-wrap">
                <table class="settings-token-usage-table">
                  <thead>
                    <tr>
                      <th>工具</th>
                      <th>输入 Token</th>
                      <th>输出 Token</th>
                      <th>推理 Token</th>
                      <th>合计</th>
                      <th>会话次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in tokenUsageRows" :key="row.providerId">
                      <td>
                        <span class="settings-token-usage-tool">
                          <span class="settings-token-usage-tool-icon" aria-hidden="true">
                            <img :src="row.icon" alt="" />
                          </span>
                          <span>{{ row.name }}</span>
                        </span>
                      </td>
                      <td class="num">{{ formatTokens(row.inputTokens) }}</td>
                      <td class="num">{{ formatTokens(row.outputTokens) }}</td>
                      <td class="num reasoning">{{ formatTokens(row.reasoningTokens) }}</td>
                      <td class="num total">{{ formatTokens(row.totalTokens) }}</td>
                      <td class="num">{{ row.turnCount }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'codex'" class="settings-section">
            <CodexManagementPanel :cwd="ws.selectedProjectPath.value" />
          </section>

          <section v-else-if="settingsPanel === 'mcp'" class="settings-section">
            <CodexManagementPanel mode="mcp" />
          </section>
        </div>
      </div>
    </section>
  </main>
</template>
