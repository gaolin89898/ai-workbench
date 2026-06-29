<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { desktopApi, type AiProvider, type AiSession, type SavedCloudConfig, type TerminalSession, type ViewName, type WorkspaceFileEntry, type WorkspaceProject } from "../services/desktop";

const archiveBoxIcon = new URL("../assets/icons/archive-box.svg", import.meta.url).href;
const projectFolderIcon = new URL("../assets/icons/project-folder.svg", import.meta.url).href;
const sessionPlusIcon = new URL("../assets/icons/session-plus.svg", import.meta.url).href;
const pinIcon = new URL("../assets/icons/pin.svg", import.meta.url).href;
const folderOpenIcon = new URL("../assets/icons/folder-open.svg", import.meta.url).href;
const fileListIcon = new URL("../assets/icons/file-list.svg", import.meta.url).href;
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
const expandedProjectSessions = ref<Record<string, boolean>>({});
const renameDialog = ref<{ target: AiSession | WorkspaceProject; kind: "session" | "project" } | null>(null);
const renameDraft = ref("");
const confirmDialog = ref<{ title: string; message: string; details?: string; action: () => void } | null>(null);
const collapsedProjects = ref<Record<string, boolean>>({});
const fileListProjectPath = ref<string | null>(null);
const directoryFiles = ref<Record<string, WorkspaceFileEntry[]>>({});
const directoryLoading = ref<Record<string, boolean>>({});
const directoryErrors = ref<Record<string, string>>({});
const expandedDirectories = ref<Record<string, boolean>>({});
const accountMenuOpen = ref(false);
const cloudConfig = ref<SavedCloudConfig | null>(null);
const themeMode = ref<"light" | "dark">("light");
const menuNotice = ref("");

const accountDisplayName = computed(() => cloudConfig.value?.displayName || (cloudConfig.value?.authMode === "desktop-login" ? "桌面账号" : "配对设备"));
const accountDetail = computed(() => cloudConfig.value?.serverUrl ?? "未连接云端");
const accountInitial = computed(() => accountDisplayName.value.slice(0, 1).toUpperCase());
const syncStatusText = computed(() => cloudConfig.value?.paired ? "同步已连接" : "未连接同步");
const themeActionText = computed(() => themeMode.value === "dark" ? "切换浅色主题" : "切换深色主题");

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

function sessionsForProject(path: string) {
  return props.activeSessions.filter((session) => session.summary === path);
}

function visibleSessionsForProject(path: string) {
  const sessions = sessionsForProject(path);
  if (expandedProjectSessions.value[path]) return sessions;
  return sessions.slice(0, COLLAPSED_SESSION_LIMIT);
}

function hiddenSessionCountForProject(path: string) {
  if (expandedProjectSessions.value[path]) return 0;
  return Math.max(0, sessionsForProject(path).length - COLLAPSED_SESSION_LIMIT);
}

function isProjectSessionsExpanded(path: string) {
  return Boolean(expandedProjectSessions.value[path]);
}

function toggleProjectSessionsExpanded(path: string) {
  expandedProjectSessions.value = {
    ...expandedProjectSessions.value,
    [path]: !expandedProjectSessions.value[path],
  };
}

function isProjectFileListOpen(path: string) {
  return fileListProjectPath.value === path;
}

function normalizeFilePath(value: string) {
  return value.replaceAll("\\", "/");
}

function directoryKey(path: string) {
  return normalizeFilePath(path).toLowerCase();
}

async function loadDirectoryFiles(project: WorkspaceProject, directoryPath = project.path) {
  const key = directoryKey(directoryPath);
  directoryLoading.value = { ...directoryLoading.value, [key]: true };
  directoryErrors.value = { ...directoryErrors.value, [key]: "" };
  try {
    const files = await desktopApi.listProjectFiles(project.path, directoryPath);
    directoryFiles.value = { ...directoryFiles.value, [key]: files };
  } catch (error) {
    directoryErrors.value = { ...directoryErrors.value, [key]: String(error) };
  } finally {
    directoryLoading.value = { ...directoryLoading.value, [key]: false };
  }
}

async function toggleProjectFileList(project: WorkspaceProject) {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  if (fileListProjectPath.value === project.path) {
    fileListProjectPath.value = null;
    return;
  }
  fileListProjectPath.value = project.path;
  collapsedProjects.value = { ...collapsedProjects.value, [project.path]: false };
  expandedDirectories.value = { ...expandedDirectories.value, [directoryKey(project.path)]: true };
  if (directoryFiles.value[directoryKey(project.path)] || directoryLoading.value[directoryKey(project.path)]) return;
  await loadDirectoryFiles(project);
}

