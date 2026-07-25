<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import ArcoTable, { TableColumn as ArcoTableColumn } from "@arco-design/web-vue/es/table";
import { useRoute, useRouter } from "vue-router";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi, type AiActivityProject, type AiActivitySummary, type AiProvider, type DesktopRuntimeInfo, type ProviderActionKind, type ProviderStatus, type TokenUsageDailyItem, type TokenUsageSummary, type TokenUsageSummaryItem } from "../services/desktop";
import CodexManagementPanel from "./CodexManagementPanel.vue";
import ResourceCenterView from "./ResourceCenterView.vue";

const settingsIcon = new URL("../assets/icons/settings.svg", import.meta.url).href;
const riskGuardIcon = new URL("../assets/icons/risk-guard.svg", import.meta.url).href;
const aiProvidersIcon = new URL("../assets/icons/ai-providers.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerOpencodeIcon = new URL("../assets/icons/provider-opencode.svg", import.meta.url).href;
const providerMimoIcon = new URL("../assets/icons/provider-mimo.svg", import.meta.url).href;
const copyIcon = new URL("../assets/icons/copy.svg", import.meta.url).href;

type SettingsPanel = "connection" | "codex" | "resources" | "security" | "activity" | "about" | "tokenUsage";
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
const route = useRoute();
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
    label: "会话管理",
    eyebrow: "原生",
    description: "管理 Codex 原生会话、归档会话和本机配置",
    icon: providerCodexIcon,
  },
  {
    id: "resources",
    label: "资源中心",
    eyebrow: "资源",
    description: "管理对后续会话生效的 MCP 服务与 Skills",
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
    id: "activity",
    label: "AI 活跃记录",
    eyebrow: "本地",
    description: "查看最近 12 个月的本地对话交互、连续活跃和使用节奏",
    icon: aiProvidersIcon,
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

const deviceIdDisplay = computed(() => cloudDeviceId.value || "未登录");

const tokenUsageSummary = ref<TokenUsageSummary | null>(null);
const aiActivitySummary = ref<AiActivitySummary | null>(null);
const tokenUsageLoading = ref(false);
const tokenUsageError = ref<string>("");
const tokenUsageLoaded = ref(false);
const tokenUsagePeriod = ref<7 | 30 | 90>(30);
const tokenUsagePeriods = [7, 30, 90] as const;
const activityLoading = ref(false);
const activityError = ref("");
const activityLoaded = ref(false);

type TokenUsageRow = TokenUsageSummaryItem & {
  name: string;
  icon: string;
  inputHitTokens: number;
  inputMissTokens: number;
  displayOutputTokens: number;
  averageTokens: number;
  sharePercent: number;
  statusLabel: string;
  statusTone: "success" | "warning" | "neutral";
};

const tokenUsageRows = computed<TokenUsageRow[]>(() => {
  const rows = tokenUsageSummary.value?.providers ?? [];
  const total = tokenUsageSummary.value?.totals.totalTokens ?? 0;
  return rows
    .map((row) => {
      const sharePercent = total > 0 ? (row.totalTokens / total) * 100 : 0;
      const inputHitTokens = Math.min(row.inputTokens, Math.max(0, row.cachedInputTokens ?? 0));
      const inputMissTokens = Math.max(0, row.inputTokens - inputHitTokens);
      const displayOutputTokens = Math.max(row.outputTokens, row.totalTokens - row.inputTokens, 0);
      const statusLabel = sharePercent >= 50 ? "高频" : sharePercent >= 15 ? "活跃" : "稳定";
      return {
        ...row,
        name: providerNameForId(row.providerId),
        icon: providerIcon(row.providerId),
        inputHitTokens,
        inputMissTokens,
        displayOutputTokens,
        averageTokens: row.turnCount > 0 ? Math.round(row.totalTokens / row.turnCount) : 0,
        sharePercent,
        statusLabel,
        statusTone: sharePercent >= 15 ? "success" as const : "neutral" as const,
      };
    })
    .sort((left, right) => right.totalTokens - left.totalTokens);
});

const tokenUsageTotals = computed<TokenUsageSummaryItem>(() => {
  return tokenUsageSummary.value?.totals ?? {
    providerId: "",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    turnCount: 0,
  };
});

const tokenAveragePerTurn = computed(() => tokenUsageTotals.value.turnCount > 0
  ? Math.round(tokenUsageTotals.value.totalTokens / tokenUsageTotals.value.turnCount)
  : 0);

const tokenMix = computed(() => {
  const inputHitTokens = Math.min(tokenUsageTotals.value.inputTokens, Math.max(0, tokenUsageTotals.value.cachedInputTokens ?? 0));
  const inputMissTokens = Math.max(0, tokenUsageTotals.value.inputTokens - inputHitTokens);
  const outputTokens = Math.max(tokenUsageTotals.value.outputTokens, tokenUsageTotals.value.totalTokens - tokenUsageTotals.value.inputTokens, 0);
  const total = inputHitTokens + inputMissTokens + outputTokens;
  const percentage = (value: number) => total > 0 ? (value / total) * 100 : 0;
  return [
    { id: "hit", label: "输入命中", value: inputHitTokens, percent: percentage(inputHitTokens), note: "缓存复用" },
    { id: "miss", label: "输入未命中", value: inputMissTokens, percent: percentage(inputMissTokens), note: "新输入与上下文" },
    { id: "output", label: "输出", value: outputTokens, percent: percentage(outputTokens), note: "回复与推理" },
  ];
});

const tokenTrendDays = computed<TokenUsageDailyItem[]>(() => {
  const length = Math.min(14, tokenUsagePeriod.value);
  const source = new Map((tokenUsageSummary.value?.daily ?? []).map((day) => [day.date, day]));
  const days: TokenUsageDailyItem[] = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  cursor.setDate(cursor.getDate() - length + 1);
  for (let index = 0; index < length; index += 1) {
    const date = dateKey(cursor);
    days.push(source.get(date) ?? { date, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, turnCount: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
});

const tokenTrendMax = computed(() => Math.max(0, ...tokenTrendDays.value.map((day) => day.totalTokens)));

const tokenTrendLinePath = computed(() => {
  const days = tokenTrendDays.value;
  const max = tokenTrendMax.value || 1;
  return days.map((day, index) => {
    const x = days.length <= 1 ? 380 : (index / (days.length - 1)) * 760;
    const y = 158 - (day.totalTokens / max) * 126;
    return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
});

const tokenTrendAreaPath = computed(() => tokenTrendLinePath.value
  ? `${tokenTrendLinePath.value} L760 180 L0 180 Z`
  : "");

type ActivityCell = {
  date: string;
  count: number;
  level: number;
  future: boolean;
  providerId?: string;
};

type ActivityTooltip = {
  cell: ActivityCell;
  left: number;
  top: number;
};

const activityTooltip = ref<ActivityTooltip | null>(null);

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function activityLevel(count: number): number {
  if (count <= 0) return 0;
  if (count < 5) return 1;
  if (count < 15) return 2;
  if (count < 40) return 3;
  return 4;
}

const activityCells = computed<ActivityCell[]>(() => {
  const summary = aiActivitySummary.value;
  if (!summary) return [];
  const days = new Map(summary.days.map((day) => [day.date, day]));
  const today = dateKey(new Date());
  const cursor = parseLocalDate(summary.rangeStart);
  const end = parseLocalDate(summary.rangeEnd);
  const cells: ActivityCell[] = [];
  while (cursor <= end) {
    const date = dateKey(cursor);
    const day = days.get(date);
    const count = day?.count ?? 0;
    cells.push({ date, count, level: activityLevel(count), future: date > today, providerId: day?.providerId });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
});

const activityMonths = computed(() => {
  const startValue = aiActivitySummary.value?.rangeStart;
  if (!startValue) return [];
  const start = parseLocalDate(startValue);
  const months: Array<{ label: string; column: number }> = [];
  let previousMonth = -1;
  for (let column = 1; column <= 53; column += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + (column - 1) * 7);
    if (date.getMonth() !== previousMonth) {
      months.push({ label: `${date.getMonth() + 1}月`, column });
      previousMonth = date.getMonth();
    }
  }
  return months;
});

const activityProjects = computed<AiActivityProject[]>(() => aiActivitySummary.value?.projects ?? []);

const activityDailyAverage = computed(() => {
  const total = aiActivitySummary.value?.totalInteractions ?? 0;
  const activeDays = aiActivitySummary.value?.activeDays ?? 0;
  return activeDays > 0 ? (total / activeDays).toFixed(1) : "0.0";
});

function activityTitle(cell: ActivityCell): string {
  if (cell.future) return `${activityDateLabel(cell.date)} · 未来日期`;
  const provider = cell.providerId ? ` · ${providerNameForId(cell.providerId)}` : "";
  return `${activityDateLabel(cell.date)} · ${cell.count} 次交互${provider}`;
}

function activityDateLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(parseLocalDate(value));
}

function showActivityTooltip(cell: ActivityCell, event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const tooltipWidth = 176;
  const tooltipHeight = 58;
  const viewportPadding = 8;
  const gap = 8;
  const centeredLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
  const left = Math.min(
    window.innerWidth - tooltipWidth - viewportPadding,
    Math.max(viewportPadding, centeredLeft),
  );
  const above = rect.top - tooltipHeight - gap;
  const top = above >= viewportPadding ? above : rect.bottom + gap;
  activityTooltip.value = { cell, left, top };
}

function hideActivityTooltip(): void {
  activityTooltip.value = null;
}

function activityLastActiveLabel(value?: string): string {
  if (!value) return "暂无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function providerNameForId(id: string) {
  const map: Record<string, string> = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode", mimo: "MiMo Code" };
  return map[id] ?? id;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportTokenUsage() {
  const rows = [
    ["工具", "输入命中", "输入未命中", "输出", "合计", "轮次", "平均每轮", "占比"],
    ...tokenUsageRows.value.map((row) => [row.name, row.inputHitTokens, row.inputMissTokens, row.displayOutputTokens, row.totalTokens, row.turnCount, row.averageTokens, formatPercent(row.sharePercent)]),
  ];
  await desktopApi.exportTextFile(`token-usage-${tokenUsagePeriod.value}d-${dateKey(new Date())}.csv`, rows.map((row) => row.map(csvCell).join(",")).join("\n"));
}

async function exportActivity() {
  const rows = [
    ["排名", "项目", "路径", "交互次数", "最后活跃"],
    ...activityProjects.value.map((project, index) => [
      index + 1,
      project.name,
      project.path,
      project.count,
      project.lastActiveAt ?? "",
    ]),
  ];
  await desktopApi.exportTextFile(`ai-activity-${dateKey(new Date())}.csv`, rows.map((row) => row.map(csvCell).join(",")).join("\n"));
}

async function selectTokenUsagePeriod(days: 7 | 30 | 90) {
  if (tokenUsagePeriod.value === days && tokenUsageLoaded.value && tokenUsageSummary.value) return;
  tokenUsagePeriod.value = days;
  await refreshTokenUsage();
}

async function refreshTokenUsage() {
  if (tokenUsageLoading.value) return;
  tokenUsageLoading.value = true;
  tokenUsageError.value = "";
  try {
    tokenUsageSummary.value = await desktopApi.getTokenUsageSummary(tokenUsagePeriod.value);
    tokenUsageLoaded.value = true;
  } catch (error) {
    tokenUsageSummary.value = null;
    tokenUsageError.value = error instanceof Error ? error.message : "Token 用量加载失败";
  } finally {
    tokenUsageLoading.value = false;
  }
}

async function refreshAiActivity() {
  if (activityLoading.value) return;
  activityLoading.value = true;
  activityError.value = "";
  try {
    aiActivitySummary.value = await desktopApi.getAiActivitySummary();
    activityLoaded.value = true;
  } catch (error) {
    aiActivitySummary.value = null;
    activityError.value = error instanceof Error ? error.message : "活跃记录加载失败";
  } finally {
    activityLoading.value = false;
  }
}

watch(settingsPanel, (panel) => {
  if (panel === "tokenUsage" && !tokenUsageLoaded.value) {
    void refreshTokenUsage();
  }
  if (panel === "activity" && !activityLoaded.value) void refreshAiActivity();
});

onMounted(() => {
  const requestedPanel = window.localStorage.getItem("ai-workbench.settingsPanel");
  if (requestedPanel === "mcp" || requestedPanel === "skills") {
    window.localStorage.removeItem("ai-workbench.settingsPanel");
    settingsPanel.value = "resources";
    void router.replace({ name: "settings", query: { tab: requestedPanel } });
  } else if (route.query.panel === "resources") {
    settingsPanel.value = "resources";
  }
  if (requestedPanel && settingsPanels.some((panel) => panel.id === requestedPanel)) {
    settingsPanel.value = requestedPanel as SettingsPanel;
    window.localStorage.removeItem("ai-workbench.settingsPanel");
  }
  void refreshCloudConfig();
  void refreshDesktopRuntimeInfo();
  void loadNpmRegistry();
});
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
        <div class="settings-scroll" :class="{ 'settings-scroll-analytics': settingsPanel === 'tokenUsage' || settingsPanel === 'activity', 'settings-scroll-resources': settingsPanel === 'resources' }">
          <header class="settings-header">
            <div>
              <span class="settings-kicker">Desktop Settings</span>
              <h1>{{ activePanelMeta.label }}</h1>
              <p>{{ activePanelMeta.description }}。</p>
            </div>
            <div v-if="settingsPanel === 'tokenUsage'" class="settings-analytics-toolbar">
              <div class="settings-period-control" aria-label="统计周期">
                <button v-for="days in tokenUsagePeriods" :key="days" type="button" :disabled="tokenUsageLoading" :class="{ active: tokenUsagePeriod === days }" @click="selectTokenUsagePeriod(days)">
                  {{ days === 30 ? "近 30 天" : `${days} 天` }}
                </button>
              </div>
              <button class="settings-analytics-action" type="button" :disabled="tokenUsageLoading" @click="refreshTokenUsage">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 5.5A5.5 5.5 0 1 0 13.2 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10.5 3.5H13v2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                {{ tokenUsageLoading ? "刷新中" : "刷新" }}
              </button>
              <button class="settings-analytics-action solid" type="button" :disabled="!tokenUsageSummary" @click="exportTokenUsage">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                导出
              </button>
            </div>
            <div v-else-if="settingsPanel === 'activity'" class="settings-analytics-toolbar">
              <div class="settings-range-label"><span>时间范围</span><strong>近 12 个月</strong></div>
              <button class="settings-analytics-action" type="button" :disabled="activityLoading" @click="refreshAiActivity">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 5.5A5.5 5.5 0 1 0 13.2 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10.5 3.5H13v2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                {{ activityLoading ? "刷新中" : "刷新" }}
              </button>
              <button class="settings-analytics-action solid" type="button" :disabled="!aiActivitySummary" @click="exportActivity">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                导出
              </button>
            </div>
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
                  <img :src="copyIcon" alt="" />
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

          <section v-else-if="settingsPanel === 'activity'" class="settings-section settings-activity-page">
            <p v-if="activityError" class="settings-token-usage-error">{{ activityError }}</p>

            <div v-if="aiActivitySummary" class="settings-activity-metrics" aria-label="活跃概览">
              <article><span>活跃天数</span><strong>{{ aiActivitySummary.activeDays }}</strong><em>最近 365 天</em></article>
              <article><span>当前连续</span><strong>{{ aiActivitySummary.currentStreak }}</strong><em>连续交互日</em></article>
              <article><span>最长连续</span><strong>{{ aiActivitySummary.longestStreak }}</strong><em>历史最佳</em></article>
              <article><span>总交互</span><strong>{{ aiActivitySummary.totalInteractions.toLocaleString() }}</strong><em>你发送的消息</em></article>
              <article><span>活跃日均</span><strong>{{ activityDailyAverage }}</strong><em>按活跃天数计算</em></article>
            </div>

            <article v-if="aiActivitySummary" class="settings-activity settings-activity-heatmap">
              <div class="settings-activity-head">
                <div><h3>年度热力</h3><p>最近 12 个月的每日本地对话交互强度。</p></div>
                <span class="settings-activity-legend">
                  少 <i v-for="level in [0, 1, 2, 3, 4]" :key="level" :class="`level-${level}`"></i> 多
                </span>
              </div>
              <div class="settings-activity-scroll" @scroll="hideActivityTooltip">
                <div class="settings-activity-chart">
                  <div class="settings-activity-months" aria-hidden="true">
                    <span v-for="month in activityMonths" :key="`${month.label}-${month.column}`" :style="{ gridColumn: month.column }">{{ month.label }}</span>
                  </div>
                  <div class="settings-activity-body">
                    <div class="settings-activity-weekdays" aria-hidden="true"><span></span><span>周一</span><span></span><span>周三</span><span></span><span>周五</span><span></span></div>
                    <div class="settings-activity-grid" role="grid" aria-label="最近 12 个月 AI 活跃日历">
                      <span
                        v-for="cell in activityCells"
                        :key="cell.date"
                        class="settings-activity-cell"
                        :class="[`level-${cell.level}`, { future: cell.future }]"
                        role="gridcell"
                        :aria-label="activityTitle(cell)"
                        @pointerenter="showActivityTooltip(cell, $event)"
                        @pointerleave="hideActivityTooltip"
                      ></span>
                    </div>
                  </div>
                </div>
              </div>
              <p class="settings-activity-caption">每个方格代表一天，仅统计你发送的消息。</p>
            </article>

            <Teleport to="body">
              <div
                v-if="activityTooltip"
                class="settings-activity-tooltip"
                role="tooltip"
                :style="{ left: `${activityTooltip.left}px`, top: `${activityTooltip.top}px` }"
              >
                <strong>{{ activityDateLabel(activityTooltip.cell.date) }}</strong>
                <span v-if="activityTooltip.cell.future">未来日期</span>
                <span v-else>
                  <b>{{ activityTooltip.cell.count }}</b> 次交互
                  <template v-if="activityTooltip.cell.providerId"> · {{ providerNameForId(activityTooltip.cell.providerId) }}</template>
                </span>
              </div>
            </Teleport>

            <article v-if="aiActivitySummary" class="settings-activity-days">
              <div class="settings-analytics-panel-head"><div><h3>活跃项目</h3><p>按最近 365 天的本地对话交互次数排序。</p></div><span>{{ activityProjects.length }} 个项目</span></div>
              <div v-if="!activityProjects.length" class="settings-token-usage-empty compact"><strong>暂无本地项目</strong></div>
              <ArcoTable
                v-else
                class="settings-activity-table"
                row-key="id"
                :data="activityProjects"
                :pagination="false"
                :bordered="false"
                :scroll="{ x: 680 }"
                size="small"
                hoverable
              >
                <template #columns>
                  <ArcoTableColumn title="排名" :width="72">
                    <template #cell="{ record, rowIndex }">
                      <span class="activity-project-rank" :class="{ highlight: rowIndex === 0 && record.count > 0 }">{{ rowIndex + 1 }}</span>
                    </template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="项目" :width="328">
                    <template #cell="{ record }">
                      <span class="activity-project-name"><strong>{{ record.name }}</strong><small :title="record.path">{{ record.path }}</small></span>
                    </template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="交互" :width="120" align="right">
                    <template #cell="{ record, rowIndex }">
                      <span class="activity-project-count" :class="{ highlight: rowIndex === 0 && record.count > 0 }">{{ record.count }}</span>
                    </template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="最后活跃" :width="160">
                    <template #cell="{ record }">{{ activityLastActiveLabel(record.lastActiveAt) }}</template>
                  </ArcoTableColumn>
                </template>
              </ArcoTable>
            </article>
            <p class="settings-activity-note">AI 活跃记录为本地行为分析，不包含 Token 成本统计。</p>
          </section>

          <section v-else-if="settingsPanel === 'tokenUsage'" class="settings-section settings-token-usage">
            <p v-if="tokenUsageError" class="settings-token-usage-error">{{ tokenUsageError }}</p>

            <div class="settings-token-usage-overview">
              <article class="settings-token-usage-card total"><span class="settings-token-usage-card-label">Token 合计</span><strong>{{ formatTokens(tokenUsageTotals.totalTokens) }}</strong><small>近 {{ tokenUsagePeriod }} 天</small></article>
              <article class="settings-token-usage-card"><span class="settings-token-usage-card-label">活跃会话</span><strong>{{ tokenUsageTotals.turnCount }}</strong><small>跨工具轮次</small></article>
              <article class="settings-token-usage-card"><span class="settings-token-usage-card-label">平均每轮</span><strong>{{ formatTokens(tokenAveragePerTurn) }}</strong><small>Token / turn</small></article>
              <article class="settings-token-usage-card"><span class="settings-token-usage-card-label">同步状态</span><strong class="status" :class="{ online: cloudPaired }">{{ cloudPaired ? '已同步' : '未连接' }}</strong><small>云端用量数据</small></article>
              <article class="settings-token-usage-card"><span class="settings-token-usage-card-label">数据来源</span><strong class="source">云端</strong><small>按 AI 工具聚合</small></article>
            </div>

            <article class="settings-analytics-panel settings-token-mix">
              <div class="settings-analytics-panel-head"><div><h3>Token Mix Lens</h3><p>把总量拆解为输入命中、输入未命中和输出，快速定位缓存利用率。</p></div><span>{{ formatTokens(tokenUsageTotals.totalTokens) }}</span></div>
              <div class="settings-token-mix-track" aria-label="Token 构成">
                <i v-for="item in tokenMix" :key="item.id" :class="item.id" :style="{ width: `${item.percent}%` }"></i>
              </div>
              <div class="settings-token-mix-grid">
                <div v-for="item in tokenMix" :key="item.id"><i :class="item.id"></i><span><strong>{{ item.label }} {{ formatPercent(item.percent) }}</strong><small>{{ item.note }} · {{ formatTokens(item.value) }}</small></span></div>
              </div>
            </article>

            <article class="settings-analytics-panel settings-token-trend">
              <div class="settings-analytics-panel-head"><div><h3>{{ tokenTrendDays.length }} 日趋势</h3><p>按日统计当前周期的真实 Token 用量。</p></div><span>峰值 {{ formatTokens(tokenTrendMax) }}</span></div>
              <div class="settings-token-trend-chart">
                <svg viewBox="0 0 760 180" preserveAspectRatio="none" role="img" aria-label="每日 Token 趋势">
                  <path v-if="tokenTrendAreaPath" :d="tokenTrendAreaPath" class="area"></path>
                  <path v-if="tokenTrendLinePath" :d="tokenTrendLinePath" class="line"></path>
                  <line x1="0" y1="60" x2="760" y2="60"></line><line x1="0" y1="110" x2="760" y2="110"></line><line x1="0" y1="158" x2="760" y2="158"></line>
                </svg>
                <div class="settings-token-trend-axis"><span>{{ tokenTrendDays[0]?.date.slice(5) }}</span><span>{{ tokenTrendDays[Math.floor(tokenTrendDays.length / 2)]?.date.slice(5) }}</span><span>今天</span></div>
              </div>
            </article>

            <div class="settings-token-usage-detail">
              <div class="settings-analytics-panel-head"><h3>工具排行</h3><span>{{ tokenUsageRows.length }} 项</span></div>
              <div v-if="!tokenUsageLoading && tokenUsageRows.length === 0" class="settings-token-usage-empty">
                <span class="settings-token-usage-empty-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 16l3-4 3 2 4-6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </span>
                <strong>暂无 Token 用量数据</strong>
                <span>发起一次 AI 会话后会自动统计。</span>
              </div>
              <ArcoTable
                v-else
                class="settings-token-table"
                row-key="providerId"
                :data="tokenUsageRows"
                :pagination="false"
                :bordered="false"
                :scroll="{ x: 1040 }"
                size="small"
                hoverable
              >
                <template #columns>
                  <ArcoTableColumn title="工具" :width="200">
                    <template #cell="{ record }">
                      <span class="settings-token-usage-tool">
                        <span class="settings-token-usage-tool-icon" aria-hidden="true"><img :src="record.icon" alt="" /></span>
                        <span>{{ record.name }}</span>
                      </span>
                    </template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="合计" :width="110" align="right">
                    <template #cell="{ record }"><span class="settings-token-number total">{{ formatTokens(record.totalTokens) }}</span></template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="输入命中" :width="120" align="right">
                    <template #cell="{ record }"><span class="settings-token-number hit">{{ formatTokens(record.inputHitTokens) }}</span></template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="输入未命中" :width="120" align="right">
                    <template #cell="{ record }"><span class="settings-token-number">{{ formatTokens(record.inputMissTokens) }}</span></template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="输出" :width="120" align="right">
                    <template #cell="{ record }"><span class="settings-token-number output">{{ formatTokens(record.displayOutputTokens) }}</span></template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="轮次" :width="80" align="right">
                    <template #cell="{ record }"><span class="settings-token-number">{{ record.turnCount }}</span></template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="均值" :width="100" align="right">
                    <template #cell="{ record }"><span class="settings-token-number">{{ formatTokens(record.averageTokens) }}</span></template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="占比" :width="100">
                    <template #cell="{ record }"><span class="settings-token-share"><i :style="{ width: `${record.sharePercent}%` }"></i></span></template>
                  </ArcoTableColumn>
                  <ArcoTableColumn title="状态" :width="90" align="center">
                    <template #cell="{ record }"><span class="settings-token-status" :class="record.statusTone">{{ record.statusLabel }}</span></template>
                  </ArcoTableColumn>
                </template>
              </ArcoTable>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'codex'" class="settings-section">
            <CodexManagementPanel :cwd="ws.selectedProjectPath.value" />
          </section>

          <section v-else-if="settingsPanel === 'resources'" class="settings-section settings-resources-section">
            <ResourceCenterView embedded />
          </section>

        </div>
      </div>
    </section>
  </main>
</template>
