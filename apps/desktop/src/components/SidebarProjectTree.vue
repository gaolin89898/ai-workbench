<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { desktopApi, type AiProvider, type AiSession, type ProviderStatus, type SavedCloudConfig, type TerminalSession, type ViewName, type WorkspaceFileEntry, type WorkspaceProject } from "../services/desktop";

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
const terminalIcon = new URL("../assets/icons/terminal.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerOpencodeIcon = new URL("../assets/icons/provider-opencode.svg", import.meta.url).href;
const providerDeepseekIcon = new URL("../assets/icons/provider-deepseek.svg", import.meta.url).href;
const providerMimoIcon = new URL("../assets/icons/provider-mimo.svg", import.meta.url).href;

const chevronDownSvg = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 7.5 10 12.5 15 7.5"/></svg>';
const chevronRightSvg = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5 12.5 10 7.5 15"/></svg>';
const CHAT_CONTEXT_MIME = "application/x-codehub-chat-context";

const props = defineProps<{
  projects: WorkspaceProject[];
  providers: AiProvider[];
  terminalSessions: TerminalSession[];
  activeSessions: AiSession[];
  activeAiSession: AiSession | null;
  providerStatuses: ProviderStatus[];
  appUpdateAvailableVersion?: string;
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
  newFreeChat: [];
  createSession: [path: string, providerId: string];
  attachSession: [path: string, terminalSessionId: string, providerId: string];
  selectSession: [session: AiSession];
  archiveSession: [sessionId: string, archived: boolean];
  deleteSession: [sessionId: string];
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
const confirmDialog = ref<{ title: string; message: string; details?: string; confirmLabel?: string; action: () => void } | null>(null);
const collapsedProjects = ref<Record<string, boolean>>({});
const fileListProjectPath = ref<string | null>(null);
const directoryFiles = ref<Record<string, WorkspaceFileEntry[]>>({});
const directoryLoading = ref<Record<string, boolean>>({});
const directoryErrors = ref<Record<string, string>>({});
const expandedDirectories = ref<Record<string, boolean>>({});
const accountMenuOpen = ref(false);
const cloudConfig = ref<SavedCloudConfig | null>(null);
const themeMode = ref<"light" | "dark">("light");
const sessionSearchQuery = ref("");
const sessionSearchResults = ref<AiSession[]>([]);
const isSearchingSessions = ref(false);
const searchModalOpen = ref(false);
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const loginAccountName = computed(() => {
  const raw = cloudConfig.value?.displayName?.trim() ?? "";
  if (!raw) return "";
  return raw.includes("@") ? raw.split("@")[0] : raw;
});
const accountDisplayName = computed(() => loginAccountName.value || (cloudConfig.value?.authMode === "desktop-login" ? "桌面账号" : "关联设备"));
const accountDetail = computed(() => {
  if (!cloudConfig.value?.paired) return "未登录";
  return cloudConfig.value.authMode === "desktop-login" ? "已登录" : "已关联";
});
const accountInitial = computed(() => accountDisplayName.value.slice(0, 2).toUpperCase());
const themeActionText = computed(() => themeMode.value === "dark" ? "切换浅色主题" : "切换深色主题");
const providerUpdateStatuses = computed(() => props.providerStatuses.filter((status) => status.installed && status.updateAvailable));
const providerUpdateCount = computed(() => providerUpdateStatuses.value.length);
const providerUpdateNames = computed(() => {
  return providerUpdateStatuses.value
    .map((status) => props.providers.find((provider) => provider.id === status.providerId)?.name ?? status.providerId)
    .slice(0, 2)
    .join("、");
});
const hasAppUpdate = computed(() => Boolean(props.appUpdateAvailableVersion));
const hasUpdatePrompt = computed(() => hasAppUpdate.value || providerUpdateCount.value > 0);
const activeFileListProject = computed(() => {
  const path = fileListProjectPath.value;
  return path ? props.projects.find((project) => project.path === path) ?? null : null;
});
const appUpdatePromptText = computed(() => props.appUpdateAvailableVersion ? `新版本 ${props.appUpdateAvailableVersion}` : "");
const providerUpdatePromptText = computed(() => {
  const count = providerUpdateCount.value;
  if (!count) return "";
  return `${providerUpdateNames.value}${count > 2 ? ` 等 ${count} 个` : ""} 可更新`;
});

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
const FREE_SESSION_GROUP_KEY = "__free_sessions__";

async function searchAiSessions(query: string) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    sessionSearchResults.value = [];
    return;
  }

  isSearchingSessions.value = true;
  try {
    const results = await desktopApi.ipc.searchAiSessions(trimmedQuery);
    // 输入框可能在请求期间被清空或改动，丢弃过期结果
    if (sessionSearchQuery.value.trim() !== trimmedQuery) return;
    sessionSearchResults.value = results;
  } catch (error) {
    console.error("Session search failed:", error);
    sessionSearchResults.value = [];
  } finally {
    isSearchingSessions.value = false;
  }
}

