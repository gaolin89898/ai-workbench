<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CodexManagementPanel from "./CodexManagementPanel.vue";
import SkillsManagementPanel from "./SkillsManagementPanel.vue";
import HooksManagementPanel from "./HooksManagementPanel.vue";

type ResourceTab = "mcp" | "skills" | "hooks";

const props = defineProps<{ embedded?: boolean }>();

const route = useRoute();
const router = useRouter();
const activeTab = ref<ResourceTab>("mcp");
const mcpPanel = ref<InstanceType<typeof CodexManagementPanel> | null>(null);
const skillsPanel = ref<InstanceType<typeof SkillsManagementPanel> | null>(null);
const hooksPanel = ref<InstanceType<typeof HooksManagementPanel> | null>(null);

const tabFromRoute = computed<ResourceTab>(() => {
  const tab = route.query.tab;
  return tab === "skills" ? "skills" : tab === "hooks" ? "hooks" : "mcp";
});
const refreshLabel = computed(() => activeTab.value === "mcp" ? "刷新 MCP 状态" : activeTab.value === "hooks" ? "刷新 Hooks" : "刷新 Skills");

watch(tabFromRoute, (tab) => {
  activeTab.value = tab;
}, { immediate: true });

function selectTab(tab: ResourceTab): void {
  if (tab === activeTab.value && route.query.tab === tab) return;
  activeTab.value = tab;
  void router.replace(props.embedded
    ? { name: "settings", query: { panel: "resources", tab } }
    : { name: "resources", query: { tab } });
}

function refreshActiveTab(): void {
  if (activeTab.value === "mcp") {
    void mcpPanel.value?.refresh();
    return;
  }
  if (activeTab.value === "hooks") {
    void hooksPanel.value?.refresh();
    return;
  }
  void skillsPanel.value?.refresh();
}
</script>

<template>
  <main class="resource-center" :class="{ embedded }" data-view-panel="resources">
    <header v-if="!embedded" class="resource-center-header">
      <div>
        <span class="resource-center-kicker">全局资源</span>
        <h1>资源中心</h1>
        <p>管理对所有后续 Codex 会话生效的 MCP 服务与 Skills。</p>
      </div>
      <div class="resource-center-actions">
        <span class="resource-scope"><i aria-hidden="true"></i>用户级配置</span>
        <button class="resource-refresh" type="button" @click="refreshActiveTab">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16 6.5A6.2 6.2 0 1 0 16.2 11M13.2 4.5H16v2.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
          {{ refreshLabel }}
        </button>
      </div>
    </header>

    <nav class="resource-tabs" role="tablist" aria-label="资源类型">
      <button :class="{ active: activeTab === 'mcp' }" type="button" role="tab" :aria-selected="activeTab === 'mcp'" @click="selectTab('mcp')">
        <span>MCP</span>
        <small>服务、工具与认证</small>
      </button>
      <button :class="{ active: activeTab === 'skills' }" type="button" role="tab" :aria-selected="activeTab === 'skills'" @click="selectTab('skills')">
        <span>Skills</span>
        <small>技能、依赖与目录</small>
      </button>
      <button :class="{ active: activeTab === 'hooks' }" type="button" role="tab" :aria-selected="activeTab === 'hooks'" @click="selectTab('hooks')">
        <span>Hooks</span>
        <small>事件钩子与信任状态</small>
      </button>
    </nav>

    <section class="resource-workbench" :class="`resource-workbench-${activeTab}`">
      <CodexManagementPanel v-if="activeTab === 'mcp'" ref="mcpPanel" mode="mcp" />
      <SkillsManagementPanel v-else-if="activeTab === 'skills'" ref="skillsPanel" />
      <HooksManagementPanel v-else ref="hooksPanel" />
    </section>
  </main>
</template>

<style scoped>
.resource-center { height: 100%; min-height: 0; overflow: auto; padding: 30px 34px 36px; color: var(--color-text-primary); background: var(--color-bg-content); box-sizing: border-box; }
.resource-center.embedded { height: auto; overflow: visible; padding: 0; background: transparent; }
.resource-center-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; max-width: 1520px; margin: 0 auto 24px; }
.resource-center-kicker { display: block; margin-bottom: 6px; color: var(--color-primary); font-size: 12px; font-weight: 750; }
.resource-center h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: 0; }
.resource-center p { margin: 8px 0 0; color: var(--color-text-secondary); font-size: 14px; }
.resource-center-actions { display: flex; align-items: center; gap: 10px; padding-top: 4px; }
.resource-scope { display: inline-flex; align-items: center; gap: 7px; color: var(--color-text-secondary); font-size: 12px; white-space: nowrap; }
.resource-scope i { width: 7px; height: 7px; border-radius: 50%; background: #1d9a64; }
.resource-refresh { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; border: 1px solid var(--color-border); border-radius: 6px; padding: 0 11px; background: var(--color-bg-surface); color: var(--color-text-primary); font-size: 13px; font-weight: 650; }
.resource-refresh:hover { border-color: var(--color-primary); color: var(--color-primary); }
.resource-refresh svg { width: 16px; height: 16px; }
.resource-tabs { display: flex; gap: 4px; max-width: 1520px; margin: 0 auto; border-bottom: 1px solid var(--color-border); }
.resource-tabs button { position: relative; display: grid; gap: 2px; min-width: 148px; border: 0; padding: 10px 13px 12px; background: transparent; color: var(--color-text-secondary); text-align: left; }
.resource-tabs button::after { position: absolute; right: 13px; bottom: -1px; left: 13px; height: 2px; background: transparent; content: ""; }
.resource-tabs button.active { color: var(--color-text-primary); }
.resource-tabs button.active::after { background: var(--color-primary); }
.resource-tabs span { font-size: 14px; font-weight: 750; }
.resource-tabs small { font-size: 12px; }
.resource-workbench { max-width: 1520px; margin: 22px auto 0; }
.resource-workbench :deep(.codex-extension-status), .resource-workbench :deep(.skills-application-bar) { border-radius: 6px; }
.resource-workbench :deep(.skills-management) { gap: 14px; }
@media (max-width: 900px) { .resource-center { padding: 22px 20px; }.resource-center-header { flex-direction: column; gap: 14px; }.resource-center-actions { padding-top: 0; }.resource-tabs button { min-width: 0; flex: 1; } }
</style>
