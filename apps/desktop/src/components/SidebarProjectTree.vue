<script setup lang="ts">
import { ref } from "vue";
import type { AiProvider, AiSession, TerminalSession, ViewName, WorkspaceProject } from "../services/tauri";

const archiveBoxIcon = new URL("../assets/icons/archive-box.svg", import.meta.url).href;
const projectFolderIcon = new URL("../assets/icons/project-folder.svg", import.meta.url).href;
const sessionPlusIcon = new URL("../assets/icons/session-plus.svg", import.meta.url).href;
const terminalIcon = new URL("../assets/icons/terminal.svg", import.meta.url).href;
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

const openSessionMenuPath = ref<string | null>(null);

const providerIcons: Record<string, string> = {
  claude: providerClaudeIcon,
  codex: providerCodexIcon,
  deepseek: providerDeepseekIcon,
  gemini: providerGeminiIcon,
};

function providerIcon(providerId: string) {
  return providerIcons[providerId] ?? providerCodexIcon;
}

function sessionsForProject(path: string) {
  return props.activeSessions.filter((session) => session.summary === path);
}

function attachableTerminalSessions() {
  return props.terminalSessions.filter((session) => session.tool !== "unknown");
}

function toggleSessionMenu(path: string) {
  openSessionMenuPath.value = openSessionMenuPath.value === path ? null : path;
}

function createSession(path: string, providerId: string) {
  openSessionMenuPath.value = null;
  emit("createSession", path, providerId);
}

function attachSession(path: string, terminalSession: TerminalSession) {
  openSessionMenuPath.value = null;
  emit("attachSession", path, terminalSession.sessionId, providerIdFromTool(terminalSession.tool));
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
          <div class="tree-project-row">
            <button class="tree-project-title" type="button" @click="emit('selectProject', project.path)">
              <img class="tree-icon" :src="projectFolderIcon" alt="" aria-hidden="true" />
              <strong>{{ project.name }}</strong>
            </button>
            <button
              class="tree-project-add"
              title="新增会话"
              type="button"
              @click.stop="toggleSessionMenu(project.path)"
            >
              <img :src="sessionPlusIcon" alt="" aria-hidden="true" />
            </button>
            <div v-if="openSessionMenuPath === project.path" class="tree-session-menu">
              <div class="tree-session-menu-group">
                <span class="tree-session-menu-label">新建终端</span>
                <button v-for="provider in providers" :key="provider.id" type="button" @click="createSession(project.path, provider.id)">
                  <img class="tree-session-menu-icon image" :src="providerIcon(provider.id)" alt="" aria-hidden="true" />
                  <span>新建 {{ provider.name }} 会话</span>
                </button>
              </div>
              <div class="tree-session-menu-group">
                <span class="tree-session-menu-label">接管已有终端</span>
                <button
                  v-for="session in attachableTerminalSessions()"
                  :key="session.sessionId"
                  type="button"
                  @click="attachSession(project.path, session)"
                >
                  <img class="tree-session-menu-icon image" :src="terminalIcon" alt="" aria-hidden="true" />
                  <span>{{ session.name }} · {{ session.tool || session.backend }}</span>
                </button>
                <button v-if="!attachableTerminalSessions().length" class="disabled" type="button" disabled>
                  <span class="tree-session-menu-icon">!</span>
                  <span>未发现 AI CLI 终端</span>
                </button>
              </div>
            </div>
          </div>
          <div class="tree-chat-list">
            <template v-if="sessionsForProject(project.path).length">
              <div v-for="session in sessionsForProject(project.path)" :key="session.id" class="tree-chat-row">
                <button
                  class="tree-chat"
                  :class="{ active: activeAiSession?.id === session.id }"
                  type="button"
                  @click="emit('selectSession', session)"
                >
                  <img class="tree-provider-icon" :src="providerIcon(session.providerId)" alt="" aria-hidden="true" />
                  <span class="tree-chat-copy">
                    <span>{{ session.title }}</span>
                    <small v-if="sessionTimeLabel(session)">{{ sessionTimeLabel(session) }}</small>
                  </span>
                </button>
                <button
                  class="tree-chat-action"
                  title="归档会话"
                  type="button"
                  @click.stop="emit('archiveSession', session.id, true)"
                >
                  <img :src="archiveBoxIcon" alt="" aria-hidden="true" />
                </button>
              </div>
            </template>
            <button v-else class="tree-chat muted" type="button" @click="toggleSessionMenu(project.path)">
              新建 CLI 会话
            </button>
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
  </aside>
</template>
