<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { desktopApi, type ClaudeMigrationOverview } from "../services/desktop";

const overview = ref<ClaudeMigrationOverview | null>(null);
const loading = ref(false);
const migrating = ref(false);
const error = ref("");
const notice = ref("");
const selectedMcps = ref<Set<string>>(new Set());

const exists = computed(() => Boolean(overview.value?.exists));
const mcpCount = computed(() => overview.value?.mcps.length ?? 0);

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function toggleMcp(name: string): void {
  const next = new Set(selectedMcps.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selectedMcps.value = next;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    overview.value = await desktopApi.scanClaudeConfig();
  } catch (err) {
    error.value = `扫描 Claude 配置失败：${errorText(err)}`;
  } finally {
    loading.value = false;
  }
}

async function migrateSelectedMcps(): Promise<void> {
  const target = overview.value;
  if (!target || selectedMcps.value.size === 0 || migrating.value) return;
  migrating.value = true;
  error.value = "";
  try {
    const result = await desktopApi.migrateClaudeMcp(target, [...selectedMcps.value]);
    const migrated = result.migratedMcps.length;
    const failed = result.failedMcps.length;
    if (migrated > 0) {
      notice.value = `已迁移 ${migrated} 个 MCP 服务器到 Codex${failed > 0 ? `，${failed} 个失败` : ""}。请重启 Codex 会话后生效。`;
      selectedMcps.value = new Set();
      await load();
    } else {
      notice.value = `迁移失败：${result.failedMcps.map((item) => `${item.name}（${item.error}）`).join("；")}`;
    }
  } catch (err) {
    error.value = `迁移失败：${errorText(err)}`;
  } finally {
    migrating.value = false;
  }
}

defineExpose({ load });

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="claude-migration">
    <header class="claude-migration-header">
      <div>
        <strong>Claude Code 配置迁移</strong>
        <p>扫描本机 <code>{{ overview?.configDir || "~/.claude" }}</code>，把 MCP 服务器迁移到 Codex。Skills 与命令列出供手动复制，历史会话仅展示统计。</p>
      </div>
      <button class="codex-action-button" type="button" :disabled="loading" @click="load">
        {{ loading ? "扫描中" : "重新扫描" }}
      </button>
    </header>

    <p v-if="error" class="claude-migration-error">{{ error }}</p>
    <p v-if="notice" class="claude-migration-notice">{{ notice }}</p>

    <div v-if="loading && !overview" class="claude-migration-empty">正在扫描 Claude 配置目录...</div>

    <div v-else-if="!exists" class="claude-migration-empty">
      <strong>未找到 Claude Code 配置</strong>
      <span>目录 <code>{{ overview?.configDir }}</code> 不存在。安装并运行过 Claude Code 后这里会显示可迁移的配置。</span>
    </div>

    <template v-else>
      <div class="claude-migration-stats">
        <article><span>MCP 服务器</span><strong>{{ mcpCount }}</strong></article>
        <article><span>Skills</span><strong>{{ overview?.skills.length ?? 0 }}</strong></article>
        <article><span>命令</span><strong>{{ overview?.commands.length ?? 0 }}</strong></article>
        <article><span>历史会话</span><strong>{{ overview?.history.sessionFiles ?? 0 }}</strong><small>{{ formatBytes(overview?.history.totalBytes ?? 0) }}</small></article>
      </div>

      <section v-if="overview?.settings.model || overview?.settings.envModelKeys.length" class="claude-migration-section">
        <h3>模型与权限</h3>
        <dl class="claude-migration-model">
          <template v-if="overview?.settings.model">
            <div><dt>默认模型</dt><dd><code>{{ overview.settings.model }}</code></dd></div>
          </template>
          <div v-if="overview?.settings.permissionsAllow.length"><dt>允许的权限</dt><dd>{{ overview.settings.permissionsAllow.length }} 条</dd></div>
          <div v-if="overview?.settings.permissionsDeny.length"><dt>拒绝的权限</dt><dd>{{ overview.settings.permissionsDeny.length }} 条</dd></div>
          <div v-if="overview?.settings.envModelKeys.length"><dt>环境模型键</dt><dd>{{ overview.settings.envModelKeys.length }} 个（不含任何凭证）</dd></div>
        </dl>
      </section>

      <section class="claude-migration-section">
        <h3>MCP 服务器
          <button class="codex-action-button primary" type="button" :disabled="!selectedMcps.size || migrating" @click="migrateSelectedMcps">
            {{ migrating ? "迁移中" : `迁移选中到 Codex（${selectedMcps.size}）` }}
          </button>
        </h3>
        <div v-if="!overview?.mcps.length" class="claude-migration-sub-empty">~/.claude/mcp.json 中没有可迁移的服务器。</div>
        <div v-else class="claude-migration-mcps">
          <label v-for="mcp in overview?.mcps" :key="mcp.name" class="claude-migration-mcp" :class="{ checked: selectedMcps.has(mcp.name) }">
            <input type="checkbox" :checked="selectedMcps.has(mcp.name)" @change="toggleMcp(mcp.name)" />
            <span class="claude-migration-mcp-name"><strong>{{ mcp.name }}</strong><small>{{ mcp.type }}{{ mcp.command ? ` · ${mcp.command}` : mcp.url ? ` · ${mcp.url}` : "" }}</small></span>
            <span class="claude-migration-mcp-state">{{ mcp.enabled ? "启用" : "停用" }}</span>
          </label>
        </div>
      </section>

      <section class="claude-migration-section">
        <h3>Skills 与命令</h3>
        <div v-if="!overview?.skills.length && !overview?.commands.length" class="claude-migration-sub-empty">未发现自定义 Skills 或命令。</div>
        <div v-else class="claude-migration-lists">
          <div v-if="overview?.skills.length">
            <strong>Skills（{{ overview.skills.length }}）</strong>
            <ul>
              <li v-for="skill in overview.skills" :key="skill.path"><code>{{ skill.name }}</code><span>{{ skill.path }}</span></li>
            </ul>
          </div>
          <div v-if="overview?.commands.length">
            <strong>命令（{{ overview.commands.length }}）</strong>
            <ul>
              <li v-for="command in overview.commands" :key="command.path"><code>{{ command.name }}</code><span>{{ command.path }}</span></li>
            </ul>
          </div>
        </div>
      </section>

      <section class="claude-migration-section">
        <h3>历史会话</h3>
        <p class="claude-migration-history-note">
          共 {{ overview?.history.sessionFiles ?? 0 }} 个会话文件（{{ formatBytes(overview?.history.totalBytes ?? 0) }}），
          最近活动 {{ formatTime(overview?.history.lastModifiedAt ?? null) }}。
          为保护隐私，本工具不读取历史会话内容。
        </p>
      </section>

      <p v-if="overview?.skippedSecrets.length" class="claude-migration-secrets-note">
        已跳过 {{ overview.skippedSecrets.length }} 个疑似凭证字段（token/key/secret 等），不会读取、展示或迁移。
      </p>
    </template>
  </div>
