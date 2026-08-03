<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { desktopApi, type CodexHook } from "../services/desktop";

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const hooks = ref<CodexHook[]>([]);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const search = ref("");
const eventFilter = ref("all");
const selectedKey = ref("");

const eventNames = computed(() => {
  const names = new Set<string>();
  for (const hook of hooks.value) names.add(hook.eventName);
  return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
});

const filteredHooks = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return hooks.value.filter((hook) => {
    if (eventFilter.value !== "all" && hook.eventName !== eventFilter.value) return false;
    return !query || `${hook.key} ${hook.eventName} ${hook.command ?? ""} ${hook.sourcePath ?? ""}`.toLocaleLowerCase().includes(query);
  }).sort((left, right) => left.eventName.localeCompare(right.eventName, "zh-CN") || left.displayOrder - right.displayOrder);
});

const selectedHook = computed(() => hooks.value.find((hook) => hook.key === selectedKey.value) ?? null);
const totalErrors = computed(() => hooks.value.reduce((count, hook) => count + hook.errors.length, 0));

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function eventLabel(eventName: string): string {
  return ({
    preToolUse: "工具调用前",
    permissionRequest: "权限申请",
    postToolUse: "工具调用后",
    preCompact: "压缩前",
    postCompact: "压缩后",
    sessionStart: "会话开始",
    userPromptSubmit: "用户提交",
    subagentStart: "子代理开始",
    subagentStop: "子代理结束",
    stop: "停止",
  } as Record<string, string>)[eventName] ?? eventName;
}

function handlerLabel(handlerType: string): string {
  return ({ command: "命令", prompt: "提示词", agent: "代理" } as Record<string, string>)[handlerType] ?? handlerType;
}

function trustLabel(status: string): string {
  return ({
    trusted: "已信任",
    untrusted: "未信任",
    unknown: "未知",
  } as Record<string, string>)[status] ?? status;
}

function trustTone(status: string): string {
  if (status === "trusted") return "ok";
  if (status === "untrusted") return "warn";
  return "muted";
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    hooks.value = await desktopApi.codexListHooks();
  } catch (err) {
    error.value = `加载 Hooks 失败：${errorText(err)}`;
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  void load();
}

defineExpose({ refresh, load });

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="hooks-panel">
    <div class="hooks-toolbar">
      <div class="hooks-toolbar-title">
        <strong>Hooks</strong>
        <span v-if="hooks.length">共 {{ hooks.length }} 个</span>
        <span v-if="totalErrors > 0" class="hooks-error-badge">{{ totalErrors }} 个错误</span>
      </div>
      <div class="hooks-toolbar-controls">
        <input v-model="search" class="hooks-search" type="search" placeholder="搜索 Hook（名称 / 命令 / 路径）" />
        <select v-model="eventFilter" class="hooks-event-filter" aria-label="按事件筛选">
          <option value="all">全部事件</option>
          <option v-for="name in eventNames" :key="name" :value="name">{{ eventLabel(name) }}</option>
        </select>
        <button class="codex-action-button" type="button" :disabled="loading" @click="refresh">
          {{ loading ? "加载中" : "刷新" }}
        </button>
      </div>
    </div>

    <p v-if="notice" class="hooks-notice">{{ notice }}</p>
    <p v-if="error" class="hooks-error">{{ error }}</p>

    <div v-if="loading && !hooks.length" class="hooks-empty">正在读取 Hooks...</div>
    <div v-else-if="!filteredHooks.length" class="hooks-empty">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 12h6M9 16h6M5 4h14a1 1 0 0 1 1 1v13l-4 3H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <strong>{{ hooks.length ? "没有匹配的 Hook" : "未检测到 Hooks" }}</strong>
      <span>{{ hooks.length ? "调整搜索或事件筛选。" : "Hooks 通过 codex config.toml 的 hooks 段配置。" }}</span>
    </div>

    <div v-else class="hooks-list">
      <article
        v-for="hook in filteredHooks"
        :key="hook.key"
        class="hooks-row"
        :class="{ active: selectedKey === hook.key }"
        @click="selectedKey = selectedKey === hook.key ? '' : hook.key"
      >
        <div class="hooks-row-main">
          <span class="hooks-event-chip" :title="hook.eventName">{{ eventLabel(hook.eventName) }}</span>
          <div class="hooks-row-copy">
            <div class="hooks-row-title">
              <strong>{{ hook.command || hook.key }}</strong>
              <span class="hooks-badge" :class="{ disabled: !hook.enabled }">{{ hook.enabled ? "启用" : "停用" }}</span>
              <span class="hooks-badge hooks-badge-type">{{ handlerLabel(hook.handlerType) }}</span>
            </div>
            <div class="hooks-row-meta">
              <span>{{ hook.source }}<template v-if="hook.sourcePath"> · {{ hook.sourcePath }}</template></span>
              <template v-if="hook.timeoutSec > 0"><span>超时 {{ hook.timeoutSec }}s</span></template>
              <span v-if="hook.matcher">匹配 {{ hook.matcher }}</span>
            </div>
          </div>
          <span class="hooks-trust" :class="trustTone(hook.trustStatus)">{{ trustLabel(hook.trustStatus) }}</span>
          <span v-if="hook.errors.length" class="hooks-row-error">有 {{ hook.errors.length }} 个错误</span>
        </div>
        <div v-if="selectedKey === hook.key" class="hooks-detail">
          <dl class="hooks-detail-grid">
            <div><dt>Key</dt><dd><code>{{ hook.key }}</code></dd></div>
            <div><dt>事件</dt><dd>{{ eventLabel(hook.eventName) }}（{{ hook.eventName }}）</dd></div>
            <div><dt>类型</dt><dd>{{ handlerLabel(hook.handlerType) }}</dd></div>
            <div><dt>信任状态</dt><dd>{{ trustLabel(hook.trustStatus) }}</dd></div>
            <div><dt>来源</dt><dd>{{ hook.source }}</dd></div>
            <div><dt>路径</dt><dd><code>{{ hook.sourcePath || "—" }}</code></dd></div>
            <div><dt>命令</dt><dd><code>{{ hook.command || "—" }}</code></dd></div>
            <div><dt>超时</dt><dd>{{ hook.timeoutSec }} 秒</dd></div>
            <div v-if="hook.pluginId"><dt>插件</dt><dd>{{ hook.pluginId }}</dd></div>
            <div v-if="hook.statusMessage"><dt>状态</dt><dd>{{ hook.statusMessage }}</dd></div>
          </dl>
          <div v-if="hook.errors.length" class="hooks-detail-errors">
            <strong>加载错误</strong>
            <p v-for="(item, index) in hook.errors" :key="index">{{ item.path }}：{{ item.message }}</p>
          </div>
          <div v-if="hook.warnings.length" class="hooks-detail-warnings">
            <strong>警告</strong>
            <p v-for="(item, index) in hook.warnings" :key="index">{{ item }}</p>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>
