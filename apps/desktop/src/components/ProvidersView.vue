<script setup lang="ts">
import { computed } from "vue";
import { useWorkspace } from "../composables/useWorkspace";
import type { AiProvider, ProviderStatus } from "../services/tauri";

const ws = useWorkspace();

type ProviderRow = {
  provider: AiProvider;
  status?: ProviderStatus;
};

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
  return [...map.values()].sort((left, right) => {
    const leftInstalled = left.status?.installed ? 0 : 1;
    const rightInstalled = right.status?.installed ? 0 : 1;
    if (leftInstalled !== rightInstalled) return leftInstalled - rightInstalled;
    return left.provider.name.localeCompare(right.provider.name);
  });
});

const installedCount = computed(() => providerRows.value.filter((row) => row.status?.installed).length);
const missingCount = computed(() => providerRows.value.filter((row) => row.status && !row.status.installed).length);
const uncheckedCount = computed(() => providerRows.value.filter((row) => !row.status).length);

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

function installedLabel(status?: ProviderStatus) {
  if (!status) return "待检测";
  return status.installed ? "已安装" : "未安装";
}

function installedTone(status?: ProviderStatus) {
  if (!status) return "neutral";
  return status.installed ? "success" : "warning";
}

function checkedAt(status?: ProviderStatus) {
  if (!status?.lastCheckedAt) return "尚未检测";
  const date = new Date(status.lastCheckedAt);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString();
}

function detailText(row: ProviderRow) {
  if (!row.status) return `等待检测 ${row.provider.command}`;
  if (!row.status.installed) return `未找到命令：${row.provider.command}`;
  return row.status.version ?? `${row.provider.command} 可执行`;
}

function nextStep(row: ProviderRow) {
  if (!row.status) return "点击重新检测获取状态";
  if (!row.status.installed) return `安装或加入 PATH：${row.provider.command}`;
  if (row.status.authStatus === "signedOut") return `运行 ${row.provider.command} 登录`;
  if (row.status.authStatus === "unknown") return "可用，认证状态暂无法自动判断";
  return "可直接创建会话";
}
</script>

<template>
  <section class="view active" data-view-panel="providers">
    <header class="topbar">
      <div>
        <h1>AI 工具</h1>
        <p>检测本机 AI CLI/TUI，配置内置和自定义 Provider。</p>
      </div>
      <button class="button secondary" type="button" @click="ws.detectProviders">重新检测</button>
    </header>
    <section class="provider-summary-strip" aria-label="Provider 检测摘要">
      <article>
        <span>可用</span>
        <strong>{{ installedCount }}</strong>
      </article>
      <article>
        <span>缺失</span>
        <strong>{{ missingCount }}</strong>
      </article>
      <article>
        <span>待检测</span>
        <strong>{{ uncheckedCount }}</strong>
      </article>
    </section>
    <article class="panel provider-status-panel">
      <div class="provider-status-heading">
        <div>
          <h2>本机 Provider 状态</h2>
          <p>检测命令是否存在、版本输出、认证状态和下一步处理。</p>
        </div>
        <span>{{ providerRows.length }} 个 Provider</span>
      </div>
      <div class="provider-status-list">
        <div v-if="!providerRows.length" class="empty-state">暂无 Provider。</div>
        <article v-for="row in providerRows" :key="row.provider.id" class="provider-status-row">
          <div class="provider-status-main">
            <div class="provider-status-name">
              <span class="provider-dot" :class="installedTone(row.status)" aria-hidden="true"></span>
              <div>
                <strong>{{ row.provider.name }}</strong>
                <p>{{ detailText(row) }}</p>
              </div>
            </div>
            <code>{{ row.provider.command }}</code>
          </div>
          <div class="provider-status-meta">
            <span class="badge" :class="installedTone(row.status)">{{ installedLabel(row.status) }}</span>
            <span class="badge" :class="authTone(row.status)">{{ authLabel(row.status) }}</span>
            <span class="provider-check-time">{{ checkedAt(row.status) }}</span>
          </div>
          <div class="provider-next-step">
            <span>下一步</span>
            <p>{{ nextStep(row) }}</p>
          </div>
        </article>
      </div>
    </article>
  </section>
</template>
