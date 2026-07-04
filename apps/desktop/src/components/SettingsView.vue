<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi, type AiProvider, type DesktopRuntimeInfo, type ProviderStatus } from "../services/desktop";

const settingsIcon = new URL("../assets/icons/settings.svg", import.meta.url).href;
const riskGuardIcon = new URL("../assets/icons/risk-guard.svg", import.meta.url).href;
const aiProvidersIcon = new URL("../assets/icons/ai-providers.svg", import.meta.url).href;
const archiveBoxIcon = new URL("../assets/icons/archive-box.svg", import.meta.url).href;
const fingerprintIcon = new URL("../assets/icons/fingerprint.svg", import.meta.url).href;
const clipboardIcon = new URL("../assets/icons/clipboard.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerOpencodeIcon = new URL("../assets/icons/provider-opencode.svg", import.meta.url).href;
const providerMimoIcon = new URL("../assets/icons/provider-mimo.svg", import.meta.url).href;

type SettingsPanel = "connection" | "security" | "about" | "archive";
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

const localServer = ref(ws.settingsServer.value);
const settingsPanel = ref<SettingsPanel>("connection");
const riskGuard = ref(true);
const commandLog = ref(true);
const localHistory = ref(true);
const autoReconnect = ref(true);
const cloudDeviceId = ref<string>("");
const cloudPaired = ref<boolean>(false);
const desktopRuntimeInfo = ref<DesktopRuntimeInfo | null>(null);

const settingsPanels: SettingsPanelItem[] = [
  {
    id: "connection",
    label: "连接",
    eyebrow: "基础",
    description: "服务器、设备名称和本机历史位置",
    icon: settingsIcon,
  },
  {
    id: "security",
    label: "安全与历史",
    eyebrow: "保护",
    description: "高危确认、命令摘要和重连策略",
    icon: riskGuardIcon,
  },
  {
    id: "about",
    label: "关于",
    eyebrow: "信息",
    description: "版本更新、Provider 诊断和桌面端信息",
    icon: aiProvidersIcon,
  },
  {
    id: "archive",
    label: "已归档对话",
    eyebrow: "历史",
    description: "查看和恢复已归档的 AI 会话",
    icon: archiveBoxIcon,
  },
];

watch(() => ws.settingsServer.value, (next) => {
  localServer.value = next;
});

watch(localServer, (next) => {
  ws.settingsServer.value = next;
});

const builtInProviders: AiProvider[] = [
  { id: "codex", name: "Codex", command: "codex", builtIn: true, enabled: true },
  { id: "claude", name: "Claude Code", command: "claude", builtIn: true, enabled: true },
  { id: "opencode", name: "OpenCode", command: "opencode", builtIn: true, enabled: true },
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

const installedProviderCount = computed(() => {
  return providerRows.value.filter((row) => row.status?.installed).length;
});

const missingProviderCount = computed(() => {
  return providerRows.value.filter((row) => !row.status?.installed).length;
});

const signedInProviderCount = computed(() => {
  return providerRows.value.filter((row) => row.status?.authStatus === "signedIn").length;
});

const enabledGuardCount = computed(() => {
  return [riskGuard.value, commandLog.value, localHistory.value].filter(Boolean).length;
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

onMounted(() => {
  void refreshCloudConfig();
  void refreshDesktopRuntimeInfo();
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
          <span>当前服务器</span>
          <strong>{{ localServer || "未设置" }}</strong>
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
            <button v-if="settingsPanel === 'connection'" class="button primary narrow" type="button" @click="ws.saveSettings">保存设置</button>
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
            <article class="settings-overview-card">
              <div class="settings-overview-card-head">
                <span>服务器</span>
              </div>
              <strong class="stat-primary">{{ localServer || "未设置" }}</strong>
            </article>
          </div>

          <section v-if="settingsPanel === 'connection'" class="settings-section">
            <div class="settings-section-heading">
              <div>
                <h2 class="settings-section-title">连接设置</h2>
                <p class="settings-section-description">配置桌面工作台的服务器连接，保存后用于移动端转发。</p>
              </div>
              <span class="settings-section-chip">本机优先</span>
            </div>
            <div class="settings-card settings-connection-card">
              <label class="settings-field">
                <span>服务器地址</span>
                <input v-model="localServer" class="settings-field-input" placeholder="http://8.162.12.148:3000" />
                <small>桌面端和移动端转发使用的云端地址。</small>
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
            <div class="settings-section-heading">
              <div>
                <h2 class="settings-section-title">安全与历史</h2>
                <p class="settings-section-description">高危命令会先经过确认，命令日志只记录摘要和风险结果，完整内容仍默认留在本机。</p>
              </div>
              <span class="settings-section-chip">{{ enabledGuardCount }} 项开启</span>
            </div>
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
            <div class="settings-about-summary">
              <article class="settings-about-stat-card">
                <span>可用</span>
                <strong class="stat-success">{{ installedProviderCount }}</strong>
              </article>
              <article class="settings-about-stat-card">
                <span>缺失</span>
                <strong class="stat-warning">{{ missingProviderCount }}</strong>
              </article>
              <article class="settings-about-stat-card">
                <span>总计</span>
                <strong class="stat-primary">{{ providerRows.length || 0 }}</strong>
              </article>
            </div>

            <div class="settings-provider-grid-block">
              <div class="settings-provider-grid-head">
                <div>
                  <h2 class="settings-pairing-block-title">本地环境检查</h2>
                  <p class="settings-provider-grid-sub">管理和监控已安装的 AI 编程工具</p>
                </div>
                <div class="settings-provider-grid-actions">
                  <button class="button secondary mini" type="button" :disabled="ws.updateChecking.value" @click="ws.checkAppUpdate">
                    {{ ws.updateChecking.value ? "检查中" : "诊断更新" }}
                  </button>
                  <button class="button secondary mini" type="button" @click="ws.detectProviders">刷新</button>
                </div>
              </div>
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
                      <span>登录状态</span>
                      <span :class="['muted', authTone(row.status)]">{{ authLabel(row.status) }}</span>
                    </div>
                  </div>
                  <div class="settings-provider-card-foot">
                    <span class="badge" :class="installedTone(row.status)">{{ installedLabel(row.status) }}</span>
                    <code class="settings-provider-card-command">{{ row.provider.command }}</code>
                  </div>
                </article>
              </div>
            </div>

            <div class="settings-about-update">
              <h2 class="settings-pairing-block-title">应用更新</h2>
              <div class="settings-about-update-card">
                <div class="settings-about-update-row">
                  <div class="settings-about-update-copy">
                    <strong>当前版本</strong>
                    <small>{{ ws.updateAvailableVersion.value ? `发现可更新版本 ${ws.updateAvailableVersion.value}` : "已是最新或尚未检查" }}</small>
                  </div>
                  <code class="settings-about-update-tag">{{ ws.updateCurrentVersion.value }}</code>
                </div>
                <div class="settings-about-update-divider" aria-hidden="true"></div>
                <div class="settings-about-update-actions">
                  <button class="button secondary" type="button" :disabled="ws.updateChecking.value || ws.updateInstalling.value" @click="ws.checkAppUpdate">
                    {{ ws.updateChecking.value ? "检查中" : "检查更新" }}
                  </button>
                  <button class="button primary" type="button" :disabled="!ws.updateAvailableVersion.value || !ws.updateInstallable.value || ws.updateInstalling.value" @click="ws.installAppUpdate">
                    {{ ws.updateInstalling.value ? "安装中" : "下载并安装" }}
                  </button>
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
                <p v-if="ws.updateResult.value" class="settings-about-update-result" :class="{ error: ws.updateResultError.value }">{{ ws.updateResult.value }}</p>
              </div>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'archive'" class="settings-section">
            <div class="settings-section-heading">
              <div>
                <h2 class="settings-section-title">已归档对话</h2>
                <p class="settings-section-description">查看已归档的 AI 会话,选择恢复后会回到侧边栏最近会话列表。</p>
              </div>
              <span class="settings-section-chip">{{ ws.archivedSessions.value.length }} 条</span>
            </div>
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
        </div>
      </div>
    </section>
  </main>
</template>
