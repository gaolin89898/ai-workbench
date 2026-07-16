<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  desktopApi,
  type CodexSkill,
  type CodexSkillsListEntry,
} from "../services/desktop";

type SkillRow = CodexSkill & { cwd: string };
type ScopeFilter = "all" | "user" | "repo" | "system" | "admin";
const scopeFilters: ScopeFilter[] = ["all", "user", "repo", "system", "admin"];

const entries = ref<CodexSkillsListEntry[]>([]);
const extraRoots = ref<string[]>([]);
const loading = ref(false);
const savingRoots = ref(false);
const error = ref("");
const notice = ref("");
const search = ref("");
const scopeFilter = ref<ScopeFilter>("all");
const selectedPath = ref("");
const togglingPath = ref("");
const extraRootDraft = ref("");
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

const skills = computed<SkillRow[]>(() => {
  const uniqueSkills = new Map<string, SkillRow>();
  for (const entry of entries.value) {
    for (const skill of entry.skills) {
      // Global skills may be returned once for every requested project cwd.
      // Their absolute path is the stable identity exposed by app-server.
      if (!uniqueSkills.has(skill.path)) uniqueSkills.set(skill.path, { ...skill, cwd: entry.cwd });
    }
  }
  return [...uniqueSkills.values()];
});

const filteredSkills = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return skills.value.filter((skill) => {
    if (scopeFilter.value !== "all" && skill.scope !== scopeFilter.value) return false;
    return !query || `${skill.name} ${skill.description} ${skill.path} ${skill.scope}`.toLocaleLowerCase().includes(query);
  }).sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.path.localeCompare(right.path));
});

const selectedSkill = computed(() => skills.value.find((skill) => skill.path === selectedPath.value) ?? null);
const discoveryErrors = computed(() => entries.value.flatMap((entry) => entry.errors));
const scopeCounts = computed(() => skills.value.reduce<Record<string, number>>((counts, skill) => {
  counts[skill.scope] = (counts[skill.scope] ?? 0) + 1;
  return counts;
}, {}));

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function scopeLabel(scope: string): string {
  return ({ user: "用户", repo: "项目", system: "系统", admin: "管理员" } as Record<string, string>)[scope] ?? scope;
}

function selectSkill(skill: SkillRow): void {
  selectedPath.value = skill.path;
}

async function refresh(forceReload = true): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const snapshot = await desktopApi.listCodexSkills({
      forceReload,
    });
    entries.value = snapshot.entries;
    extraRoots.value = snapshot.extraRoots;
    if (!skills.value.some((skill) => skill.path === selectedPath.value)) {
      selectedPath.value = filteredSkills.value[0]?.path ?? "";
    }
  } catch (reason) {
    error.value = errorText(reason);
  } finally {
    loading.value = false;
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    // `forceReload` can itself produce a skills/changed event. Refreshing from
    // that event with the cached inventory avoids an endless scan cycle.
    void refresh(false);
  }, 300);
}

async function setEnabled(skill: SkillRow, enabled: boolean): Promise<void> {
  if (togglingPath.value) return;
  togglingPath.value = skill.path;
  notice.value = "";
  try {
    await desktopApi.setCodexSkillEnabled({ path: skill.path, name: skill.name, enabled });
    notice.value = `已${enabled ? "启用" : "停用"} ${skill.name}`;
    await refresh(true);
  } catch (reason) {
    error.value = `更新 Skill 失败：${errorText(reason)}`;
  } finally {
    togglingPath.value = "";
  }
}

function handleEnabledChange(skill: SkillRow, event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) void setEnabled(skill, target.checked);
}

async function saveExtraRoots(nextRoots: string[]): Promise<void> {
  if (savingRoots.value) return;
  savingRoots.value = true;
  notice.value = "";
  try {
    const snapshot = await desktopApi.setCodexSkillsExtraRoots(nextRoots);
    extraRoots.value = snapshot.extraRoots;
    extraRootDraft.value = "";
    notice.value = "额外 Skills 目录已更新";
    await refresh(true);
  } catch (reason) {
    error.value = `保存额外目录失败：${errorText(reason)}`;
  } finally {
    savingRoots.value = false;
  }
}

function addExtraRoot(): void {
  const root = extraRootDraft.value.trim();
  if (!root) return;
  void saveExtraRoots([...extraRoots.value, root]);
}

function removeExtraRoot(root: string): void {
  void saveExtraRoots(extraRoots.value.filter((item) => item !== root));
}

onMounted(async () => {
  await refresh(false);
});

onBeforeUnmount(() => {
  disposed = true;
  if (refreshTimer) clearTimeout(refreshTimer);
});

defineExpose({ refresh, refreshing: loading });
</script>

