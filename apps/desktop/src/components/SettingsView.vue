<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import QRCode from "qrcode";
import { useWorkspace } from "../composables/useWorkspace";
import type { AiProvider, ProviderStatus } from "../services/tauri";

type SettingsPanel = "connection" | "security" | "pairing" | "updates" | "debug" | "archive";
type ProviderRow = {
  provider: AiProvider;
  status?: ProviderStatus;
};
type SettingsPanelItem = {
  id: SettingsPanel;
  label: string;
  eyebrow: string;
  description: string;
};

const ws = useWorkspace();
const router = useRouter();

const localServer = ref(ws.settingsServer.value);
const settingsPanel = ref<SettingsPanel>("connection");
const pairingCode = ref("");
const qrImageUrl = ref("");
const deviceName = ref("gl-H610M");
const historyDb = ref("~/.ai-workbench/history.db");
const riskGuard = ref(true);
const commandLog = ref(true);
const localHistory = ref(true);
const autoReconnect = ref(true);
const terminalDebug = ref(true);

const settingsPanels: SettingsPanelItem[] = [
  {
    id: "connection",
    label: "连接",
    eyebrow: "基础",
    description: "服务器、设备名称和本机历史位置",
  },
  {
    id: "security",
    label: "安全与历史",
    eyebrow: "保护",
    description: "高危确认、命令摘要和重连策略",
  },
  {
    id: "pairing",
    label: "设备配对",
    eyebrow: "移动端",
    description: "把这台桌面绑定到移动端账号",
  },
  {
    id: "updates",
    label: "应用更新",
    eyebrow: "Release",
    description: "从 GitHub Releases 检查和安装桌面端更新",
  },
  {
    id: "debug",
    label: "调试入口",
    eyebrow: "诊断",
    description: "Provider 检测和本地 PTY 状态",
  },
  {
    id: "archive",
    label: "已归档对话",
    eyebrow: "历史",
    description: "查看和恢复已归档的 AI 会话",
  },
];

watch(() => ws.settingsServer.value, (next) => {
  localServer.value = next;
});

watch(localServer, (next) => {
  ws.settingsServer.value = next;
});

watch(() => ws.qrPairingPayload.value, async (payload) => {
  qrImageUrl.value = payload
    ? await QRCode.toDataURL(payload, { margin: 1, width: 220, errorCorrectionLevel: "M" })
    : "";
});

const providerRows = computed<ProviderRow[]>(() => {
  const map = new Map<string, ProviderRow>();
  for (const provider of ws.providers.value) map.set(provider.id, { provider });
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
  return [...map.values()];
});

const activePanelMeta = computed(() => {
  return settingsPanels.find((panel) => panel.id === settingsPanel.value) ?? settingsPanels[0];
});

const installedProviderCount = computed(() => {
  return providerRows.value.filter((row) => row.status?.installed).length;
});

const signedInProviderCount = computed(() => {
  return providerRows.value.filter((row) => row.status?.authStatus === "signedIn").length;
});

const enabledGuardCount = computed(() => {
  return [riskGuard.value, commandLog.value, localHistory.value, autoReconnect.value].filter(Boolean).length;
});