function onSessionSearchInput(event: Event) {
  const query = (event.target as HTMLInputElement).value;
  sessionSearchQuery.value = query;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  if (!query.trim()) {
    sessionSearchResults.value = [];
    isSearchingSessions.value = false;
    return;
  }
  isSearchingSessions.value = true;
  searchDebounceTimer = setTimeout(() => {
    void searchAiSessions(query);
  }, 300);
}

function clearSessionSearch() {
  sessionSearchQuery.value = "";
  sessionSearchResults.value = [];
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
}

function openSearchModal() {
  searchModalOpen.value = true;
  clearSessionSearch();
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.session-search-modal input[type="search"]');
    input?.focus();
  });
}

function closeSearchModal() {
  searchModalOpen.value = false;
  clearSessionSearch();
}

function selectSessionFromSearch(session: AiSession) {
  selectSession(session);
  closeSearchModal();
}

function sessionProjectPath(session: AiSession) {
  return session.projectPath || session.summary || "";
}

function sessionsForProject(path: string) {
  if (path === FREE_SESSION_GROUP_KEY) {
    return props.activeSessions.filter((session) => !sessionProjectPath(session));
  }
  return props.activeSessions.filter((session) => sessionProjectPath(session) === path);
}

function allSessionsForProject(path: string): AiSession[] {
  return sessionsForProject(path).sort((left, right) => {
    const runningOrder = Number(isThinking(right)) - Number(isThinking(left));
    if (runningOrder !== 0) return runningOrder;
    const rightTime = Date.parse(right.updatedAt ?? "");
    const leftTime = Date.parse(left.updatedAt ?? "");
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function visibleSessionsForProject(path: string) {
  const sessions = allSessionsForProject(path);
  if (expandedProjectSessions.value[path]) return sessions;
  return sessions.slice(0, COLLAPSED_SESSION_LIMIT);
}

function hiddenSessionCountForProject(path: string) {
  if (expandedProjectSessions.value[path]) return 0;
  return Math.max(0, allSessionsForProject(path).length - COLLAPSED_SESSION_LIMIT);
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
    if (!files.length && directoryPath !== project.path) {
      expandedDirectories.value = { ...expandedDirectories.value, [key]: false };
    }
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

function closeProjectFileList() {
  fileListProjectPath.value = null;
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
    if (isKnownEmptyDirectory(file.path)) return;
    await toggleDirectoryNode(project, file.path);
    return;
  }
  if (/\.html?$/i.test(file.path)) {
    const key = directoryKey(file.path.replace(/[\\/][^\\/]+$/, ""));
    directoryErrors.value = { ...directoryErrors.value, [key]: "" };
    try {
      await desktopApi.openProjectHtmlInBrowser(project.path, file.path);
    } catch (error) {
      directoryErrors.value = { ...directoryErrors.value, [key]: `无法打开 HTML：${String(error)}` };
    }
    return;
  }
  emit("selectProject", project.path);
  emit("switchView", "aiSessions");
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("desktop-preview-file", {
      detail: {
        projectPath: project.path,
        filePath: file.path,
      },
    }));
  }, 80);
}

