<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { AiProvider, AiSession, TerminalSession, ViewName, WorkspaceProject } from "../services/tauri";

const archiveBoxIcon = new URL("../assets/icons/archive-box.svg", import.meta.url).href;
const projectFolderIcon = new URL("../assets/icons/project-folder.svg", import.meta.url).href;
const sessionPlusIcon = new URL("../assets/icons/session-plus.svg", import.meta.url).href;
const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerDeepseekIcon = new URL("../assets/icons/provider-deepseek.svg", import.meta.url).href;
const providerOpencodeIcon = new URL("../assets/icons/provider-opencode.svg", import.meta.url).href;
const settingsIcon = new URL("../assets/icons/settings.svg", import.meta.url).href;
const pinIcon = new URL("../assets/icons/pin.svg", import.meta.url).href;
const folderOpenIcon = new URL("../assets/icons/folder-open.svg", import.meta.url).href;
const gitBranchIcon = new URL("../assets/icons/git-branch.svg", import.meta.url).href;
const editIcon = new URL("../assets/icons/edit.svg", import.meta.url).href;
const trashIcon = new URL("../assets/icons/trash.svg", import.meta.url).href;
const mailUnreadIcon = new URL("../assets/icons/mail-unread.svg", import.meta.url).href;
const fingerprintIcon = new URL("../assets/icons/fingerprint.svg", import.meta.url).href;
const linkIcon = new URL("../assets/icons/link.svg", import.meta.url).href;
const gitForkIcon = new URL("../assets/icons/git-fork.svg", import.meta.url).href;
const branchForkIcon = new URL("../assets/icons/branch-fork.svg", import.meta.url).href;
const windowIcon = new URL("../assets/icons/window.svg", import.meta.url).href;

const props = defineProps<{
  projects: WorkspaceProject[];
  providers: AiProvider[];
  terminalSessions: TerminalSession[];
  activeSessions: AiSession[];
  activeAiSession: AiSession | null;
  selectedProjectPath: string;
  thinkingSessionIds: Record<string, boolean>;
  pinnedSessionIds?: Record<string, boolean>;
  unreadSessionIds?: Record<string, boolean>;
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
  renameProject: [project: WorkspaceProject, name: string];
  removeProject: [project: WorkspaceProject];
  openInFileManager: [project: WorkspaceProject];
  renameSession: [session: AiSession, title: string];
  togglePinSession: [session: AiSession];
  markSessionUnread: [session: AiSession];
  deriveSession: [session: AiSession];
  openSessionInNewWindow: [session: AiSession];
}>();

const openProjectMenuPath = ref<string | null>(null);
const openContextMenu = ref<{ session: AiSession; x: number; y: number } | null>(null);
const collapsedGroups = ref<Record<string, boolean>>({});
const expandedGroups = ref<Record<string, boolean>>({});
const renameDialog = ref<{ target: AiSession | WorkspaceProject; kind: "session" | "project" } | null>(null);
const renameDraft = ref("");
const confirmDialog = ref<{ title: string; message: string; details?: string; action: () => void } | null>(null);
const collapsedProjects = ref<Record<string, boolean>>({});

function isProjectCollapsedLocal(path: string) {
  return Boolean(collapsedProjects.value[path]);
}

function toggleProjectCollapsed(path: string) {
  collapsedProjects.value = {
    ...collapsedProjects.value,
    [path]: !collapsedProjects.value[path],
  };
}
const COLLAPSED_SESSION_LIMIT = 5;
type SessionProviderGroup = { id: string; label: string; sessions: AiSession[] };

function groupCollapseKey(projectPath: string, groupId: string) {
  return `${projectPath}::${groupId}`;
}

const providerIcons: Record<string, string> = {
  claude: providerClaudeIcon,
  codex: providerCodexIcon,
  deepseek: providerDeepseekIcon,
  opencode: providerOpencodeIcon,
};

const providerGroupLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  deepseek: "DeepSeek",
};

const providerGroupOrder = ["codex", "claude", "opencode", "deepseek"];

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

