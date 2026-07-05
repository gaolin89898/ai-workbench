<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { desktopApi, type TokenUsageSummary, type TokenUsageSummaryItem } from "../services/desktop";
import { useWorkspace } from "../composables/useWorkspace";

const tokenUsageIcon = new URL("../assets/icons/ai-providers.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerOpencodeIcon = new URL("../assets/icons/provider-opencode.svg", import.meta.url).href;
const providerMimoIcon = new URL("../assets/icons/provider-mimo.svg", import.meta.url).href;

const ws = useWorkspace();
const router = useRouter();

const localServer = ref(ws.settingsServer.value);
const tokenUsageSummary = ref<TokenUsageSummary | null>(null);
const tokenUsageLoading = ref(false);
const tokenUsageError = ref<string>("");

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

function providerIcon(providerId: string) {
  if (providerId === "codex") return providerCodexIcon;
  if (providerId === "claude") return providerClaudeIcon;
  if (providerId === "opencode") return providerOpencodeIcon;
  if (providerId === "mimo") return providerMimoIcon;
  return tokenUsageIcon;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function refreshTokenUsage() {
  tokenUsageLoading.value = true;
  tokenUsageError.value = "";
  try {
    tokenUsageSummary.value = await desktopApi.getTokenUsageSummary();
  } catch (e) {
    tokenUsageError.value = e instanceof Error ? e.message : "加载失败";
    tokenUsageSummary.value = null;
  } finally {
    tokenUsageLoading.value = false;
  }
}

function goBack() {
  if (router.currentRoute.value.path !== "/chat") {
    void router.push("/chat");
  }
}

onMounted(() => {
  void refreshTokenUsage();
});
</script>

<template>
  <main class="app-fullscreen">
    <section class="view active settings-page token-usage-page" data-view-panel="tokenUsage">
      <aside class="settings-nav">
        <div class="settings-nav-top">
          <button class="settings-back-button" type="button" aria-label="返回首页" @click="goBack">
            <span aria-hidden="true"></span>
            返回首页
          </button>
          <div class="settings-nav-title">
            <strong>用量统计</strong>
            <small>用量统计</small>
          </div>
        </div>

        <nav class="settings-nav-list" aria-label="用量统计分组">
          <button class="active" type="button">
            <span class="settings-nav-marker" aria-hidden="true"></span>
            <span class="settings-nav-copy">
              <span class="settings-nav-title-row">
                <img :src="tokenUsageIcon" alt="" class="settings-nav-icon" />
                <strong>用量统计</strong>
              </span>
            </span>
            <span class="settings-nav-eyebrow">用量</span>
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
              <span class="settings-kicker">Token Usage</span>
              <h1>用量统计</h1>
              <p>按 AI 工具聚合的 Token 用量，数据来自云端，桌面端和移动端共用。</p>
            </div>
            <button class="button secondary narrow" type="button" :disabled="tokenUsageLoading" @click="refreshTokenUsage">
              {{ tokenUsageLoading ? "刷新中…" : "刷新" }}
            </button>
          </header>

          <section class="settings-section settings-token-usage">
            <p v-if="tokenUsageError" class="settings-token-usage-error">{{ tokenUsageError }}</p>

            <div class="settings-token-usage-overview">
              <article class="settings-token-usage-card">
                <span>总输入</span>
                <strong>{{ formatTokens(tokenUsageTotals.inputTokens) }}</strong>
              </article>
              <article class="settings-token-usage-card">
                <span>总输出</span>
                <strong>{{ formatTokens(tokenUsageTotals.outputTokens) }}</strong>
              </article>
              <article class="settings-token-usage-card">
                <span>推理 Token</span>
                <strong>{{ formatTokens(tokenUsageTotals.reasoningTokens) }}</strong>
              </article>
              <article class="settings-token-usage-card highlight">
                <span>合计</span>
                <strong>{{ formatTokens(tokenUsageTotals.totalTokens) }}</strong>
              </article>
            </div>

            <div v-if="!tokenUsageLoading && tokenUsageRows.length === 0" class="settings-token-usage-empty">
              暂无 Token 用量数据。发起一次 AI 会话后会自动统计。
            </div>

            <table v-else class="settings-token-usage-table">
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
                      <img :src="row.icon" alt="" />
                      <span>{{ row.name }}</span>
                    </span>
                  </td>
                  <td>{{ formatTokens(row.inputTokens) }}</td>
                  <td>{{ formatTokens(row.outputTokens) }}</td>
                  <td>{{ formatTokens(row.reasoningTokens) }}</td>
                  <td><strong>{{ formatTokens(row.totalTokens) }}</strong></td>
                  <td>{{ row.turnCount }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </section>
  </main>
</template>