function projectFileContext(project: WorkspaceProject, file: WorkspaceFileEntry) {
  return {
    kind: file.kind === "directory" ? "folder" as const : "file" as const,
    name: file.name,
    path: file.path,
    projectPath: project.path,
  };
}

function startProjectFileDrag(event: DragEvent, project: WorkspaceProject, file: WorkspaceFileEntry) {
  if (!event.dataTransfer) return;
  const context = projectFileContext(project, file);
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(CHAT_CONTEXT_MIME, JSON.stringify(context));
  event.dataTransfer.setData("text/plain", context.path);
}

function addProjectFileContext(event: KeyboardEvent, project: WorkspaceProject, file: WorkspaceFileEntry) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "l") return;
  event.preventDefault();
  event.stopPropagation();
  window.dispatchEvent(new CustomEvent("desktop-add-chat-context", {
    detail: projectFileContext(project, file),
  }));
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

function isKnownEmptyDirectory(path: string) {
  const files = directoryFiles.value[directoryKey(path)];
  return Array.isArray(files) && files.length === 0;
}

function fileTreeIcon(file: WorkspaceFileEntry) {
  if (file.kind !== "directory") return "";
  if (isKnownEmptyDirectory(file.path)) return "";
  return isDirectoryExpanded(file.path) ? chevronDownSvg : chevronRightSvg;
}

