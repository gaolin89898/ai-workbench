<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { AiProvider, AiSession, TerminalSession, ViewName, WorkspaceProject } from "../services/tauri";

const archiveBoxIcon = new URL("../assets/icons/archive-box.svg", import.meta.url).href;
const projectFolderIcon = new URL("../assets/icons/project-folder.svg", import.meta.url).href;
const sessionPlusIcon = new URL("../assets/icons/session-plus.svg", import.meta.url).href;
const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerDeepseekIcon = new URL("../assets/icons/provider-deepseek.svg", import.meta.url).href;
const providerGeminiIcon = new URL("../assets/icons/provider-gemini.svg", import.meta.url).href;
const settingsIcon = new URL("../assets/icons/settings.svg", import.meta.url).href;

const props = defineProps<{
  projects: WorkspaceProject[];
  providers: AiProvider[];
  terminalSessions: TerminalSession[];
  activeSessions: AiSession[];
  activeAiSession: AiSession | null;
  selectedProjectPath: string;
  thinkingSessionIds: Record<string, boolean>;
  activeView: ViewName;
}>();

const emit = defineEmits<{
  chooseProject: [];
  selectProject: [path: string];
  newChat: [path: string];
  createSession: [path: string, providerId: string];
  attachSession: [path: string, terminalSessionId: string, providerId: string];
  selectSession: [session: AiSession];
  archiveSession: [sessionId: string, archived: boolean];
  switchView: [view: ViewName];
}>();

const openProjectMenuPath = ref<string | null>(null);
const openContextMenu = ref<{ session: AiSession; x: number; y: number } | null>(null);
type SessionProviderGroup = { id: string; label: string; sessions: AiSession[] };

const providerIcons: Record<string, string> = {
  claude: providerClaudeIcon,
  codex: providerCodexIcon,
  deepseek: providerDeepseekIcon,
  gemini: providerGeminiIcon,
};

const providerGroupLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  deepseek: "DeepSeek",
};

const providerGroupOrder = ["codex", "claude", "deepseek"];

function providerIcon(providerId: string) {
  return providerIcons[providerId] ?? providerCodexIcon;
}

function sessionsForProject(path: string) {
  return props.activeSessions.filter((session) => session.summary === path);
}

function providerLabel(providerId: string) {
  return providerGroupLabels[providerId] ?? props.providers.find((provider) => provider.id === providerId)?.name ?? providerId;
}

function sessionGroupsForProject(path: string): SessionProviderGroup[] {
  const groups = new Map<string, AiSession[]>();
  for (const session of sessionsForProject(path)) {
    groups.set(session.providerId, [...(groups.get(session.providerId) ?? []), session]);
  }
  return [...groups.entries()]
    .map(([id, sessions]) => ({ id, label: providerLabel(id), sessions }))
    .sort((left, right) => {
      const leftIndex = providerGroupOrder.indexOf(left.id);
      const rightIndex = providerGroupOrder.indexOf(right.id);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? providerGroupOrder.length : leftIndex) - (rightIndex === -1 ? providerGroupOrder.length : rightIndex);
      }
      return left.label.localeCompare(right.label);
    });
}

function selectProject(path: string) {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  emit("selectProject", path);
  emit("switchView", "aiSessions");
}

function startNewChat(path: string) {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  emit("newChat", path);
  emit("switchView", "aiSessions");
}

function openProjectMenu(event: MouseEvent, path: string) {
  event.preventDefault();
  openContextMenu.value = null;
  openProjectMenuPath.value = path;
}

function closeMenusOnOutsideClick(event: PointerEvent) {
  const target = event.target;
  if (target instanceof Element && target.closest(".tree-project-row, .session-context-menu")) return;
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
}

function closeMenusOnEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
}

function attachSession(path: string, terminalSession: TerminalSession) {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  emit("attachSession", path, terminalSession.sessionId, providerIdFromTool(terminalSession.tool));
}