</template>

<style scoped>
.claude-migration { display: flex; flex-direction: column; gap: 16px; }
.claude-migration-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.claude-migration-header strong { font-size: 15px; }
.claude-migration-header p { margin: 6px 0 0; color: var(--color-text-secondary); font-size: 13px; line-height: 1.6; }
.claude-migration code { font-size: 12px; }
.claude-migration-error { color: var(--color-danger, #d54941); font-size: 13px; }
.claude-migration-notice { color: var(--color-primary, #165dff); font-size: 13px; }
.claude-migration-empty { display: flex; flex-direction: column; gap: 6px; padding: 32px 20px; border: 1px dashed var(--color-border); border-radius: 12px; color: var(--color-text-secondary); font-size: 13px; }
.claude-migration-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.claude-migration-stats article { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border: 1px solid var(--color-border); border-radius: 12px; }
.claude-migration-stats span { color: var(--color-text-secondary); font-size: 12px; }
.claude-migration-stats strong { font-size: 20px; }
.claude-migration-stats small { color: var(--color-text-muted); font-size: 12px; }
.claude-migration-section h3 { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; font-size: 14px; }
.claude-migration-model { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 0; }
.claude-migration-model div { padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 8px; }
.claude-migration-model dt { color: var(--color-text-secondary); font-size: 12px; }
.claude-migration-model dd { margin: 4px 0 0; font-size: 13px; }
.claude-migration-mcps { display: flex; flex-direction: column; gap: 6px; }
.claude-migration-mcp { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 8px; cursor: pointer; }
.claude-migration-mcp.checked { border-color: var(--color-primary, #165dff); }
.claude-migration-mcp-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.claude-migration-mcp-name small { color: var(--color-text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.claude-migration-mcp-state { color: var(--color-text-secondary); font-size: 12px; }
.claude-migration-lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.claude-migration-lists ul { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.claude-migration-lists li { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 8px; font-size: 12px; }
.claude-migration-lists li span { color: var(--color-text-secondary); }
.claude-migration-sub-empty { color: var(--color-text-secondary); font-size: 13px; }
.claude-migration-history-note { margin: 0; color: var(--color-text-secondary); font-size: 13px; line-height: 1.7; }
.claude-migration-secrets-note { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--color-bg-hover, #f2f3f5); color: var(--color-text-secondary); font-size: 12px; }
</style>