function fileEntryIconMeta(file: WorkspaceFileEntry) {
  if (file.kind === "directory") return { icon: isDirectoryExpanded(file.path) ? "folder-open" : "folder", tone: "amber" };
  const name = file.name.toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  if (name === "package.json" || name === "pnpm-workspace.yaml") return { icon: "package", tone: "redbrown" };
  if (name.includes("lock")) return { icon: "lock-keyhole", tone: "redbrown" };
  if (name.startsWith("readme") || extension === "md" || extension === "mdx") return { icon: "book-open", tone: "cyan" };
  if (name.includes("config") || name.startsWith(".") || ["toml", "ini", "env", "yml", "yaml"].includes(extension)) return { icon: "settings", tone: "slate" };
  if (extension === "vue") return { icon: "component", tone: "green" };
  if (["ts", "tsx", "mts", "cts"].includes(extension)) return { icon: "file-code-2", tone: "blue" };
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return { icon: "braces", tone: "yellow" };
  if (extension === "json") return { icon: "file-json", tone: "orange" };
  if (["css", "scss", "sass", "less", "postcss"].includes(extension)) return { icon: "palette", tone: "purple" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"].includes(extension)) return { icon: "image", tone: "pink" };
  if (["txt", "log"].includes(extension)) return { icon: "file-text", tone: "cyan" };
  if (["py", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "rb", "sh", "ps1", "sql", "dart"].includes(extension)) return { icon: "file-code", tone: "blue" };
  return { icon: "file", tone: "slate" };
}

const fileEntryIconPaths: Record<string, string> = {
  folder: '<path d="M4 3.5h4l1.5 1.5H16a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 4 3.5Z"/>',
  'folder-open': '<path d="M3.5 4.5h4l1.5 1.5h7.1a1.5 1.5 0 0 1 1.45 1.9l-1 6.5a1.5 1.5 0 0 1-1.45 1.1H4.85a1.5 1.5 0 0 1-1.45-1.1l-1-6.5a1.5 1.5 0 0 1 1.45-1.9H17"/>',
  package: '<path d="M10 2.8 16 6v8l-6 3.2L4 14V6l6-3.2Z"/><path d="M4.25 6.25 10 9.35l5.75-3.1M10 9.35v7.55"/>',
  'lock-keyhole': '<rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6.6a3 3 0 0 1 6 0v1.9M10 12.1v1.6"/>',
  'book-open': '<path d="M3 4.6h4.2A2.8 2.8 0 0 1 10 7.4v9a2.8 2.8 0 0 0-2.8-2.8H3V4.6ZM17 4.6h-4.2A2.8 2.8 0 0 0 10 7.4v9a2.8 2.8 0 0 1 2.8-2.8H17V4.6Z"/>',
  settings: '<path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/><path d="M15.2 11.2c.04-.4.04-.8 0-1.2l1.3-1-1.3-2.2-1.55.6c-.32-.24-.65-.43-1.02-.58L12.4 5.2H7.6l-.23 1.62c-.37.15-.7.34-1.02.58l-1.55-.6L3.5 9l1.3 1c-.04.4-.04.8 0 1.2l-1.3 1 1.3 2.2 1.55-.6c.32.24.65.43 1.02.58L7.6 16h4.8l.23-1.62c.37-.15.7-.34 1.02-.58l1.55.6 1.3-2.2-1.3-1Z"/>',
  component: '<path d="M7.5 2.8h5L15 7.2 10 17.2 5 7.2l2.5-4.4Z"/><path d="M5 7.2h10M7.5 2.8 10 7.2l2.5-4.4"/>',
  'file-code-2': '<path d="M5.5 3.2h5.4l3.6 3.6v10H5.5V3.2Z"/><path d="M10.7 3.3v3.7h3.6M8.6 10l-1.2 1.2 1.2 1.2M11.4 10l1.2 1.2-1.2 1.2"/>',
  braces: '<path d="M7.4 5.2c-1.2.5-1.8 1.3-1.8 2.4v1c0 .7-.35 1.15-1.1 1.4.75.25 1.1.7 1.1 1.4v1c0 1.1.6 1.9 1.8 2.4M12.6 5.2c1.2.5 1.8 1.3 1.8 2.4v1c0 .7.35 1.15 1.1 1.4-.75.25-1.1.7-1.1 1.4v1c0 1.1-.6 1.9-1.8 2.4"/>',
  'file-json': '<path d="M5.5 3.2h5.4l3.6 3.6v10H5.5V3.2Z"/><path d="M10.7 3.3v3.7h3.6M8.4 10c-.7.35-1 .9-.7 1.5.18.35.18.65 0 1-.3.6 0 1.15.7 1.5M11.6 10c.7.35 1 .9.7 1.5-.18.35-.18.65 0 1 .3.6 0 1.15-.7 1.5"/>',
  palette: '<path d="M10 3.2a6.8 6.8 0 0 0 0 13.6h1.05a1.35 1.35 0 0 0 .95-2.3 1.35 1.35 0 0 1 .95-2.3H14a3.8 3.8 0 0 0 3.8-3.8c0-2.87-3.22-5.2-7.8-5.2Z"/><path d="M7.2 9.6h.01M9 6.9h.01M12 6.9h.01M13.8 9.6h.01"/>',
  image: '<rect x="3.5" y="4.2" width="13" height="11.6" rx="1.6"/><path d="M6 13.6 8.7 11l1.9 1.9 1.5-1.5 2.9 2.9M13 7.5h.01"/>',
  'file-text': '<path d="M5.5 3.2h5.4l3.6 3.6v10H5.5V3.2Z"/><path d="M10.7 3.3v3.7h3.6M7.8 9.6h4.4M7.8 11.8h4.4M7.8 14h3"/>',
  'file-code': '<path d="M5.5 3.2h5.4l3.6 3.6v10H5.5V3.2Z"/><path d="M10.7 3.3v3.7h3.6M8.5 10l-1.2 1.2 1.2 1.2M11.5 10l1.2 1.2-1.2 1.2"/>',
  file: '<path d="M5.5 3.2h5.4l3.6 3.6v10H5.5V3.2Z"/><path d="M10.7 3.3v3.7h3.6"/>',
};

function fileEntryIconMarkup(file: WorkspaceFileEntry) {
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${fileEntryIconPaths[fileEntryIconMeta(file).icon] ?? fileEntryIconPaths.file}</svg>`;
}

function fileEntryIconTone(file: WorkspaceFileEntry) {
  return fileEntryIconMeta(file).tone;
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

function startNewFreeChat() {
  openProjectMenuPath.value = null;
  openContextMenu.value = null;
  emit("newFreeChat");
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
  if (searchModalOpen.value) closeSearchModal();
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
  const toolKey = tool.trim().toLowerCase();
  const normalized = toolKey.includes("mimo") ? "mimo" : toolKey;
  return props.providers.some((provider) => provider.id === normalized) ? normalized : (props.providers[0]?.id ?? "codex");
}

function providerIcon(providerId?: string | null) {
  const providerKey = (providerId ?? "").trim().toLowerCase();
  const normalized = providerKey.includes("mimo") ? "mimo" : providerKey;
  if (normalized === "codex") return providerCodexIcon;
  if (normalized === "claude") return providerClaudeIcon;
  if (normalized === "opencode") return providerOpencodeIcon;
  if (normalized === "deepseek") return providerDeepseekIcon;
  if (normalized === "mimo") return providerMimoIcon;
  return terminalIcon;
}

function projectSessionIcon(session: AiSession) {
  if (session.terminalSessionId) return terminalIcon;
  return providerIcon(session.providerId);
}

function projectSessionIconLabel(session: AiSession) {
  if (session.terminalSessionId) return "接管终端会话";
  return `${session.providerId} 会话`;
}

function sessionTimeLabel(session: AiSession) {
  if (!session.updatedAt) return "";
  return relativeTimeLabel(session.updatedAt);
}

function relativeTimeLabel(value: string) {
  const time = Date.parse(value);
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
  return Boolean(props.thinkingSessionIds[session.id] || session.status === "running");
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

function deleteSessionAction(session: AiSession) {
  openContextMenu.value = null;
  confirmDialog.value = {
    title: "永久删除对话",
    message: `永久删除「${session.title}」？`,
    details: session.providerId === "codex"
      ? "会同时删除 Codex 原生 Thread、本地消息和执行记录，且无法恢复。"
      : "会删除本地消息和执行记录，且无法恢复。",
    confirmLabel: "永久删除",
    action: () => emit("deleteSession", session.id),
  };
}

function openUpdateSettings() {
  accountMenuOpen.value = false;
  window.localStorage.setItem("ai-workbench.settingsPanel", "about");
  emit("switchView", "settings");
}

function toggleTheme() {
  applyTheme(themeMode.value === "dark" ? "light" : "dark");
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
        <button class="button danger" type="button" autofocus @click="performConfirmAction">{{ confirmDialog.confirmLabel || "移除" }}</button>
      </footer>
    </div>
  </div>
  <div v-if="searchModalOpen" class="session-search-overlay" @click.self="closeSearchModal">
    <div class="session-search-modal" role="dialog" aria-modal="true" aria-label="搜索会话">
      <header class="session-search-modal-header">
        <svg class="session-search-modal-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <input
          :value="sessionSearchQuery"
          type="search"
          placeholder="搜索会话标题、项目路径..."
          @input="onSessionSearchInput"
          @keydown.esc.prevent="closeSearchModal"
        />
        <button class="session-search-modal-close" type="button" aria-label="关闭" @click="closeSearchModal">×</button>
      </header>
      <div class="session-search-modal-body">
        <p v-if="!sessionSearchQuery" class="session-search-modal-hint">输入关键词搜索本机全部会话</p>
        <p v-else-if="isSearchingSessions" class="session-search-modal-hint">搜索中...</p>
        <p v-else-if="!sessionSearchResults.length" class="session-search-modal-hint">没有找到匹配的会话</p>
        <template v-else>
          <div class="session-search-modal-count">找到 {{ sessionSearchResults.length }} 个会话</div>
          <button
            v-for="session in sessionSearchResults"
            :key="session.id"
            class="session-search-result"
            :class="{ active: activeAiSession?.id === session.id }"
            type="button"
            @click="selectSessionFromSearch(session)"
          >
            <img
              class="session-search-result-icon"
              :src="projectSessionIcon(session)"
              :alt="projectSessionIconLabel(session)"
            />
            <span class="session-search-result-copy">
              <strong>{{ session.title }}</strong>
              <small>{{ sessionProjectPath(session) || "自由会话" }}</small>
            </span>
            <small v-if="sessionTimeLabel(session)" class="session-search-result-time">{{ sessionTimeLabel(session) }}</small>
          </button>
        </template>
      </div>
    </div>
  </div>
  <aside class="sidebar">
    <button
      class="tree-free-session"
      type="button"
      title="创建不依托文件夹的自由会话"
      @click.stop="startNewFreeChat"
    >
      <img class="tree-icon" :src="sessionPlusIcon" alt="" aria-hidden="true" />
      <strong>新建会话</strong>
    </button>
    <div v-if="allSessionsForProject(FREE_SESSION_GROUP_KEY).length" class="tree-chat-list tree-free-chat-list">
      <div
        v-for="session in visibleSessionsForProject(FREE_SESSION_GROUP_KEY)"
        :key="session.id"
        class="tree-chat-row"
        :class="{
          active: activeAiSession?.id === session.id,
          terminal: Boolean(session.terminalSessionId),
        }"
        @contextmenu.prevent.stop="openSessionContextMenu($event, session)"
      >
        <button
          class="tree-chat"
          :class="{
            active: activeAiSession?.id === session.id,
            terminal: Boolean(session.terminalSessionId),
          }"
          type="button"
          @click="selectSession(session)"
        >
          <span class="tree-chat-copy">
            <span class="tree-chat-title">
              <img
                class="tree-chat-provider-icon"
                :src="projectSessionIcon(session)"
                :alt="projectSessionIconLabel(session)"
                :title="projectSessionIconLabel(session)"
              />
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
        v-if="hiddenSessionCountForProject(FREE_SESSION_GROUP_KEY) > 0"
        class="tree-chat-toggle"
        type="button"
        @click="toggleProjectSessionsExpanded(FREE_SESSION_GROUP_KEY)"
      >
        <span>展开显示</span>
      </button>
      <button
        v-else-if="isProjectSessionsExpanded(FREE_SESSION_GROUP_KEY) && allSessionsForProject(FREE_SESSION_GROUP_KEY).length > COLLAPSED_SESSION_LIMIT"
        class="tree-chat-toggle"
        type="button"
        @click="toggleProjectSessionsExpanded(FREE_SESSION_GROUP_KEY)"
      >
        <span>收起</span>
      </button>
    </div>
    <section class="sidebar-section">
      <div class="sidebar-heading">
        <span>项目</span>
        <div class="sidebar-heading-actions">
          <button class="icon-button" title="搜索会话" type="button" @click.stop="openSearchModal">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
              <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
          <button class="icon-button" title="选择本地项目" type="button" @click.stop="chooseProjectFromSidebar">＋</button>
        </div>
      </div>
      <div class="project-tree" :class="{ 'project-tree-file-mode': activeFileListProject }">
        <button v-if="!activeFileListProject && !projects.length" class="tree-empty" type="button" @click.stop="chooseProjectFromSidebar">
          <img class="tree-empty-icon" :src="projectFolderIcon" alt="" aria-hidden="true" />
          <span>选择项目</span>
        </button>
        <section
          v-for="project in projects"
          :key="project.path"
          class="tree-project"
          :class="{ 'tree-project-file-active': isProjectFileListOpen(project.path) }"
        >
          <div v-if="!isProjectFileListOpen(project.path)" class="tree-project-row" :class="{ active: selectedProjectPath === project.path, collapsed: isProjectCollapsedLocal(project.path) }">
            <button
              class="tree-project-title"
              :class="{ active: selectedProjectPath === project.path }"
              type="button"
              @click="toggleProjectCollapsed(project.path)"
              @contextmenu="openProjectMenu($event, project.path)"
            >
              <span class="tree-project-chevron" v-html="isProjectCollapsedLocal(project.path) ? chevronRightSvg : chevronDownSvg"></span>
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
          <div v-if="!isProjectCollapsedLocal(project.path)" class="tree-chat-list" :class="{ 'tree-chat-list-files': isProjectFileListOpen(project.path) }">
            <template v-if="isProjectFileListOpen(project.path)">
              <div class="tree-file-header">
                <button class="tree-file-back" type="button" title="返回项目列表" @click.stop="closeProjectFileList">
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 5 7.5 10 12.5 15"/></svg>
                  <span>返回项目列表</span>
                </button>
              </div>
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
                    draggable="true"
                    :class="{ directory: node.file.kind === 'directory', expanded: isDirectoryExpanded(node.file.path), empty: node.file.kind === 'directory' && isKnownEmptyDirectory(node.file.path) }"
                    :title="`${node.file.path}\n拖到输入框，或按 Ctrl+L 添加到上下文`"
                    @click.stop="openProjectFileEntry(project, node.file)"
                    @dragstart.stop="startProjectFileDrag($event, project, node.file)"
                    @keydown="addProjectFileContext($event, project, node.file)"
                  >
                    <span class="tree-file-indent" :style="{ width: `${node.depth * 16}px` }"></span>
                    <span class="tree-file-icon" :class="{ empty: node.file.kind === 'directory' && isKnownEmptyDirectory(node.file.path) }" v-html="fileTreeIcon(node.file)"></span>
                    <span class="tree-file-type-icon" :class="fileEntryIconTone(node.file)" v-html="fileEntryIconMarkup(node.file)"></span>
                    <span class="tree-file-name">{{ node.file.name }}</span>
                    <small>{{ fileSizeLabel(node.file) }}</small>
                  </button>
                  <div v-if="node.status" class="tree-file-status" :style="{ paddingLeft: `${node.depth * 16 + 16}px` }">{{ node.status }}</div>
                </div>
              </template>
            </template>
            <template v-else-if="allSessionsForProject(project.path).length">
              <div
                v-for="session in visibleSessionsForProject(project.path)"
                :key="session.id"
                class="tree-chat-row"
                :class="{
                  active: activeAiSession?.id === session.id,
                  terminal: Boolean(session.terminalSessionId),
                }"
                @contextmenu.prevent.stop="openSessionContextMenu($event, session)"
              >
                <button
                  class="tree-chat"
                  :class="{
                    active: activeAiSession?.id === session.id,
                    terminal: Boolean(session.terminalSessionId),
                  }"
                  type="button"
                  @click="selectSession(session)"
                >
                  <span class="tree-chat-copy">
                    <span class="tree-chat-title">
                      <img
                        class="tree-chat-provider-icon"
                        :src="projectSessionIcon(session)"
                        :alt="projectSessionIconLabel(session)"
                        :title="projectSessionIconLabel(session)"
                      />
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
                v-else-if="isProjectSessionsExpanded(project.path) && allSessionsForProject(project.path).length > COLLAPSED_SESSION_LIMIT"
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
      <button
        v-if="hasUpdatePrompt"
        class="sidebar-update-prompt"
        type="button"
        title="查看更新"
        @click="openUpdateSettings"
      >
        <span class="sidebar-update-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M10 3v9" />
            <path d="M6.5 8.5 10 12l3.5-3.5" />
            <path d="M4 15.5h12" />
          </svg>
        </span>
        <span class="sidebar-update-copy">
          <strong>发现更新</strong>
          <small v-if="hasAppUpdate">软件 {{ appUpdatePromptText }}</small>
          <small v-if="providerUpdateCount > 0">{{ providerUpdatePromptText }}</small>
        </span>
      </button>
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
          <span class="account-menu-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.07a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.07A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.07V3a2 2 0 0 1 4 0v.07a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 0 1 0 4h-.07A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </span>
          <span>设置</span>
        </button>
        <button type="button" role="menuitem" @click="toggleTheme">
          <span class="account-menu-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M20 14.7A8 8 0 0 1 9.3 4a7 7 0 1 0 10.7 10.7Z" />
              <path d="M17.5 3.5v3M19 5h-3" />
            </svg>
          </span>
          <span>{{ themeActionText }}</span>
        </button>
        <div class="account-menu-divider" aria-hidden="true"></div>
        <button class="danger" type="button" role="menuitem" @click="logoutAccount">
          <span class="account-menu-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
              <path d="M13 3h5a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-5" />
            </svg>
          </span>
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
        <button class="danger" type="button" @click="deleteSessionAction(openContextMenu.session)">
          <img class="session-context-menu-icon" :src="trashIcon" alt="" aria-hidden="true" />
          永久删除
        </button>
      </div>
    </div>
  </aside>
</template>