function archiveProjectSessions(project: WorkspaceProject) {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  for (const session of sessionsForProject(project.path)) {
    emit("archiveSession", session.id, true);
  }
}

function selectSession(session: AiSession) {
  openContextMenu.value = null;
  emit("selectSession", session);
  emit("switchView", "aiSessions");
}

function archiveSession(session: AiSession) {
  openContextMenu.value = null;
  emit("archiveSession", session.id, true);
}

function providerIdFromTool(tool: string) {
  const normalized = tool.toLowerCase();
  return props.providers.some((provider) => provider.id === normalized) ? normalized : (props.providers[0]?.id ?? "codex");
}

function sessionTimeLabel(session: AiSession) {
  if (!session.updatedAt) return "";
  const time = Date.parse(session.updatedAt);
  if (Number.isNaN(time)) return "";
  const diffMs = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时`;
  return `${Math.floor(diffMs / day)} 天`;
}

function isThinking(session: AiSession) {
  return Boolean(props.thinkingSessionIds[session.id]);
}

function openSessionContextMenu(event: MouseEvent, session: AiSession) {
  const menuWidth = 168;
  const menuHeight = 434;
  const margin = 10;
  openProjectMenuPath.value = null;
  emit("selectSession", session);
  emit("switchView", "aiSessions");
  openContextMenu.value = {
    session,
    x: Math.max(margin, Math.min(event.clientX, window.innerWidth - menuWidth - margin)),
    y: Math.max(margin, Math.min(event.clientY, window.innerHeight - menuHeight - margin)),
  };
}

async function copyText(text: string | null | undefined) {
  if (!text) return;
  await navigator.clipboard?.writeText(text);
  openContextMenu.value = null;
}

function copySessionDeepLink(session: AiSession) {
  void copyText(`ai-workbench://sessions/${session.id}`);
}

onMounted(() => {
  document.addEventListener("pointerdown", closeMenusOnOutsideClick);
  document.addEventListener("keydown", closeMenusOnEscape);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeMenusOnOutsideClick);
  document.removeEventListener("keydown", closeMenusOnEscape);
});
</script>