async function toggleDirectoryNode(project: WorkspaceProject, directoryPath: string) {
  const key = directoryKey(directoryPath);
  const nextExpanded = !expandedDirectories.value[key];
  expandedDirectories.value = { ...expandedDirectories.value, [key]: nextExpanded };
  if (!nextExpanded) return;
  if (directoryFiles.value[key] || directoryLoading.value[key]) return;
  await loadDirectoryFiles(project, directoryPath);
}

async function openProjectFileEntry(project: WorkspaceProject, file: WorkspaceFileEntry) {
  if (file.kind === "directory") {
    await toggleDirectoryNode(project, file.path);
    return;
  }
  await copyText(file.path);
}

type VisibleFileNode = {
  file: WorkspaceFileEntry;
  depth: number;
  status: string;
};

function filesForDirectory(path: string) {
  return directoryFiles.value[directoryKey(path)] ?? [];
}

function visibleFileTree(project: WorkspaceProject) {
  const nodes: VisibleFileNode[] = [];
  const walk = (directoryPath: string, depth: number) => {
    for (const file of filesForDirectory(directoryPath)) {
      nodes.push({ file, depth, status: file.kind === "directory" ? directoryStatus(file.path) : "" });
      if (file.kind === "directory" && isDirectoryExpanded(file.path)) {
        walk(file.path, depth + 1);
      }
    }
  };
  walk(project.path, 0);
  return nodes;
}

function isDirectoryExpanded(path: string) {
  return Boolean(expandedDirectories.value[directoryKey(path)]);
}

function directoryStatus(path: string) {
  const key = directoryKey(path);
  if (directoryLoading.value[key]) return "正在读取...";
  if (directoryErrors.value[key]) return `读取失败：${directoryErrors.value[key]}`;
  if (isDirectoryExpanded(path) && directoryFiles.value[key] && !directoryFiles.value[key].length) return "空文件夹";
  return "";
}

