<script setup lang="ts">
import { ref } from "vue";
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

const openSessionMenuPath = ref<string | null>(null);
type SessionRole = "local" | "terminal";

const sessionRoles: Array<{ id: SessionRole; label: string; detail: string }> = [
  { id: "local", label: "本机 AI", detail: "结构化聊天" },
  { id: "terminal", label: "接管终端", detail: "可控制终端" },
];

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

function localAiSessionsForProject(path: string) {
  return sessionsForProject(path).filter((session) => !session.terminalSessionId);
}

function terminalSessionsForProject(path: string) {
  return sessionsForProject(path).filter((session) => Boolean(session.terminalSessionId));
}

function sessionsForRoleProject(role: SessionRole, path: string) {
  return role === "local" ? localAiSessionsForProject(path) : terminalSessionsForProject(path);
}

function projectsForRole(role: SessionRole) {
  if (role === "local") return props.projects;
  return props.projects.filter((project) => terminalSessionsForProject(project.path).length);
}

function roleSessionCount(role: SessionRole) {
  return props.activeSessions.filter((session) => (
    role === "local" ? !session.terminalSessionId : Boolean(session.terminalSessionId)
  )).length;
}

function selectProject(path: string) {
  openSessionMenuPath.value = null;
  emit("selectProject", path);
}

function toggleSessionMenu(path: string) {
  emit("selectProject", path);
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

function isThinking(session: AiSession) {
  return Boolean(props.thinkingSessionIds[session.id]);
}
</script>

<template>
  <aside class="sidebar">
    <section class="sidebar-section">
      <div class="sidebar-heading">
        <span>角色</span>
        <button class="icon-button" title="选择本地项目" type="button" @click="emit('chooseProject')">＋</button>
      </div>
      <div class="project-tree">
        <button v-if="!projects.length" class="tree-empty" type="button" @click="emit('chooseProject')">
          选择本地项目
        </button>
        <section v-for="role in sessionRoles" :key="role.id" class="tree-role">
          <div class="tree-role-heading">
            <span>{{ role.label }}</span>
            <small>{{ roleSessionCount(role.id) ? `${roleSessionCount(role.id)} 个会话` : role.detail }}</small>
          </div>
          <template v-if="projectsForRole(role.id).length">
            <section v-for="project in projectsForRole(role.id)" :key="`${role.id}-${project.path}`" class="tree-project">
              <div class="tree-project-row">
                <button
                  class="tree-project-title"
                  :class="{ active: selectedProjectPath === project.path }"
                  type="button"
                  @click="selectProject(project.path)"
                >
                  <img class="tree-icon" :src="projectFolderIcon" alt="" aria-hidden="true" />
                  <strong>{{ project.name }}</strong>
                </button>
                <button
                  v-if="role.id === 'local'"
                  class="tree-project-add"
                  title="新增会话"
                  type="button"
                  @click.stop="toggleSessionMenu(project.path)"
                >
                  <img :src="sessionPlusIcon" alt="" aria-hidden="true" />
                </button>
                <div v-if="role.id === 'local' && openSessionMenuPath === project.path" class="tree-session-menu">
                  <div class="tree-session-menu-group">
                    <span class="tree-session-menu-label">新建 AI 会话</span>
                    <button v-for="provider in providers" :key="provider.id" type="button" @click="createSession(project.path, provider.id)">
                      <img class="tree-session-menu-icon image" :src="providerIcon(provider.id)" alt="" aria-hidden="true" />
                      <span>新建 {{ provider.name }} 会话</span>
                    </button>
                  </div>
                </div>
              </div>
              <div class="tree-chat-list">
                <template v-if="sessionsForRoleProject(role.id, project.path).length">
                  <div v-for="session in sessionsForRoleProject(role.id, project.path)" :key="session.id" class="tree-chat-row">
                    <button
                      class="tree-chat"
                      :class="{ active: activeAiSession?.id === session.id, terminal: role.id === 'terminal' }"
                      type="button"
                      @click="emit('selectSession', session)"
                    >
                      <img class="tree-provider-icon" :src="providerIcon(session.providerId)" alt="" aria-hidden="true" />
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
                      @click.stop="emit('archiveSession', session.id, true)"
                    >
                      <img :src="archiveBoxIcon" alt="" aria-hidden="true" />
                    </button>
                  </div>
                </template>
                <button
                  v-else-if="role.id === 'local'"
                  class="tree-chat muted"
                  :class="{ active: selectedProjectPath === project.path }"
                  type="button"
                  @click="toggleSessionMenu(project.path)"
                >
                  新建 AI 会话
                </button>
              </div>
            </section>
          </template>
          <div v-else class="tree-role-empty">{{ role.id === "terminal" ? "暂无接管终端" : "暂无项目" }}</div>
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