const qrStatusLabel = computed(() => {
  if (ws.qrPairingStatus.value === "creating") return "生成中";
  if (ws.qrPairingStatus.value === "pending") return "等待扫码";
  if (ws.qrPairingStatus.value === "approved") return "已配对";
  if (ws.qrPairingStatus.value === "expired") return "已过期";
  if (ws.qrPairingStatus.value === "error") return "异常";
  return "未生成";
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
              <strong>{{ panel.label }}</strong>
              <small>{{ panel.description }}</small>
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
          <header v-if="settingsPanel === 'connection'" class="settings-header">
            <div>
              <span class="settings-kicker">Desktop Settings</span>
              <h1>{{ activePanelMeta.label }}</h1>
              <p>{{ activePanelMeta.description }}。配置会尽量保存在本机，移动端只拿到必要的连接信息。</p>
            </div>
            <button class="button primary narrow" type="button" @click="ws.saveSettings">保存设置</button>
          </header>

          <div v-if="settingsPanel === 'connection'" class="settings-overview" aria-label="设置概览">
            <article>
              <span>服务器</span>
              <strong>{{ localServer || "未设置" }}</strong>
              <small>移动端和桌面端转发地址</small>
            </article>
            <article>
              <span>Provider</span>
              <strong>{{ installedProviderCount }}/{{ providerRows.length || 0 }}</strong>
              <small>{{ signedInProviderCount }} 个已登录</small>
            </article>
            <article>
              <span>保护项</span>
              <strong>{{ enabledGuardCount }}/4</strong>
              <small>风险保护、日志、历史、重连</small>
            </article>
          </div>

          <section v-if="settingsPanel === 'connection'" class="settings-section">
            <div class="settings-section-heading">
              <div>
                <h2 class="settings-section-title">连接配置</h2>
                <p class="settings-section-description">桌面端启动后会用这里的信息完成配对、移动端转发和本机历史读取。</p>
              </div>
              <span class="settings-section-chip">本机优先</span>
            </div>
            <div class="settings-grid">
              <div class="settings-card settings-card-main">
                <label class="settings-field">
                  <span>服务器地址</span>
                  <input v-model="localServer" class="settings-field-input" placeholder="http://118.196.78.91" />
                  <small>桌面端配对和移动端转发使用的云端地址。</small>
                </label>
                <label class="settings-field">
                  <span>设备名称</span>
                  <input v-model="deviceName" class="settings-field-input" />
                  <small>移动端设备列表里显示的桌面名称。</small>
                </label>
                <label class="settings-field">
                  <span>本地历史</span>
                  <input v-model="historyDb" class="settings-field-input" />
                  <small>完整聊天记录默认只保存在这台电脑。</small>
                </label>
              </div>
              <aside class="settings-note-panel">
                <strong>连接策略</strong>
                <p>前端会把服务器地址写入本地配置；配对和移动端控制都从这个地址开始。保存失败时，下方反馈区会显示错误信息。</p>
                <dl>
                  <div>
                    <dt>历史</dt>
                    <dd>保留在本机 SQLite</dd>
                  </div>
                  <div>
                    <dt>移动端</dt>
                    <dd>通过服务器发现桌面</dd>
                  </div>
                </dl>
              </aside>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'security'" class="settings-section">
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
              <label class="settings-row settings-toggle-row">
                <span class="settings-row-copy">
                  <strong>自动重连</strong>
                  <small>断线后恢复移动端和桌面连接</small>
                </span>
                <input v-model="autoReconnect" class="settings-switch" type="checkbox" />
              </label>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'pairing'" class="settings-section">
            <div class="settings-section-heading">
              <div>
                <h2 class="settings-section-title">设备配对</h2>
                <p class="settings-section-description">把当前桌面绑定到移动端账号。成功后，移动端可以看到这台桌面并控制 AI 会话。</p>
              </div>
              <span class="settings-section-chip">{{ qrStatusLabel }}</span>
            </div>
            <div class="settings-grid">
              <div class="settings-card settings-form-card">
                <label class="settings-field">
                  <span>服务器地址</span>
                  <input v-model="localServer" class="settings-field-input" />
                  <small>请填写手机能访问到的地址。默认服务器为 118.196.78.91。</small>
                </label>
                <button
                  class="button primary"
                  type="button"
                  :disabled="ws.qrPairingStatus.value === 'creating' || ws.qrPairingStatus.value === 'pending'"
                  @click="ws.createQrPairingRequest(localServer)"
                >
                  {{ ws.qrPairingStatus.value === 'pending' ? '等待手机扫码' : '生成扫码配对二维码' }}
                </button>
                <div class="settings-manual-pair">
                  <span>备用短码配对</span>
                  <p>如果手机摄像头不可用，也可以在手机端生成短码后手动输入。</p>
                </div>
                <label class="settings-field">
                  <span>配对码</span>
                  <input v-model="pairingCode" class="settings-field-input pairing-code-input" placeholder="A7K9Q2LM" maxlength="16" />
                  <small>输入移动端生成的短码，最长 16 位。</small>
                </label>
                <button class="button primary" type="button" @click="ws.pairDesktop(localServer, pairingCode)">配对这台桌面</button>
              </div>
              <aside class="settings-pair-result" :class="{ error: ws.pairResultError.value }">
                <span>扫码配对</span>
                <div class="settings-qr-frame" :class="{ empty: !qrImageUrl }">
                  <img v-if="qrImageUrl" :src="qrImageUrl" alt="桌面配对二维码" />
                  <strong v-else>等待生成</strong>
                </div>
                <div v-if="ws.qrPairingCode.value" class="settings-qr-meta">
                  <code>{{ ws.qrPairingCode.value }}</code>
                  <small>过期时间：{{ ws.qrPairingExpiresAt.value }}</small>
                </div>
                <p>{{ ws.pairResult.value }}</p>
              </aside>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'updates'" class="settings-section">
            <div class="settings-section-heading">
              <div>
                <h2 class="settings-section-title">应用更新</h2>
                <p class="settings-section-description">桌面端会从 GitHub Releases 读取最新版本，下载签名更新包并重启安装。</p>
              </div>
              <span class="settings-section-chip">{{ ws.updateAvailableVersion.value ? `可更新 ${ws.updateAvailableVersion.value}` : "GitHub Releases" }}</span>
            </div>
            <div class="settings-grid">
              <div class="settings-card settings-form-card">
                <div class="settings-row">
                  <span class="settings-row-copy">
                    <strong>更新来源</strong>
                    <small>gaolin89898/ai-workbench 的 latest.json</small>
                  </span>
                  <code>GitHub</code>
                </div>
                <div class="settings-row">
                  <span class="settings-row-copy">
                    <strong>签名校验</strong>
                    <small>安装前会校验 Release 更新包签名</small>
                  </span>
                  <span class="badge success">已启用</span>
                </div>
                <div class="button-row">
                  <button class="button secondary" type="button" :disabled="ws.updateChecking.value || ws.updateInstalling.value" @click="ws.checkAppUpdate">
                    {{ ws.updateChecking.value ? "检查中" : "检查更新" }}
                  </button>
                  <button class="button primary" type="button" :disabled="!ws.updateAvailableVersion.value || ws.updateInstalling.value" @click="ws.installAppUpdate">
                    {{ ws.updateInstalling.value ? "安装中" : "下载并重启安装" }}
                  </button>
                </div>
              </div>
              <aside class="settings-note-panel" :class="{ error: ws.updateResultError.value }">
                <strong>更新状态</strong>
                <p>{{ ws.updateResult.value }}</p>
                <dl>
                  <div>
                    <dt>Release</dt>
                    <dd>latest.json</dd>
                  </div>
                  <div>
                    <dt>触发</dt>
                    <dd>推送 v* 标签</dd>
                  </div>
                </dl>
              </aside>
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

          <section v-else class="settings-section">
            <div class="settings-section-heading">
              <div>
                <h2 class="settings-section-title">调试入口</h2>
                <p class="settings-section-description">用于排查 Provider 检测、本地 PTY 承载状态和认证链路。</p>
              </div>
              <button class="button secondary mini" type="button" @click="ws.detectProviders">重新检测</button>
            </div>
            <div class="settings-card">
              <label class="settings-row settings-toggle-row">
                <span class="settings-row-copy">
                  <strong>底层终端</strong>
                  <small>保留本地 PTY 调试信息</small>
                </span>
                <input v-model="terminalDebug" class="settings-switch" type="checkbox" />
              </label>
              <div class="settings-provider-block">
                <div class="settings-provider-heading">
                  <span class="settings-row-copy">
                    <strong>Provider 检测</strong>
                    <small>检测 Codex、Claude、OpenCode、DeepSeek 的安装、认证和版本状态</small>
                  </span>
                  <span class="settings-provider-summary">{{ installedProviderCount }} 个可用</span>
                </div>
                <div class="settings-provider-list">
                  <div v-if="!providerRows.length" class="empty-state">暂无 Provider。</div>
                  <article v-for="row in providerRows" :key="row.provider.id" class="settings-provider-row">
                    <div class="settings-provider-main">
                      <span class="provider-dot" :class="installedTone(row.status)" aria-hidden="true"></span>
                      <div>
                        <strong>{{ row.provider.name }}</strong>
                        <p>{{ providerDetail(row) }}</p>
                      </div>
                    </div>
                    <code>{{ row.provider.command }}</code>
                    <div class="settings-provider-badges">
                      <span class="badge" :class="installedTone(row.status)">{{ installedLabel(row.status) }}</span>
                      <span class="badge" :class="authTone(row.status)">{{ authLabel(row.status) }}</span>
                    </div>
                    <span class="settings-provider-time">{{ checkedAt(row.status) }}</span>
                  </article>
                </div>
              </div>
            </div>
          </section>

          <div class="settings-result" role="status">
            <span>保存反馈</span>
            <p>{{ ws.settingsResult.value }}</p>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>