function fileSizeLabel(file: WorkspaceFileEntry) {
  if (file.kind === "directory") return "";
  if (file.size < 1024) return `${file.size} B`;
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${(file.size / 1024 / 1024).toFixed(1)} MB`;
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
  if (target instanceof Element && target.closest(".tree-project-row, .session-context-menu, .account-menu-wrap")) return;
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  accountMenuOpen.value = false;
}

function closeMenusOnEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  accountMenuOpen.value = false;
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
    message: `将「${project.name}」从侧边栏项目列表中移除？`,
    details: "不会删除磁盘上的目录和文件。",
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

function chooseProjectFromSidebar() {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  emit("chooseProject");
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

function applyTheme(nextTheme: "light" | "dark") {
  themeMode.value = nextTheme;
  document.documentElement.classList.toggle("theme-dark", nextTheme === "dark");
  document.body.classList.toggle("theme-dark", nextTheme === "dark");
  window.localStorage.setItem("ai-workbench-theme", nextTheme);
}

function toggleAccountMenu() {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  accountMenuOpen.value = !accountMenuOpen.value;
}

function openAccountSettings() {
  accountMenuOpen.value = false;
  emit("switchView", "settings");
}

function toggleTheme() {
  applyTheme(themeMode.value === "dark" ? "light" : "dark");
}

function showSyncStatus() {
  menuNotice.value = cloudConfig.value?.paired ? `已连接 ${cloudConfig.value.serverUrl}` : "当前未连接同步服务";
  window.setTimeout(() => {
    menuNotice.value = "";
  }, 2400);
}

function showShortcutHelp() {
  menuNotice.value = "快捷键：Enter 发送，Esc 停止/关闭菜单，右键打开会话菜单";
  window.setTimeout(() => {
    menuNotice.value = "";
  }, 3200);
}

async function logoutAccount() {
  accountMenuOpen.value = false;
  await desktopApi.logoutDesktop();
  window.dispatchEvent(new CustomEvent("desktop-logout"));
}

onMounted(async () => {
  const savedTheme = window.localStorage.getItem("ai-workbench-theme") === "dark" ? "dark" : "light";
  applyTheme(savedTheme);
  try {
    cloudConfig.value = await desktopApi.getCloudConfig();
  } catch {
    cloudConfig.value = null;
  }
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
  <div v-if="confirmDialog" class="rename-dialog-overlay confirm-dialog-overlay" @click.self="closeConfirmDialog">
    <div
      class="rename-dialog confirm-dialog"
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
        <button class="button danger" type="button" autofocus @click="performConfirmAction">移除</button>
      </footer>
    </div>
  </div>
  <aside class="sidebar">
    <section class="sidebar-section">
      <div class="sidebar-heading">
        <span>项目</span>
        <button class="icon-button" title="选择本地项目" type="button" @click.stop="chooseProjectFromSidebar">＋</button>
      </div>
      <div class="project-tree">
        <button v-if="!projects.length" class="tree-empty" type="button" @click.stop="chooseProjectFromSidebar">
          <img class="tree-empty-icon" :src="projectFolderIcon" alt="" aria-hidden="true" />
          <span>选择项目</span>
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
              <span class="tree-project-chevron">{{ isProjectCollapsedLocal(project.path) ? "▸" : "▾" }}</span>
              <img class="tree-icon" :src="projectFolderIcon" alt="" aria-hidden="true" />
              <strong>{{ project.name }}</strong>
            </button>
            <button
              class="tree-project-add"
              :class="{ active: isProjectFileListOpen(project.path) }"
              title="查看当前文件夹文件列表"
              type="button"
              @click.stop="toggleProjectFileList(project)"
            >
              <img :src="fileListIcon" alt="" aria-hidden="true" />
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
            <template v-if="isProjectFileListOpen(project.path)">
              <div v-if="directoryStatus(project.path)" class="tree-chat muted tree-chat-empty">{{ directoryStatus(project.path) }}</div>
              <template v-else>
                <div
                  v-for="node in visibleFileTree(project)"
                  :key="node.file.path"
                  class="tree-file-node"
                >
                  <button
                    class="tree-file-row"
                    type="button"
                    :class="{ directory: node.file.kind === 'directory', expanded: isDirectoryExpanded(node.file.path) }"
                    :style="{ paddingLeft: `${node.depth * 16}px` }"
                    :title="node.file.path"
                    @click.stop="openProjectFileEntry(project, node.file)"
                  >
                    <span class="tree-file-icon">{{ node.file.kind === "directory" ? (isDirectoryExpanded(node.file.path) ? "▾" : "▸") : "•" }}</span>
                    <span class="tree-file-name">{{ node.file.name }}</span>
                    <small>{{ fileSizeLabel(node.file) }}</small>
                  </button>
                  <div v-if="node.status" class="tree-file-status" :style="{ paddingLeft: `${(node.depth + 1) * 16}px` }">{{ node.status }}</div>
                </div>
              </template>
            </template>
            <template v-else-if="sessionsForProject(project.path).length">
              <div
                v-for="session in visibleSessionsForProject(project.path)"
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
                v-if="hiddenSessionCountForProject(project.path) > 0"
                class="tree-chat-toggle"
                type="button"
                @click="toggleProjectSessionsExpanded(project.path)"
              >
                <span>展开显示</span>
              </button>
              <button
                v-else-if="isProjectSessionsExpanded(project.path) && sessionsForProject(project.path).length > COLLAPSED_SESSION_LIMIT"
                class="tree-chat-toggle"
                type="button"
                @click="toggleProjectSessionsExpanded(project.path)"
              >
                <span>收起</span>
              </button>
            </template>
            <div v-else class="tree-chat muted tree-chat-empty">暂无会话</div>
          </div>
        </section>
      </div>
    </section>
    <div class="account-menu-wrap">
      <div v-if="accountMenuOpen" class="account-menu-popover" role="menu" aria-label="个人账户菜单">
        <div class="account-menu-profile">
          <span class="account-avatar">{{ accountInitial }}</span>
          <span class="account-profile-copy">
            <strong>{{ accountDisplayName }}</strong>
            <small>{{ accountDetail }}</small>
          </span>
        </div>
        <div class="account-menu-divider" aria-hidden="true"></div>
        <button type="button" role="menuitem" @click="openAccountSettings">
          <span class="account-menu-icon">⚙</span>
          <span>账号设置</span>
        </button>
        <button type="button" role="menuitem" @click="toggleTheme">
          <span class="account-menu-icon">◐</span>
          <span>{{ themeActionText }}</span>
        </button>
        <button type="button" role="menuitem" @click="showSyncStatus">
          <span class="account-menu-icon success">✓</span>
          <span>{{ syncStatusText }}</span>
        </button>
        <button type="button" role="menuitem" @click="showShortcutHelp">
          <span class="account-menu-icon">⌘</span>
          <span>快捷键</span>
        </button>
        <p v-if="menuNotice" class="account-menu-notice">{{ menuNotice }}</p>
        <div class="account-menu-divider" aria-hidden="true"></div>
        <button class="danger" type="button" role="menuitem" @click="logoutAccount">
          <span class="account-menu-icon">↪</span>
          <span>退出登录</span>
        </button>
      </div>
      <button
        class="account-profile-button"
        :class="{ active: accountMenuOpen || activeView === 'settings' }"
        type="button"
        :aria-expanded="accountMenuOpen"
        aria-label="打开个人账户菜单"
        @click="toggleAccountMenu"
      >
        <span class="account-avatar">{{ accountInitial }}</span>
        <span class="account-profile-copy">
          <strong>{{ accountDisplayName }}</strong>
          <small>{{ accountDetail }}</small>
        </span>
        <span class="account-chevron" aria-hidden="true">{{ accountMenuOpen ? "⌃" : "⌄" }}</span>
      </button>
    </div>
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