<template>
  <div class="skills-management">
    <div class="skills-application-bar" aria-label="全局 Skills 状态">
      <strong>已安装 {{ skills.filter((skill) => skill.enabled).length }} 个 Skills</strong>
      <div class="skills-application-chips">
        <span class="skills-application-chip codex">Codex: {{ skills.filter((skill) => skill.enabled).length }}</span>
        <span class="skills-application-chip muted">额外目录: {{ extraRoots.length }}</span>
        <span v-if="discoveryErrors.length" class="skills-application-chip warning">异常: {{ discoveryErrors.length }}</span>
      </div>
    </div>

    <p v-if="notice" class="skills-notice">{{ notice }}</p>
    <p v-if="error" class="skills-error">{{ error }}</p>

    <details class="skills-roots">
      <summary>额外 Skills 目录 <small>所有后续 Codex 会话</small></summary>
      <div class="skills-root-input">
        <input v-model="extraRootDraft" type="text" placeholder="输入绝对目录路径" :disabled="savingRoots" @keydown.enter.prevent="addExtraRoot" />
        <button class="button secondary mini" type="button" :disabled="savingRoots || !extraRootDraft.trim()" @click="addExtraRoot">添加</button>
      </div>
      <div v-if="extraRoots.length" class="skills-root-list">
        <div v-for="root in extraRoots" :key="root" class="skills-root-item"><code>{{ root }}</code><button type="button" title="移除目录" :disabled="savingRoots" @click="removeExtraRoot(root)">移除</button></div>
      </div>
      <p v-else class="skills-muted">未配置额外目录。</p>
    </details>

    <section class="skills-browser">
      <div class="skills-toolbar">
        <input v-model="search" type="search" placeholder="搜索名称、说明或路径" aria-label="搜索 Skills" />
        <div class="skills-filter" role="group" aria-label="按来源筛选">
          <button v-for="scope in scopeFilters" :key="scope" type="button" :class="{ active: scopeFilter === scope }" @click="scopeFilter = scope">
            {{ scope === "all" ? "全部" : scopeLabel(scope) }}<small v-if="scope !== 'all'">{{ scopeCounts[scope] ?? 0 }}</small>
          </button>
        </div>
      </div>
      <div class="skills-layout">
        <div class="skills-list" role="list">
          <div v-if="loading" class="skills-empty">正在扫描 Skills...</div>
          <div v-else-if="!filteredSkills.length" class="skills-empty">当前范围没有可用 Skills。</div>
          <button v-for="skill in filteredSkills" :key="skill.path" type="button" class="skills-list-item" :class="{ active: selectedPath === skill.path }" @click="selectSkill(skill)">
            <span><strong>{{ skill.interface?.displayName || skill.name }}</strong><small>{{ skill.shortDescription || skill.interface?.shortDescription || skill.description || "未提供说明" }}</small></span>
            <i :class="{ disabled: !skill.enabled }">{{ skill.enabled ? "已启用" : "已停用" }}</i>
          </button>
        </div>
        <article v-if="selectedSkill" class="skills-detail">
          <div class="skills-detail-head"><div><span class="badge">{{ scopeLabel(selectedSkill.scope) }}</span><h3>{{ selectedSkill.interface?.displayName || selectedSkill.name }}</h3><p>{{ selectedSkill.description || selectedSkill.shortDescription || "未提供说明" }}</p></div><label class="skills-switch"><input type="checkbox" :checked="selectedSkill.enabled" :disabled="Boolean(togglingPath)" @change="handleEnabledChange(selectedSkill, $event)" /><span></span><b>{{ selectedSkill.enabled ? "启用" : "停用" }}</b></label></div>
          <dl><div><dt>名称</dt><dd><code>{{ selectedSkill.name }}</code></dd></div><div><dt>路径</dt><dd><code>{{ selectedSkill.path }}</code></dd></div><div v-if="selectedSkill.cwd"><dt>发现范围</dt><dd><code>{{ selectedSkill.cwd }}</code></dd></div><div v-if="selectedSkill.interface?.defaultPrompt"><dt>默认提示</dt><dd>{{ selectedSkill.interface.defaultPrompt }}</dd></div></dl>
          <div v-if="selectedSkill.dependencies?.length" class="skills-dependencies"><h4>工具依赖</h4><div v-for="dependency in selectedSkill.dependencies" :key="`${dependency.type}-${dependency.value}`"><strong>{{ dependency.type }}</strong><code>{{ dependency.value }}</code><small v-if="dependency.description">{{ dependency.description }}</small></div></div>
        </article>
        <div v-else class="skills-detail skills-empty">选择一个 Skill 查看详细信息。</div>
      </div>
    </section>

    <details v-if="discoveryErrors.length" class="skills-discovery-errors"><summary>发现 {{ discoveryErrors.length }} 个需检查的文件</summary><div v-for="item in discoveryErrors" :key="`${item.path}-${item.message}`"><code>{{ item.path }}</code><p>{{ item.message }}</p></div></details>
  </div>
</template>