function isGroupCollapsed(projectPath: string, groupId: string) {
  return Boolean(collapsedGroups.value[groupCollapseKey(projectPath, groupId)]);
}

function toggleGroupCollapsed(projectPath: string, groupId: string) {
  const key = groupCollapseKey(projectPath, groupId);
  collapsedGroups.value = {
    ...collapsedGroups.value,
    [key]: !collapsedGroups.value[key],
  };
}

function isGroupSessionsExpanded(projectPath: string, groupId: string) {
  return Boolean(expandedGroups.value[groupCollapseKey(projectPath, groupId)]);
}

function toggleGroupSessionsExpanded(projectPath: string, groupId: string) {
  const key = groupCollapseKey(projectPath, groupId);
  expandedGroups.value = {
    ...expandedGroups.value,
    [key]: !expandedGroups.value[key],
  };
}

function visibleSessionsForGroup(projectPath: string, group: SessionProviderGroup): AiSession[] {
  if (isGroupCollapsed(projectPath, group.id)) return [];
  if (isGroupSessionsExpanded(projectPath, group.id)) return group.sessions;
  return group.sessions.slice(0, COLLAPSED_SESSION_LIMIT);
}

function hiddenSessionCountForGroup(projectPath: string, group: SessionProviderGroup) {
  if (isGroupCollapsed(projectPath, group.id)) return 0;
  if (isGroupSessionsExpanded(projectPath, group.id)) return 0;
  return Math.max(0, group.sessions.length - COLLAPSED_SESSION_LIMIT);
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

function renameProjectAction(project: WorkspaceProject) {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  renameDraft.value = project.name;
  renameDialog.value = { target: project, kind: "project" };
}

function removeProjectAction(project: WorkspaceProject) {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  confirmDialog.value = {
    title: "从项目列表移除",
    message: `确定要从项目列表移除「${project.name}」吗？`,
    details: "磁盘上的目录不会被删除。",
    action: () => emit("removeProject", project),
  };
}

function closeConfirmDialog() {
  confirmDialog.value = null;
}

function performConfirmAction() {
  const dialog = confirmDialog.value;
  if (!dialog) return;
  dialog.action();
  closeConfirmDialog();
}

function onConfirmKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    performConfirmAction();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeConfirmDialog();
  }
}

function openInFileManagerAction(project: WorkspaceProject) {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  emit("openInFileManager", project);
}

function isSessionPinnedLocal(session: AiSession) {
  return Boolean(props.pinnedSessionIds?.[session.id]);
}

function isSessionUnreadLocal(session: AiSession) {
  return Boolean(props.unreadSessionIds?.[session.id]);
}

function pinSessionAction(session: AiSession) {
  openContextMenu.value = null;
  emit("togglePinSession", session);
}

function renameSessionAction(session: AiSession) {
  openContextMenu.value = null;
  renameDraft.value = session.title;
  renameDialog.value = { target: session, kind: "session" };
}

function closeRenameDialog() {
  renameDialog.value = null;
  renameDraft.value = "";
}

function confirmRenameDialog() {
  const dialog = renameDialog.value;
  if (!dialog) return;
  const trimmed = renameDraft.value.trim();
  if (!trimmed) return;
  if (dialog.kind === "session") {
    const session = dialog.target as AiSession;
    if (trimmed === session.title) {
      closeRenameDialog();
      return;
    }
    emit("renameSession", session, trimmed);
  } else {
    const project = dialog.target as WorkspaceProject;
    if (trimmed === project.name) {
      closeRenameDialog();
      return;
    }
    emit("renameProject", project, trimmed);
  }
  closeRenameDialog();
}

function onRenameKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    confirmRenameDialog();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeRenameDialog();
  }
}

const renameInput = ref<HTMLInputElement | null>(null);
watch(renameDialog, async (next) => {
  if (next) {
    await nextTick();
    renameInput.value?.focus();
    renameInput.value?.select();
  }
});

function markUnreadAction(session: AiSession) {
  openContextMenu.value = null;
  emit("markSessionUnread", session);
}

function deriveSessionAction(session: AiSession) {
  openContextMenu.value = null;
  emit("deriveSession", session);
}