<template>
  <aside class="sidebar">
    <section class="sidebar-section">
      <div class="sidebar-heading">
        <span>项目</span>
        <button class="icon-button" title="选择本地项目" type="button" @click="emit('chooseProject')">＋</button>
      </div>
      <div class="project-tree">
        <button v-if="!projects.length" class="tree-empty" type="button" @click="emit('chooseProject')">
          选择本地项目
        </button>
        <section v-for="project in projects" :key="project.path" class="tree-project">
          <div class="tree-project-row" :class="{ active: selectedProjectPath === project.path }">
            <button
              class="tree-project-title"
              :class="{ active: selectedProjectPath === project.path }"
              type="button"
              @click="selectProject(project.path)"
              @contextmenu="openProjectMenu($event, project.path)"
            >
              <img class="tree-icon" :src="projectFolderIcon" alt="" aria-hidden="true" />
              <strong>{{ project.name }}</strong>
            </button>
            <button
              class="tree-project-add"
              title="新增会话"
              type="button"
              @click.stop="startNewChat(project.path)"
            >
              <img :src="sessionPlusIcon" alt="" aria-hidden="true" />
            </button>
            <div v-if="openProjectMenuPath === project.path" class="tree-project-menu">
              <button type="button" disabled title="稍后支持项目置顶">
                <span class="tree-project-menu-icon" aria-hidden="true">⌁</span>
                <span>置顶项目</span>
              </button>
              <button type="button" disabled title="稍后支持从系统文件管理器打开">
                <span class="tree-project-menu-icon" aria-hidden="true">▱</span>
                <span>在文件管理器中打开</span>
              </button>
              <button type="button" disabled title="稍后支持创建永久工作树">
                <span class="tree-project-menu-icon" aria-hidden="true">↗</span>
                <span>创建永久工作树</span>
              </button>
              <button type="button" disabled title="稍后支持重命名本地项目">
                <span class="tree-project-menu-icon" aria-hidden="true">⌇</span>
                <span>重命名项目</span>
              </button>
              <button
                type="button"
                :disabled="!sessionsForProject(project.path).length"
                title="归档这个项目下的全部会话"
                @click="archiveProjectSessions(project)"
              >
                <span class="tree-project-menu-icon" aria-hidden="true">▭</span>
                <span>归档对话</span>
              </button>
              <button type="button" disabled title="稍后支持从列表中移除项目">
                <span class="tree-project-menu-icon" aria-hidden="true">×</span>
                <span>移除</span>
              </button>
            </div>
          </div>
          <div class="tree-chat-list">
            <template v-if="sessionsForProject(project.path).length">
              <section v-for="group in sessionGroupsForProject(project.path)" :key="group.id" class="tree-provider-group">
                <div class="tree-provider-group-heading">
                  <img class="tree-provider-group-icon" :src="providerIcon(group.id)" alt="" aria-hidden="true" />
                  <span>{{ group.label }}</span>
                </div>
                <div
                  v-for="session in group.sessions"
                  :key="session.id"
                  class="tree-chat-row"
                  :class="{ active: activeAiSession?.id === session.id, terminal: Boolean(session.terminalSessionId) }"
                  @contextmenu.prevent.stop="openSessionContextMenu($event, session)"
                >
                  <button
                    class="tree-chat"
                    :class="{ active: activeAiSession?.id === session.id, terminal: Boolean(session.terminalSessionId) }"
                    type="button"
                    @click="selectSession(session)"
                  >
                    <span class="tree-chat-copy">
                      <span>{{ session.title }}</span>
                      <i v-if="isThinking(session)" class="tree-chat-spinner" aria-label="思考中"></i>
                      <small v-else-if="sessionTimeLabel(session)">{{ sessionTimeLabel(session) }}</small>
                    </span>
                  </button>
                  <button
                    class="tree-chat-action"
                    title="归档会话"
                    type="button"
                    @click.stop="archiveSession(session)"
                  >
                    <img :src="archiveBoxIcon" alt="" aria-hidden="true" />
                  </button>
                </div>
              </section>
            </template>
            <div v-else class="tree-chat muted tree-chat-empty">暂无会话</div>
          </div>
        </section>
      </div>
    </section>
    <button
      class="sidebar-settings-button"
      :class="{ active: activeView === 'settings' }"
      type="button"
      @click="emit('switchView', 'settings')"
    >
      <img :src="settingsIcon" alt="" aria-hidden="true" />
      <span>设置</span>
    </button>
    <div
      v-if="openContextMenu"
      class="session-context-menu"
      :style="{ left: `${openContextMenu.x}px`, top: `${openContextMenu.y}px` }"
      role="menu"
    >
      <div class="session-context-menu-section">
        <button type="button" disabled>置顶对话</button>
        <button type="button" disabled>重命名对话</button>
        <button type="button" @click="archiveSession(openContextMenu.session)">归档对话</button>
        <button type="button" disabled>标记为未读</button>
      </div>
      <div class="session-context-menu-section">
        <button type="button" disabled>在文件管理器中打开</button>
        <button type="button" :disabled="!openContextMenu.session.summary" @click="copyText(openContextMenu.session.summary)">复制工作目录</button>
        <button type="button" @click="copyText(openContextMenu.session.id)">复制会话 ID</button>
        <button type="button" @click="copySessionDeepLink(openContextMenu.session)">复制深度链接</button>
      </div>
      <div class="session-context-menu-section">
        <button type="button" disabled>派生到本地</button>
        <button type="button" disabled>派生到新工作树</button>
      </div>
      <div class="session-context-menu-section">
        <button type="button" disabled>在新窗口中打开</button>
      </div>
    </div>
  </aside>
</template>