<style scoped>
.skills-management { display: grid; gap: 16px; color: #243044; }
.skills-application-bar, .skills-roots, .skills-browser, .skills-detail { border: 1px solid #dce3ed; background: #fff; border-radius: 8px; }
.skills-application-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; }
.skills-application-bar > strong { font-size: 14px; }.skills-application-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.skills-application-chip { border-radius: 999px; padding: 4px 9px; background: #edf8f1; color: #178159; font-size: 12px; font-weight: 700; }.skills-application-chip.muted { background: #f1f3f6; color: #64748b; }.skills-application-chip.warning { background: #fff3e5; color: #b56a16; }
.skills-muted, .skills-list-item small, .skills-detail p, .skills-dependencies small, .skills-roots small { color: #69778c; font-size: 12px; }
.skills-notice, .skills-error { margin: 0; padding: 9px 11px; border-radius: 5px; font-size: 13px; }.skills-notice { background: #edf8f1; color: #1e7a4c; }.skills-error { background: #fff1f0; color: #bd3b3b; }
.skills-roots, .skills-browser { padding: 15px; }.skills-roots summary { cursor: pointer; font-size: 14px; font-weight: 750; }.skills-roots summary small { margin-left: 8px; font-weight: 500; }.skills-detail h3, .skills-dependencies h4 { margin: 0; font-size: 15px; }.skills-detail p { margin: 4px 0 0; }
.skills-root-input, .skills-toolbar { display: flex; gap: 8px; margin-top: 12px; }.skills-root-input input, .skills-toolbar input { min-width: 0; flex: 1; border: 1px solid #ccd5e1; border-radius: 5px; padding: 8px 10px; background: #fff; color: inherit; }.skills-root-list { margin-top: 8px; display: grid; gap: 5px; }.skills-root-item { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 7px 9px; background: #f6f8fb; border-radius: 4px; }.skills-root-item code, dd code { overflow-wrap: anywhere; }.skills-root-item button { color: #ad3c3c; background: transparent; border: 0; cursor: pointer; }
.skills-toolbar { align-items: center; }.skills-filter { display: flex; gap: 3px; flex-wrap: wrap; }.skills-filter button { border: 1px solid #d6dee9; border-radius: 4px; padding: 6px 8px; background: #fff; color: #4b5b70; cursor: pointer; }.skills-filter button.active { background: #e7f0ff; color: #1967c9; border-color: #a9c8f0; }.skills-filter small { margin-left: 4px; }
.skills-layout { display: grid; grid-template-columns: minmax(250px, .85fr) minmax(360px, 1.5fr); min-height: 360px; border: 1px solid #dce3ed; border-radius: 5px; overflow: hidden; margin-top: 12px; }.skills-list { overflow: auto; border-right: 1px solid #dce3ed; }.skills-list-item { width: 100%; display: flex; justify-content: space-between; gap: 10px; text-align: left; border: 0; border-bottom: 1px solid #edf0f4; padding: 11px 12px; background: #fff; cursor: pointer; }.skills-list-item.active { background: #eef5ff; }.skills-list-item span { min-width: 0; display: grid; gap: 3px; }.skills-list-item strong, .skills-list-item small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.skills-list-item i { font-style: normal; color: #18835a; font-size: 11px; white-space: nowrap; }.skills-list-item i.disabled { color: #8894a5; }.skills-detail { border: 0; border-radius: 0; padding: 18px; overflow: auto; }.skills-detail-head { display: flex; justify-content: space-between; gap: 16px; }.badge { display: inline-block; padding: 2px 6px; border-radius: 3px; background: #eef1f5; color: #536276; font-size: 11px; }.skills-switch { display: flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }.skills-switch input { position: absolute; opacity: 0; }.skills-switch span { width: 30px; height: 17px; border-radius: 10px; background: #b3bdca; position: relative; }.skills-switch span::after { content: ""; position: absolute; width: 13px; height: 13px; border-radius: 50%; background: #fff; left: 2px; top: 2px; transition: transform .15s; }.skills-switch input:checked + span { background: #2d81df; }.skills-switch input:checked + span::after { transform: translateX(13px); }.skills-detail dl { margin: 20px 0 0; display: grid; gap: 10px; }.skills-detail dl div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 12px; }.skills-detail dt { color: #78869a; }.skills-detail dd { margin: 0; overflow-wrap: anywhere; }.skills-dependencies { margin-top: 18px; }.skills-dependencies > div { margin-top: 7px; display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 4px 10px; padding: 8px; background: #f7f9fb; border-radius: 4px; }.skills-dependencies small { grid-column: 2; }.skills-empty { display: grid; place-items: center; color: #78869a; padding: 24px; }.skills-discovery-errors { border: 1px solid #f2d1a3; background: #fff9f0; border-radius: 5px; padding: 10px 12px; color: #8a5a1f; }.skills-discovery-errors summary { cursor: pointer; }.skills-discovery-errors > div { border-top: 1px solid #f3dfbf; margin-top: 10px; padding-top: 8px; }.skills-discovery-errors p { margin: 3px 0 0; font-size: 13px; }
@media (max-width: 860px) { .skills-application-bar { align-items: flex-start; flex-direction: column; }.skills-layout { grid-template-columns: 1fr; }.skills-list { max-height: 260px; border-right: 0; border-bottom: 1px solid #dce3ed; }.skills-toolbar { align-items: stretch; flex-direction: column; } }
</style>