function openInNewWindowAction(session: AiSession) {
  openContextMenu.value = null;
  emit("openSessionInNewWindow", session);
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
  <div v-if="renameDialog" class="rename-dialog-overlay" @click.self="closeRenameDialog">
    <div class="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title">
      <header class="rename-dialog-header">
        <h3 id="rename-dialog-title">{{ renameDialog.kind === "session" ? "重命名对话" : "重命名项目" }}</h3>
        <button class="rename-dialog-close" type="button" aria-label="关闭" @click="closeRenameDialog">×</button>
      </header>
      <p class="rename-dialog-hint">保持简短且易识别</p>
      <input
        ref="renameInput"
        v-model="renameDraft"
        class="rename-dialog-input"
        :placeholder="renameDialog.kind === 'session' ? '会话名称' : '项目名称'"
        maxlength="80"
        autofocus
        @keydown="onRenameKeydown"
      />
      <footer class="rename-dialog-footer">
        <button class="button secondary" type="button" @click="closeRenameDialog">取消</button>
        <button
          class="button primary"
          type="button"
          :disabled="!renameDraft.trim()"
          @click="confirmRenameDialog"
        >保存</button>
      </footer>
    </div>
  </div>
  <div v-if="confirmDialog" class="rename-dialog-overlay" @click.self="closeConfirmDialog">
    <div
      class="rename-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      @keydown="onConfirmKeydown"
    >
      <header class="rename-dialog-header">
        <h3 id="confirm-dialog-title">{{ confirmDialog.title }}</h3>
        <button class="rename-dialog-close" type="button" aria-label="关闭" @click="closeConfirmDialog">×</button>
      </header>
      <p class="rename-dialog-message">{{ confirmDialog.message }}</p>
      <p v-if="confirmDialog.details" class="rename-dialog-hint">{{ confirmDialog.details }}</p>
      <footer class="rename-dialog-footer">
        <button class="button secondary" type="button" @click="closeConfirmDialog">取消</button>
        <button class="button danger" type="button" autofocus @click="performConfirmAction">确定</button>
      </footer>
    </div>
  </div>
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
          <div class="tree-project-row" :class="{ active: selectedProjectPath === project.path, collapsed: isProjectCollapsedLocal(project.path) }">
            <button
              class="tree-project-title"
              :class="{ active: selectedProjectPath === project.path }"
              type="button"
              @click="toggleProjectCollapsed(project.path)"
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
                <img class="tree-project-menu-icon" :src="pinIcon" alt="" aria-hidden="true" />
                <span>置顶项目</span>
              </button>
              <button type="button" title="用系统文件管理器打开项目目录" @click="openInFileManagerAction(project)">
                <img class="tree-project-menu-icon" :src="folderOpenIcon" alt="" aria-hidden="true" />
                <span>在文件管理器中打开</span>
              </button>
              <button type="button" disabled title="稍后支持创建永久工作树">
                <img class="tree-project-menu-icon" :src="gitBranchIcon" alt="" aria-hidden="true" />
                <span>创建永久工作树</span>
              </button>
              <button type="button" title="修改项目在侧边栏显示的名称" @click="renameProjectAction(project)">
                <img class="tree-project-menu-icon" :src="editIcon" alt="" aria-hidden="true" />
                <span>重命名项目</span>
              </button>
              <button
                type="button"
                :disabled="!sessionsForProject(project.path).length"
                title="归档这个项目下的全部会话"
                @click="archiveProjectSessions(project)"
              >
                <img class="tree-project-menu-icon" :src="archiveBoxIcon" alt="" aria-hidden="true" />
                <span>归档对话</span>
              </button>
              <button type="button" title="从项目列表移除(不会删除磁盘目录)" @click="removeProjectAction(project)">
                <img class="tree-project-menu-icon" :src="trashIcon" alt="" aria-hidden="true" />
                <span>从列表移除</span>
              </button>
            </div>
          </div>
          <div v-if="!isProjectCollapsedLocal(project.path)" class="tree-chat-list">
            <template v-if="sessionsForProject(project.path).length">
              <section v-for="group in sessionGroupsForProject(project.path)" :key="group.id" class="tree-provider-group">
                <button
                  type="button"
                  class="tree-provider-group-heading"
                  :class="{ collapsed: isGroupCollapsed(project.path, group.id) }"
                  @click="toggleGroupCollapsed(project.path, group.id)"
                >
                  <img class="tree-provider-group-icon" :src="providerIcon(group.id)" alt="" aria-hidden="true" />
                  <span class="tree-provider-group-label">{{ group.label }}</span>
                </button>
                <div
                  v-for="session in visibleSessionsForGroup(project.path, group)"
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
                      <span class="tree-chat-title">
                        <i
                          v-if="isSessionPinnedLocal(session)"
                          class="tree-chat-pin"
                          :title="'已置顶'"
                          aria-hidden="true"
                        >▾</i>
                        <span>{{ session.title }}</span>
                      </span>
                      <i v-if="isThinking(session)" class="tree-chat-spinner" aria-label="思考中"></i>
                      <i
                        v-else-if="isSessionUnreadLocal(session)"
                        class="tree-chat-unread"
                        :title="'未读'"
                        aria-label="未读"
                      ></i>
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
                <button
                  v-if="hiddenSessionCountForGroup(project.path, group) > 0"
                  class="tree-chat-toggle"
                  type="button"
                  @click="toggleGroupSessionsExpanded(project.path, group.id)"
                >
                  <span>展开显示</span>
                </button>
                <button
                  v-else-if="isGroupSessionsExpanded(project.path, group.id) && group.sessions.length > COLLAPSED_SESSION_LIMIT"
                  class="tree-chat-toggle"
                  type="button"
                  @click="toggleGroupSessionsExpanded(project.path, group.id)"
                >
                  <span>收起</span>
                </button>
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
        <button type="button" @click="pinSessionAction(openContextMenu.session)">
          <img class="session-context-menu-icon" :src="pinIcon" alt="" aria-hidden="true" />
          {{ isSessionPinnedLocal(openContextMenu.session) ? "取消置顶" : "置顶对话" }}
        </button>
        <button type="button" @click="renameSessionAction(openContextMenu.session)">
          <img class="session-context-menu-icon" :src="editIcon" alt="" aria-hidden="true" />
          重命名对话
        </button>
        <button type="button" @click="archiveSession(openContextMenu.session)">
          <img class="session-context-menu-icon" :src="archiveBoxIcon" alt="" aria-hidden="true" />
          归档对话
        </button>
        <button type="button" :disabled="isSessionUnreadLocal(openContextMenu.session)" @click="markUnreadAction(openContextMenu.session)">
          <img class="session-context-menu-icon" :src="mailUnreadIcon" alt="" aria-hidden="true" />
          {{ isSessionUnreadLocal(openContextMenu.session) ? "已是未读" : "标记为未读" }}
        </button>
      </div>
      <div class="session-context-menu-section">
        <button type="button" @click="copyText(openContextMenu.session.id)">
          <img class="session-context-menu-icon" :src="fingerprintIcon" alt="" aria-hidden="true" />
          复制会话 ID
        </button>
        <button type="button" @click="copySessionDeepLink(openContextMenu.session)">
          <img class="session-context-menu-icon" :src="linkIcon" alt="" aria-hidden="true" />
          复制深度链接
        </button>
      </div>
      <div class="session-context-menu-section">
        <button type="button" @click="deriveSessionAction(openContextMenu.session)">
          <img class="session-context-menu-icon" :src="gitForkIcon" alt="" aria-hidden="true" />
          派生到本地
        </button>
        <button type="button" disabled title="稍后支持">
          <img class="session-context-menu-icon" :src="branchForkIcon" alt="" aria-hidden="true" />
          派生到新工作树
        </button>
      </div>
      <div class="session-context-menu-section">
        <button type="button" @click="openInNewWindowAction(openContextMenu.session)">
          <img class="session-context-menu-icon" :src="windowIcon" alt="" aria-hidden="true" />
          在新窗口中打开
        </button>
      </div>
    </div>
  </aside>
</template>
