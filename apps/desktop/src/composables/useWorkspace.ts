import { computed, ref, watch } from "vue";
import router from "../router";
import { desktopApi, type AiChatOutputEvent, type AiProvider, type AiSession, type ChatImageAttachment, type ChatMessage, type ChatSegment, type CodexProjectSession, type DesktopPairingStatus, type ProviderStatus, type TerminalSession, type ViewName, type WorkspaceProject } from "../services/desktop";
import { decodeAssistantMessageFromStorage, encodeAssistantMessageForStorage, extractAssistantText } from "../utils/chat";

const providers = ref<AiProvider[]>([]);
const providerStatuses = ref<ProviderStatus[]>([]);
const projects = ref<WorkspaceProject[]>([]);
const aiSessions = ref<AiSession[]>([]);
const codexProjectSessions = ref<Record<string, CodexProjectSession[]>>({});
const terminalSessions = ref<TerminalSession[]>([]);
const activeAiSession = ref<AiSession | null>(null);
const showArchivedSessions = ref(false);
const selectedProjectPath = ref("");
const selectedProviderId = ref("codex");
const selectedCreationMode = ref("auto");
const selectedTerminalSessionId = ref("");
const aiSessionTitle = ref("新的 AI CLI 会话");
const createAiResult = ref("选择项目和 AI 工具后，新建一个 AI 会话。");
const createAiError = ref(false);
const projectResult = ref("请选择一个本机项目目录。");
const projectResultError = ref(false);
const pairResult = ref("登录桌面端后会自动绑定到同账号移动端。");
const pairResultError = ref(false);
const qrPairingCode = ref("");
const qrPairingPayload = ref("");
const qrPairingExpiresAt = ref("");
const qrPairingStatus = ref<"idle" | "creating" | "pending" | "approved" | "expired" | "error">("idle");
const settingsServer = ref("http://8.162.12.148:3000");
const settingsResult = ref("尚未读取配对配置");
const updateResult = ref("尚未检查更新。");
const updateResultError = ref(false);
const updateChecking = ref(false);
const updateInstalling = ref(false);
const updateCurrentVersion = ref("—");
const updateAvailableVersion = ref("");
const updateInstallable = ref(false);
const chatMessages = ref<ChatMessage[]>([
  { role: "system", text: "创建 AI 会话后，这里会变成聊天界面。" },
]);
const shellBuffers = ref<Record<string, string>>({});
const liveShellSessions = ref<Record<string, boolean>>({});
const thinkingSessionIds = ref<Record<string, boolean>>({});
const chatDebugEvents = ref<string[]>([]);
const chatRunStates = ref<Record<string, ChatRunState>>({});

const PIN_STORAGE_KEY = "ai-workbench.pinnedSessions";
const UNREAD_STORAGE_KEY = "ai-workbench.unreadSessions";

function readSessionSet(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSessionSet(key: string, value: Set<string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    /* ignore quota errors */
  }
}

const pinnedSessionIds = ref<Set<string>>(readSessionSet(PIN_STORAGE_KEY));
const unreadSessionIds = ref<Set<string>>(readSessionSet(UNREAD_STORAGE_KEY));

watch(
  pinnedSessionIds,
  (next) => writeSessionSet(PIN_STORAGE_KEY, next),
  { deep: true },
);
watch(
  unreadSessionIds,
  (next) => writeSessionSet(UNREAD_STORAGE_KEY, next),
  { deep: true },
);

const activeSessions = computed(() => {
  const list = aiSessions.value.filter((session) => !session.archivedAt);
  return list
    .map((session) => ({
      session,
      pinned: pinnedSessionIds.value.has(session.id),
    }))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      const leftTime = Date.parse(left.session.updatedAt ?? "");
      const rightTime = Date.parse(right.session.updatedAt ?? "");
      return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
    })
    .map((entry) => entry.session);
});
const archivedSessions = computed(() => aiSessions.value.filter((session) => !!session.archivedAt));
const activeChatRunState = computed(() => {
  const sessionId = activeAiSession.value?.id;
  return sessionId ? chatRunStates.value[sessionId] : undefined;
});
const activeChatIsRunning = computed(() => {
  const sessionId = activeAiSession.value?.id;
  return Boolean(activeChatRunState.value?.active || (sessionId && pendingAssistants.has(sessionId)));
});

type PendingAssistant = {
  clientId: string;
  message: ChatMessage;
  prompt: string;
  steps: Map<string, ChatSegment>;
  finalText: string;
  lastCommittedText: string;
  currentAgentMessageStepId: string | null;
  startedAt: number;
  hasBackendStatus: boolean;
  lastStatusText: string;
};

type ChatRunState = {
  active: boolean;
  phase: "idle" | "saving" | "starting" | "connected" | "running" | "done" | "error";
  title: string;
  detail: string;
  startedAt?: number;
  updatedAt: number;
};

const pendingAssistants = new Map<string, PendingAssistant>();
const assistantDrafts = new Map<string, { message: ChatMessage; savedText: string }>();
const stoppedAiSessions = new Set<string>();
let aiEventsInitialized = false;
let aiEventsInitPromise: Promise<void> | null = null;
let workspaceEventsInitialized = false;
let workspaceEventsInitPromise: Promise<void> | null = null;
let qrPairingTimer: number | null = null;
let runningElapsedTimer: number | null = null;
const supportedChatProviders = new Set(["codex", "claude"]);

function pushChatDebugEvent(message: string) {
  const time = new Date().toLocaleTimeString();
  if (chatDebugEvents.value[0]?.endsWith(message)) return;
  chatDebugEvents.value = [`${time} ${message}`, ...chatDebugEvents.value].slice(0, 80);
}

function formatElapsedMs(elapsedMs: number) {
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)} 秒`;
}

function formatCompactElapsedMs(elapsedMs: number) {
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (!totalMinutes) return `${seconds}秒`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (!hours) return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
  return seconds ? `${hours}时${minutes}分${seconds}秒` : `${hours}时${minutes}分`;
}

function elapsedStatusLabel(startedAt: number) {
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  return `正在思考 ${formatCompactElapsedMs(elapsedMs)}`;
}

function providerDisplayName(providerId?: string | null) {
  if (!providerId) return "AI";
  return providers.value.find((provider) => provider.id === providerId)?.name
    ?? ({ codex: "Codex", claude: "Claude Code", opencode: "OpenCode" } as Record<string, string>)[providerId]
    ?? "AI";
}

function providerNameForSession(sessionId?: string | null) {
  const providerId = sessionId
    ? (activeAiSession.value?.id === sessionId ? activeAiSession.value.providerId : aiSessions.value.find((session) => session.id === sessionId)?.providerId)
    : activeAiSession.value?.providerId;
  return providerDisplayName(providerId);
}

function providerRuntimeName(providerId?: string | null) {
  if (providerId === "codex") return "Codex app-server";
  return providerDisplayName(providerId);
}

function setChatRunState(sessionId: string, patch: Partial<ChatRunState>) {
  const previous = chatRunStates.value[sessionId];
  chatRunStates.value = {
    ...chatRunStates.value,
    [sessionId]: {
      active: patch.active ?? previous?.active ?? false,
      phase: patch.phase ?? previous?.phase ?? "idle",
      title: patch.title ?? previous?.title ?? "就绪",
      detail: patch.detail ?? previous?.detail ?? "",
      startedAt: patch.startedAt ?? previous?.startedAt,
      updatedAt: Date.now(),
    },
  };
}

function clearChatRunStateSoon(sessionId: string) {
  window.setTimeout(() => {
    const current = chatRunStates.value[sessionId];
    if (!current || current.active || current.phase === "running" || current.phase === "starting") return;
    const next = { ...chatRunStates.value };
    delete next[sessionId];
    chatRunStates.value = next;
  }, 5_000);
}

function ensureRunningElapsedTimer() {
  if (runningElapsedTimer !== null) return;
  runningElapsedTimer = window.setInterval(updateRunningElapsedLabels, 1000);
}

function stopRunningElapsedTimerIfIdle() {
  if (runningElapsedTimer === null || pendingAssistants.size > 0) return;
  window.clearInterval(runningElapsedTimer);
  runningElapsedTimer = null;
}

function updateRunningElapsedLabels() {
  if (!pendingAssistants.size) {
    stopRunningElapsedTimerIfIdle();
    return;
  }
  for (const [sessionId, pending] of pendingAssistants) {
    pending.steps.set("runtime-status", {
      type: "status",
      stepId: "runtime-status",
      label: elapsedStatusLabel(pending.startedAt),
    });
    syncPendingAssistantSegments(sessionId, false);
  }
}

function describeBackendStatus(text: string, providerName: string) {
  if (text.includes("启动")) return { phase: "starting" as const, title: `正在启动 ${providerName}`, detail: text };
  if (text.includes("连接")) return { phase: "connected" as const, title: `${providerName} 已连接`, detail: text };
  if (text.includes("处理") || text.includes("推理") || text.includes("生成")) return { phase: "running" as const, title: `${providerName} 正在执行`, detail: text };
  if (text.includes("完成")) return { phase: "done" as const, title: `${providerName} 已完成`, detail: text };
  return { phase: "running" as const, title: `${providerName} 正在执行`, detail: text };
}

function describeChatEventForLog(event: { aiSessionId: string; kind: string; text?: string; segment?: ChatSegment | null }, elapsedText: string) {
  const providerName = providerNameForSession(event.aiSessionId);
  const text = event.text ?? (event.segment?.type === "status" ? event.segment.label : event.segment?.type) ?? "";
  const suffix = text ? `：${text.slice(0, 80)}` : "";
  if (event.kind === "status") return `状态更新${elapsedText}${suffix}`;
  if (event.kind === "step-start") return `步骤开始${elapsedText}${suffix}`;
  if (event.kind === "step-update") return `步骤更新${elapsedText}${suffix}`;
  if (event.kind === "done") return `${providerName} 已完成${elapsedText}${suffix}`;
  if (event.kind === "error") return `${providerName} 报错${elapsedText}${suffix}`;
  return `收到事件 ${event.kind}${elapsedText}${suffix}`;
}

function chatClientId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function projectShellSessionId(projectPath: string) {
  return `project:${projectPath}`;
}

const routePaths: Record<ViewName, string> = {
  workspace: "/workspace",
  projects: "/projects",
  aiSessions: "/chat",
  providers: "/providers",
  settings: "/settings",
};

watch(providers, (next) => {
  if (!selectedProviderId.value && next.length) selectedProviderId.value = next[0].id;
});

watch(selectedProjectPath, () => {
  if (activeAiSession.value && selectedProjectPath.value && activeAiSession.value.summary !== selectedProjectPath.value) {
    activeAiSession.value = null;
    chatMessages.value = [];
    aiSessionTitle.value = "新的 AI CLI 会话";
    selectedTerminalSessionId.value = "";
  }
});

async function refreshWorkspace() {
  await initAiEventListeners();
  await initWorkspaceEventListeners();
  await Promise.all([loadCloudConfig(), loadProviders(), loadLocalWorkspace(), detectProviders(), refreshTerminalSessions(), loadAppVersion()]);
  ensureSelectedProject();
}

async function loadAppVersion() {
  try {
    updateCurrentVersion.value = await desktopApi.getAppVersion();
  } catch {
    updateCurrentVersion.value = "未知";
  }
}

async function loadCloudConfig() {
  try {
    const config = await desktopApi.getCloudConfig();
    if (!config) {
      settingsResult.value = "桌面端尚未登录。";
      return;
    }
    settingsServer.value = config.serverUrl;
    pairResult.value = `已读取保存的登录设备：${config.deviceId.slice(0, 8)}...`;
    pairResultError.value = false;
    settingsResult.value = `已连接到保存的服务器：${config.serverUrl}`;
  } catch (error) {
    settingsResult.value = `读取配对配置失败：${String(error)}`;
  }
}

async function loadProviders() {
  providers.value = await desktopApi.listAiProviders();
  if (!selectedProviderId.value && providers.value.length) selectedProviderId.value = providers.value[0].id;
}

async function loadLocalWorkspace() {
  const [storedProjects, storedSessions] = await Promise.all([
    desktopApi.listWorkspaceProjects(),
    desktopApi.listLocalAiSessions(),
  ]);
  projects.value = storedProjects;
  aiSessions.value = storedSessions;
  await refreshCodexProjectSessions(storedProjects);
  ensureSelectedProject();
}

async function refreshCodexProjectSessions(projectList = projects.value) {
  if (!projectList.length) {
    codexProjectSessions.value = {};
    return;
  }
  const entries = await Promise.all(projectList.map(async (project) => {
    try {
      return [project.path, await desktopApi.listCodexProjectSessions(project.path)] as const;
    } catch {
      return [project.path, []] as const;
    }
  }));
  codexProjectSessions.value = Object.fromEntries(entries);
}

function ensureSelectedProject() {
  if (!projects.value.length) {
    selectedProjectPath.value = "";
    return;
  }
  if (selectedProjectPath.value && projects.value.some((project) => project.path === selectedProjectPath.value)) {
    return;
  }
  const activeProjectPath = activeAiSession.value?.summary;
  if (activeProjectPath && projects.value.some((project) => project.path === activeProjectPath)) {
    selectedProjectPath.value = activeProjectPath;
    return;
  }
  selectedProjectPath.value = projects.value[0].path;
}

async function detectProviders() {
  providerStatuses.value = await desktopApi.detectAiProviders();
}

async function refreshTerminalSessions() {
  terminalSessions.value = await desktopApi.listSessions();
}

async function chooseProject() {
  projectResult.value = "正在打开文件夹选择器...";
  projectResultError.value = false;
  try {
    const project = await desktopApi.chooseWorkspaceProject();
    if (!project) {
      projectResult.value = "已取消选择。";
      return;
    }
    registerProject(project);
    projectResult.value = JSON.stringify(project, null, 2);
    switchView("aiSessions");
  } catch (error) {
    projectResult.value = `选择失败：${String(error)}`;
    projectResultError.value = true;
  }
}

async function addProject(path: string) {
  const trimmed = path.trim();
  if (!trimmed) {
    projectResult.value = "请填写项目目录。";
    projectResultError.value = true;
    return;
  }
  try {
    const project = await desktopApi.addWorkspaceProject(trimmed);
    registerProject(project);
    projectResult.value = JSON.stringify(project, null, 2);
    projectResultError.value = false;
  } catch (error) {
    projectResult.value = `添加失败：${String(error)}`;
    projectResultError.value = true;
  }
}

function registerProject(project: WorkspaceProject) {
  projects.value = [project, ...projects.value.filter((item) => item.path !== project.path)];
  selectedProjectPath.value = project.path;
}

async function renameProject(project: WorkspaceProject, name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    projectResult.value = "项目名称不能为空。";
    projectResultError.value = true;
    return;
  }
  try {
    const updated = await desktopApi.renameWorkspaceProject(project.id, trimmed);
    projects.value = projects.value.map((item) => (item.id === updated.id ? updated : item));
    projectResult.value = `已重命名：${updated.name}`;
    projectResultError.value = false;
  } catch (error) {
    projectResult.value = `重命名失败：${String(error)}`;
    projectResultError.value = true;
  }
}

async function removeProject(project: WorkspaceProject) {
  try {
    await desktopApi.removeWorkspaceProject(project.id);
    projects.value = projects.value.filter((item) => item.id !== project.id);
    if (selectedProjectPath.value === project.path) {
      selectedProjectPath.value = projects.value[0]?.path ?? "";
    }
    if (activeAiSession.value?.summary === project.path) {
      activeAiSession.value = null;
      chatMessages.value = [];
    }
    projectResult.value = `已从列表移除：${project.name}（磁盘上的目录未删除）`;
    projectResultError.value = false;
  } catch (error) {
    projectResult.value = `移出失败：${String(error)}`;
    projectResultError.value = true;
  }
}

async function openProjectInFileManager(project: WorkspaceProject) {
  try {
    await desktopApi.openProjectInFileManager(project.path);
    projectResult.value = `已在文件管理器中打开：${project.path}`;
    projectResultError.value = false;
  } catch (error) {
    projectResult.value = `打开文件管理器失败：${String(error)}`;
    projectResultError.value = true;
  }
}

function selectProjectPath(path: string) {
  selectedProjectPath.value = path;
  selectedProviderId.value = "codex";
  switchView("aiSessions");
}

function resetChatControlsForNewSession(path: string) {
  activeAiSession.value = null;
  chatMessages.value = [];
  aiSessionTitle.value = "新的 AI CLI 会话";
  selectedProjectPath.value = path;
  selectedProviderId.value = "codex";
  selectedCreationMode.value = "auto";
  selectedTerminalSessionId.value = "";
  switchView("aiSessions");
}

async function createAiSessionForProject(path: string, providerId?: string) {
  resetChatControlsForNewSession(path);
  if (providerId) selectedProviderId.value = providerId;
  await createAiSession();
}

async function attachAiSessionForProject(path: string, terminalSessionId: string, providerId: string) {
  activeAiSession.value = null;
  chatMessages.value = [];
  selectedProjectPath.value = path;
  selectedProviderId.value = providerId;
  selectedCreationMode.value = "attach";
  selectedTerminalSessionId.value = terminalSessionId;
  aiSessionTitle.value = "新的 AI CLI 会话";
  switchView("aiSessions");
  await createAiSession();
}

function prepareProjectSession(path: string, action: "create" | "attach") {
  activeAiSession.value = null;
  chatMessages.value = [];
  aiSessionTitle.value = "新的 AI CLI 会话";
  selectedProjectPath.value = path;
  selectedProviderId.value = "codex";
  selectedCreationMode.value = "auto";
  selectedTerminalSessionId.value = "";
  switchView("aiSessions");
}

async function createAiSession(): Promise<AiSession | null> {
  await initAiEventListeners();
  if (!selectedProjectPath.value) {
    createAiResult.value = "请先在左侧选择一个本地项目。";
    createAiError.value = true;
    return null;
  }
  try {
    const session = await desktopApi.createAiSession({
      providerId: selectedProviderId.value || providers.value[0]?.id || "codex",
      projectPath: selectedProjectPath.value,
      title: aiSessionTitle.value.trim() || "新的 AI CLI 会话",
      creationMode: "pty",
      terminalSessionId: null,
    });
    aiSessions.value = [session, ...aiSessions.value.filter((item) => item.id !== session.id)];
    await setActiveAiSession(session);
    warmupAiForSession(session.id);
    createAiResult.value = `已新建 AI 会话：${session.title}`;
    createAiError.value = false;
    return session;
  } catch (error) {
    createAiResult.value = `创建失败：${String(error)}`;
    createAiError.value = true;
    return null;
  }
}

async function importCodexProjectSession(session: CodexProjectSession): Promise<AiSession | null> {
  try {
    const imported = await desktopApi.importCodexProjectSession({
      projectPath: session.cwd,
      providerSessionId: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
    });
    aiSessions.value = [imported, ...aiSessions.value.filter((item) => item.id !== imported.id)].sort(sortSessionsByUpdatedAt);
    await setActiveAiSession(imported);
    await refreshCodexProjectSessions();
    return imported;
  } catch (error) {
    chatMessages.value = [{ role: "error", text: `打开 Codex 会话失败：${String(error)}` }];
    switchView("aiSessions");
    return null;
  }
}

function warmupAiForSession(sessionId: string) {
  const providerName = providerNameForSession(sessionId);
  pushChatDebugEvent(`warmup ${providerName}: ${sessionId.slice(0, 8)}`);
  void desktopApi.warmupAiSession(sessionId).then((session) => {
    pushChatDebugEvent(`warmup resolved: ${session.providerSessionId ? "ready" : "no thread"}`);
    aiSessions.value = [session, ...aiSessions.value.filter((item) => item.id !== session.id)].sort(sortSessionsByUpdatedAt);
    if (activeAiSession.value?.id === session.id) {
      activeAiSession.value = session;
    }
  }).catch((error) => {
    pushChatDebugEvent(`warmup failed: ${String(error)}`);
  });
}

async function startShellForActiveSession(forceRestart = false) {
  await initAiEventListeners();
  const session = activeAiSession.value;
  const sessionId = session?.id;
  const cwd = session?.summary || selectedProjectPath.value;
  if (!sessionId || !cwd) return;
  if (liveShellSessions.value[sessionId] && !forceRestart) return;
  try {
    if (forceRestart) {
      shellBuffers.value = { ...shellBuffers.value, [sessionId]: "" };
      liveShellSessions.value = { ...liveShellSessions.value, [sessionId]: false };
    }
    await desktopApi.startShellPty({ aiSessionId: sessionId, cwd });
    liveShellSessions.value = { ...liveShellSessions.value, [sessionId]: true };
  } catch (error) {
    liveShellSessions.value = { ...liveShellSessions.value, [sessionId]: false };
    shellBuffers.value = {
      ...shellBuffers.value,
      [sessionId]: `启动 shell 失败：${String(error)}\r\n`,
    };
  }
}

async function restartShellForActiveSession() {
  await startShellForActiveSession(true);
}

async function startShellForProject(projectPath: string, forceRestart = false) {
  await initAiEventListeners();
  const cwd = projectPath.trim();
  if (!cwd) return "";
  const sessionId = projectShellSessionId(cwd);
  if (liveShellSessions.value[sessionId] && !forceRestart) return sessionId;
  try {
    if (forceRestart) {
      shellBuffers.value = { ...shellBuffers.value, [sessionId]: "" };
      liveShellSessions.value = { ...liveShellSessions.value, [sessionId]: false };
    }
    await desktopApi.startShellPty({ aiSessionId: sessionId, cwd });
    liveShellSessions.value = { ...liveShellSessions.value, [sessionId]: true };
  } catch (error) {
    liveShellSessions.value = { ...liveShellSessions.value, [sessionId]: false };
    shellBuffers.value = {
      ...shellBuffers.value,
      [sessionId]: `启动 shell 失败：${String(error)}\r\n`,
    };
  }
  return sessionId;
}

async function restartShellForProject(projectPath: string) {
  await startShellForProject(projectPath, true);
}

async function setActiveAiSession(session: AiSession) {
  await initAiEventListeners();
  if (activeAiSession.value?.id) await saveAssistantDraft(activeAiSession.value.id);
  activeAiSession.value = session;
  markSessionRead(session.id);
  syncChatControlsWithSession(session);
  switchView("aiSessions");
  chatMessages.value = [];
  void refreshShellLiveState(session.id);
  await loadAiSessionHistory(session.id);
}

function syncChatControlsWithSession(session: AiSession) {
  aiSessionTitle.value = session.title;
  selectedProviderId.value = session.providerId;
  selectedTerminalSessionId.value = session.terminalSessionId ?? "";
  selectedCreationMode.value = session.terminalSessionId ? "attach" : "auto";
  if (session.summary) selectedProjectPath.value = session.summary;
}

function selectAiSessionFromDropdown(sessionId: string) {
  if (!sessionId) {
    resetChatControlsForNewSession(selectedProjectPath.value);
    return;
  }
  const session = aiSessions.value.find((item) => item.id === sessionId);
  if (session) void setActiveAiSession(session);
}

async function loadAiSessionHistorySnapshot(sessionId: string) {
  const history = await desktopApi.listLocalAiHistory(sessionId);
  return history.map((message) => {
    if (message.role !== "assistant") {
      const decoded = decodeAssistantMessageFromStorage(message.content);
      return { role: message.role, text: decoded.text, images: decoded.images };
    }
    const decoded = decodeAssistantMessageFromStorage(message.content);
    return {
      role: message.role,
      text: decoded.text,
      segments: decoded.segments,
    };
  });
}

async function loadAiSessionHistory(sessionId: string, options: { force?: boolean } = {}) {
  try {
    if (!options.force && pendingAssistants.has(sessionId)) return;
    const history = await loadAiSessionHistorySnapshot(sessionId);
    if (activeAiSession.value?.id !== sessionId || (!options.force && pendingAssistants.has(sessionId))) return;
    chatMessages.value = history;
  } catch (error) {
    if (options.force || !pendingAssistants.has(sessionId)) chatMessages.value = [{ role: "error", text: `读取历史失败：${String(error)}` }];
  }
}

function isCodexExternalMirrorSession(session: AiSession | null) {
  if (!session || session.providerId !== "codex" || !session.providerSessionId || !session.summary) return false;
  return !session.providerSessionId.startsWith("app-server:");
}

async function sendPrompt(prompt: string, images: ChatImageAttachment[] = []) {
  pushChatDebugEvent("收到发送请求");
  await initAiEventListeners();
  const trimmed = prompt.trim();
  const plainImages = images.map((image) => ({
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    dataUrl: image.dataUrl,
  }));
  if (!trimmed && !plainImages.length) return;
  if (!activeAiSession.value) {
    chatMessages.value = [{ role: "error", text: "请先点击左侧项目下的新建按钮，创建一个 AI 会话。" }];
    return;
  }
  if (activeAiSession.value.archivedAt) {
    chatMessages.value.push({ role: "error", text: "这个会话已归档。请先在“已归档”列表中恢复，再继续发送消息。" });
    return;
  }
  const sessionId = activeAiSession.value.id;
  const providerId = activeAiSession.value.providerId;
  const providerName = providerDisplayName(providerId);
  const runtimeName = providerRuntimeName(providerId);
  const projectPath = activeAiSession.value.summary || selectedProjectPath.value;
  if (!supportedChatProviders.has(providerId)) {
    chatMessages.value.push({
      role: "error",
      segments: [{
        type: "error",
        title: `${providerName} 暂不支持聊天`,
        message: "Codex / Claude Code 支持结构化聊天。OpenCode 可以先在终端页直接运行对应 CLI。",
      }],
      text: `${providerName} 暂不支持结构化聊天。可以在终端页直接运行对应 CLI。`,
    });
    return;
  }
  if (!projectPath) {
    chatMessages.value.push({ role: "error", text: `当前 ${providerName} 会话没有项目路径，请先在左侧选择项目。` });
    return;
  }
  if (pendingAssistants.has(sessionId)) {
    chatMessages.value.push({ role: "error", text: "上一条消息还在处理，请等它完成后再发送。" });
    return;
  }
  await saveAssistantDraft(sessionId);
  const promptForSession = trimmed || `查看这 ${plainImages.length} 张图片`;
  const displayText = trimmed;
  renameUntitledSession(sessionId, promptForSession);
  chatMessages.value.push({ clientId: chatClientId("user"), role: "user", text: displayText, images: plainImages });
  const assistantClientId = chatClientId("assistant");
  const assistantMessage: ChatMessage = {
    clientId: assistantClientId,
    role: "assistant",
    pending: true,
    segments: [{
      type: "status",
      stepId: "initial-thinking",
      label: `等待 ${providerName} 返回...`,
      icon: "think",
    }],
  };
  chatMessages.value.push(assistantMessage);
  pendingAssistants.set(sessionId, {
    clientId: assistantClientId,
    message: assistantMessage,
    prompt: promptForSession,
    steps: new Map([["initial-thinking", assistantMessage.segments![0]]]),
    finalText: "",
    lastCommittedText: "",
    currentAgentMessageStepId: null,
    startedAt: performance.now(),
    hasBackendStatus: false,
    lastStatusText: "",
  });
  ensureRunningElapsedTimer();
  setChatRunState(sessionId, {
    active: true,
    phase: "saving",
    title: `正在发送给 ${providerName}`,
    detail: `正在保存用户消息，随后连接 ${runtimeName}。`,
    startedAt: performance.now(),
  });
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: true };
  assistantDrafts.set(sessionId, { message: assistantMessage, savedText: "" });
  try {
    await desktopApi.appendLocalAiMessage(sessionId, "user", encodeAssistantMessageForStorage({
      text: displayText,
      images: plainImages,
    }));
    setChatRunState(sessionId, {
      active: true,
      phase: "starting",
      title: `正在启动 ${providerName}`,
      detail: `消息已保存，正在把任务交给 ${runtimeName}。`,
    });
    pushChatDebugEvent(`用户消息已保存：${sessionId.slice(0, 8)}`);
    pushChatDebugEvent(`已连接 ${runtimeName}`);
    const runChat = providerId === "codex" ? desktopApi.runCodexChat : desktopApi.runAiChat;
    void runChat({
      aiSessionId: sessionId,
      projectPath,
      prompt: promptForSession,
      images: plainImages,
    }).then((providerSessionId) => {
      const pending = pendingAssistants.get(sessionId);
      const startedAt = pending?.startedAt ?? chatRunStates.value[sessionId]?.startedAt ?? performance.now();
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (!pending) {
        pushChatDebugEvent(`${providerName} 进程已退出：providerSessionId ${providerSessionId ? "已更新" : "为空"}`);
        setChatRunState(sessionId, {
          active: false,
          phase: "done",
          title: `${providerName} 已完成`,
          detail: `执行已结束，用时 ${formatElapsedMs(elapsedMs)}。正在等待下一条消息。`,
        });
        return;
      }
      pushChatDebugEvent(`${providerName} 进程已退出：用时 ${formatElapsedMs(elapsedMs)}`);
      replacePendingAssistantText(sessionId, pending.finalText, true);
      completePendingAssistantFromExec(sessionId);
      window.setTimeout(() => {
        void loadAiSessionHistory(sessionId, { force: true });
      }, 600);
      setChatRunState(sessionId, {
        active: false,
        phase: "done",
        title: `${providerName} 已完成`,
        detail: `执行已结束，用时 ${formatElapsedMs(elapsedMs)}。正在等待下一条消息。`,
      });
    }).catch((error) => {
      if (stoppedAiSessions.delete(sessionId)) {
        pushChatDebugEvent(`${providerName} 执行已中断`);
        return;
      }
      pushChatDebugEvent(`${providerName} 执行失败：${String(error)}`);
      const pending = pendingAssistants.get(sessionId);
      if (!pending) return;
      patchPendingAssistant(sessionId, {
        pending: false,
        role: "error",
        segments: [{ type: "error", title: "发送失败", message: String(error) }],
        text: `发送失败：${String(error)}`,
      });
      pendingAssistants.delete(sessionId);
      assistantDrafts.delete(sessionId);
      stopRunningElapsedTimerIfIdle();
      thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
      setChatRunState(sessionId, {
        active: false,
        phase: "error",
        title: `${providerName} 执行失败`,
        detail: String(error),
      });
    });
  } catch (error) {
    pushChatDebugEvent(`发送前失败：${String(error)}`);
    patchPendingAssistant(sessionId, {
      pending: false,
      role: "error",
      segments: [{ type: "error", title: "发送失败", message: String(error) }],
      text: `发送失败：${String(error)}`,
    });
    pendingAssistants.delete(sessionId);
    assistantDrafts.delete(sessionId);
    stopRunningElapsedTimerIfIdle();
    thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
    setChatRunState(sessionId, {
      active: false,
      phase: "error",
      title: "发送失败",
      detail: String(error),
    });
  }
}

function activateIncomingAiSession(sessionId: string) {
  if (activeAiSession.value?.id === sessionId) return true;
  const session = aiSessions.value.find((item) => item.id === sessionId);
  if (!session) return false;
  pushChatDebugEvent(`移动端发起执行，桌面端切换到会话：${sessionId.slice(0, 8)}`);
  if (activeAiSession.value?.id) void saveAssistantDraft(activeAiSession.value.id);
  activeAiSession.value = session;
  markSessionRead(session.id);
  syncChatControlsWithSession(session);
  switchView("aiSessions");
  chatMessages.value = [];
  void refreshShellLiveState(session.id);
  return true;
}

async function ensureIncomingPendingAssistantAfterRefresh(sessionId: string) {
  if (pendingAssistants.has(sessionId)) return pendingAssistants.get(sessionId) ?? null;
  await loadLocalWorkspace();
  const history = await loadAiSessionHistorySnapshot(sessionId).catch(() => []);
  return ensureIncomingPendingAssistant(sessionId, history);
}

function ensureIncomingPendingAssistant(sessionId: string, history: ChatMessage[] = []) {
  const existing = pendingAssistants.get(sessionId);
  if (existing) return existing;
  if (!activateIncomingAiSession(sessionId)) return null;
  const providerName = providerNameForSession(sessionId);
  if (history.length) chatMessages.value = history;
  const assistantClientId = chatClientId("assistant");
  const assistantMessage: ChatMessage = {
    clientId: assistantClientId,
    role: "assistant",
    pending: true,
    segments: [{
      type: "status",
      stepId: "initial-thinking",
      label: `等待 ${providerName} 返回...`,
      icon: "think",
    }],
  };
  chatMessages.value.push(assistantMessage);
  const pending: PendingAssistant = {
    clientId: assistantClientId,
    message: assistantMessage,
    prompt: "",
    steps: new Map([["initial-thinking", assistantMessage.segments![0]]]),
    finalText: "",
    lastCommittedText: "",
    currentAgentMessageStepId: null,
    startedAt: performance.now(),
    hasBackendStatus: false,
    lastStatusText: "",
  };
  pendingAssistants.set(sessionId, pending);
  assistantDrafts.set(sessionId, { message: assistantMessage, savedText: "" });
  ensureRunningElapsedTimer();
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: true };
  return pending;
}

function updatePendingAssistantStatus(sessionId: string, text: string) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  if (shouldHideBackendStatus(text)) return;
  if (pending.lastStatusText === text) return;
  pending.lastStatusText = text;
  pending.hasBackendStatus = true;
  const providerName = providerNameForSession(sessionId);
  const described = describeBackendStatus(text, providerName);
  setChatRunState(sessionId, {
    active: described.phase !== "done",
    phase: described.phase,
    title: described.title,
    detail: described.detail,
  });
  if (text.includes("会话已连接")) {
    pending.steps.delete("conversation-guided");
  } else if (!pending.steps.has("runtime-status")) {
    pending.steps.set("runtime-status", {
      type: "status",
      stepId: "runtime-status",
      label: elapsedStatusLabel(pending.startedAt),
    });
  }
  syncPendingAssistantSegments(sessionId, pending.message.pending === false);
}

function replacePendingAssistantText(sessionId: string, text: string, done = false) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  pending.finalText = extractAssistantText(text);
  syncPendingAssistantSegments(sessionId, done);
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: !done };
}

function commitCurrentAssistantTextAsThought(pending: PendingAssistant) {
  const currentStepId = pending.currentAgentMessageStepId;
  const previousFinalText = extractAssistantText(pending.finalText.trim());
  if (!currentStepId || !previousFinalText || previousFinalText === pending.lastCommittedText) return;
  const thoughtStepId = `process-text-${currentStepId}`;
  pending.steps.set(thoughtStepId, {
    type: "text",
    stepId: thoughtStepId,
    text: previousFinalText,
  });
  pending.lastCommittedText = previousFinalText;
}

function appendPendingAssistantText(sessionId: string, text: string, stepId?: string | null) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending || !text) return;
  if (stepId && stepId !== pending.currentAgentMessageStepId) {
    commitCurrentAssistantTextAsThought(pending);
    pending.finalText = text;
    pending.currentAgentMessageStepId = stepId;
  } else {
    pending.finalText = extractAssistantText(`${pending.finalText}${text}`);
  }
  syncPendingAssistantSegments(sessionId, false);
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: true };
}

function completePendingAssistantFromExec(sessionId: string) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  const text = extractAssistantText((pending.finalText || pending.message.text || "").trim());
  pending.finalText = text;
  upsertCompletionSummary(sessionId);
  syncPendingAssistantSegments(sessionId, true);
  const finalText = extractAssistantText(pending.finalText.trim());
  const finalSegments = pending.message.segments;
  const draft = assistantDrafts.get(sessionId);
  if (draft && finalText && finalText !== draft.savedText) {
    assistantDrafts.set(sessionId, { ...draft, savedText: finalText });
    void desktopApi.appendLocalAiMessage(sessionId, "assistant", encodeAssistantMessageForStorage({
      text: finalText,
      segments: finalSegments,
    })).catch((error) => {
      pushChatDebugEvent(`保存回答失败：${String(error)}`);
    });
  }
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
  pendingAssistants.delete(sessionId);
  assistantDrafts.delete(sessionId);
  stopRunningElapsedTimerIfIdle();
}

async function stopActiveAiChat() {
  const sessionId = activeAiSession.value?.id;
  if (!sessionId) return;
  const pending = pendingAssistants.get(sessionId);
  if (!activeChatIsRunning.value && !pending) return;
  stoppedAiSessions.add(sessionId);
  pushChatDebugEvent(`用户中断执行：${sessionId.slice(0, 8)}`);
  try {
    await desktopApi.stopAiChat(sessionId);
  } catch (error) {
    pushChatDebugEvent(`中断请求失败：${String(error)}`);
  }
  if (pending) {
    if (pending.finalText.trim()) {
      replacePendingAssistantText(sessionId, pending.finalText, true);
      completePendingAssistantFromExec(sessionId);
    } else {
      patchPendingAssistant(sessionId, {
        pending: false,
        role: "assistant",
        text: "",
        segments: [{
          type: "status",
          stepId: "interrupted",
          label: "已中断",
          icon: "warn",
        }],
      });
      pendingAssistants.delete(sessionId);
      assistantDrafts.delete(sessionId);
      stopRunningElapsedTimerIfIdle();
    }
  }
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
  setChatRunState(sessionId, {
    active: false,
    phase: "done",
    title: "已中断",
    detail: "本次执行已停止，可以继续发送新消息。",
  });
}

function upsertPendingSegment(sessionId: string, segment: ChatSegment) {
  const pending = pendingAssistants.get(sessionId);
  const stepId = segment.stepId;
  if (!pending || !stepId) return;
  if (segment.type === "status") {
    if (shouldHideBackendStatus(segment.label)) return;
    pending.lastStatusText = segment.label;
    pending.hasBackendStatus = true;
    const providerName = providerNameForSession(sessionId);
    const described = describeBackendStatus(segment.label, providerName);
    setChatRunState(sessionId, {
      active: described.phase !== "done",
      phase: described.phase,
      title: described.title,
      detail: segment.detail ?? described.detail,
    });
    if (segment.label.includes("会话已连接")) {
      pending.steps.delete("conversation-guided");
    } else {
      pending.steps.set(stepId, { ...(pending.steps.get(stepId) ?? {}), ...segment } as ChatSegment);
    }
    if (!pending.steps.has("runtime-status")) {
      pending.steps.set("runtime-status", {
        type: "status",
        stepId: "runtime-status",
        label: elapsedStatusLabel(pending.startedAt),
      });
    }
    syncPendingAssistantSegments(sessionId, pending.message.pending === false);
    return;
  }
  if (segment.type === "tool") {
    commitCurrentAssistantTextAsThought(pending);
  }
  pending.steps.set(stepId, { ...(pending.steps.get(stepId) ?? {}), ...segment } as ChatSegment);
  syncPendingAssistantSegments(sessionId, pending.message.pending === false);
}

function syncPendingAssistantSegments(sessionId: string, done = false) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  const segments = [...pending.steps.values()].filter((segment) => (
    !done || segment.type !== "status" || isPersistentStatusSegment(segment)
  )).map((segment) => finalizeSegmentForDone(segment, done));
  patchPendingAssistant(sessionId, {
    pending: !done,
    role: "assistant",
    text: pending.finalText,
    segments,
  });
}

function finalizeSegmentForDone(segment: ChatSegment, done: boolean): ChatSegment {
  if (!done || segment.type !== "tool" || segment.status !== "running") return segment;
  return { ...segment, status: "success" };
}

function upsertCompletionSummary(sessionId: string) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  const elapsedMs = Math.max(0, Math.round(performance.now() - pending.startedAt));
  pending.steps.delete("runtime-status");
  pending.steps.delete("initial-thinking");
  pending.steps.set("final-summary", {
    type: "status",
    stepId: "final-summary",
    label: `已处理 ${formatCompactElapsedMs(elapsedMs)}`,
    durationMs: elapsedMs,
  });
}

function isPersistentStatusSegment(segment: ChatSegment) {
  return segment.type === "status" && (
    segment.stepId === "final-summary"
  );
}

function shouldHideBackendStatus(text: string) {
  return text.includes("已生成一段回复") || text.includes("继续等待最终完成信号") || text === "mobile sent message";
}

function patchPendingAssistant(sessionId: string, patch: Partial<ChatMessage>) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return null;
  const currentMessage = pending.message;
  const nextMessage = { ...currentMessage, ...patch };
  pending.message = nextMessage;
  let replaced = false;
  chatMessages.value = chatMessages.value.map((message) => (
    message.clientId === pending.clientId || message === currentMessage
      ? (replaced = true, nextMessage)
      : message
  ));
  if (!replaced) {
    chatMessages.value = [...chatMessages.value, nextMessage];
  }
  const draft = assistantDrafts.get(sessionId);
  if (draft) assistantDrafts.set(sessionId, { message: nextMessage, savedText: draft.savedText });
  return nextMessage;
}

async function sendShellInput(text: string) {
  const sessionId = activeAiSession.value?.id;
  if (!sessionId || !text) return;
  if (liveShellSessions.value[sessionId] === false) return;
  await desktopApi.sendShellInput({ aiSessionId: sessionId, text, submit: false });
}

async function sendProjectShellInput(projectPath: string, text: string) {
  const sessionId = projectPath ? projectShellSessionId(projectPath) : "";
  if (!sessionId || !text) return;
  if (!liveShellSessions.value[sessionId]) await startShellForProject(projectPath);
  if (liveShellSessions.value[sessionId] === false) return;
  await desktopApi.sendShellInput({ aiSessionId: sessionId, text, submit: false });
}

async function resizeShell(cols: number, rows: number) {
  const sessionId = activeAiSession.value?.id;
  if (!sessionId) return;
  if (liveShellSessions.value[sessionId] === false) return;
  await desktopApi.resizeShell({ aiSessionId: sessionId, cols, rows });
}

async function resizeProjectShell(projectPath: string, cols: number, rows: number) {
  const sessionId = projectPath ? projectShellSessionId(projectPath) : "";
  if (!sessionId) return;
  if (liveShellSessions.value[sessionId] === false) return;
  await desktopApi.resizeShell({ aiSessionId: sessionId, cols, rows });
}

async function initAiEventListeners() {
  if (aiEventsInitialized) return;
  if (aiEventsInitPromise) return aiEventsInitPromise;
  aiEventsInitPromise = Promise.all([
    desktopApi.onShellTerminalOutput((event) => {
    const previous = shellBuffers.value[event.aiSessionId] ?? "";
    shellBuffers.value = { ...shellBuffers.value, [event.aiSessionId]: previous + event.chunk };
    }),
    desktopApi.onShellSessionStatus((event) => {
    liveShellSessions.value = {
      ...liveShellSessions.value,
      [event.aiSessionId]: event.status === "running",
    };
    }),
    desktopApi.onAiChatOutput((event) => {
      void handleAiChatOutputEvent(event);
    }),
  ]).then(() => {
    aiEventsInitialized = true;
  });
  return aiEventsInitPromise;
}

async function handleAiChatOutputEvent(event: AiChatOutputEvent) {
  let pending = pendingAssistants.get(event.aiSessionId);
  if (!pending && event.kind !== "done" && event.kind !== "error") {
    const created = shouldHideBackendStatus(event.text ?? "")
      ? await ensureIncomingPendingAssistantAfterRefresh(event.aiSessionId)
      : ensureIncomingPendingAssistant(event.aiSessionId) ?? await ensureIncomingPendingAssistantAfterRefresh(event.aiSessionId);
    pending = created ?? undefined;
  }
  const providerName = providerNameForSession(event.aiSessionId);
  const runtimeName = providerRuntimeName(activeAiSession.value?.id === event.aiSessionId ? activeAiSession.value.providerId : aiSessions.value.find((session) => session.id === event.aiSessionId)?.providerId);
  const elapsedMs = pending ? Math.round(performance.now() - pending.startedAt) : undefined;
  const elapsedText = elapsedMs === undefined ? "" : `，用时 ${formatElapsedMs(elapsedMs)}`;
  pushChatDebugEvent(describeChatEventForLog(event, elapsedText));
  if (event.kind === "status") {
    if (event.segment) {
      upsertPendingSegment(event.aiSessionId, event.segment);
    } else {
      updatePendingAssistantStatus(event.aiSessionId, event.text ?? "");
    }
    return;
  }
  if (event.kind === "step-start" || event.kind === "step-update") {
    if (event.segment) upsertPendingSegment(event.aiSessionId, event.segment);
    return;
  }
  if (event.kind === "delta") {
    const pending = pendingAssistants.get(event.aiSessionId);
    if (!pending) return;
    appendPendingAssistantText(event.aiSessionId, event.text ?? "", event.stepId);
    setChatRunState(event.aiSessionId, {
      active: true,
      phase: "running",
      title: `${providerName} 正在回复`,
      detail: `正在流式接收回复${elapsedText}。`,
    });
    return;
  }
  if (event.kind === "done") {
        if (!pending) {
          if (activeAiSession.value?.id === event.aiSessionId) {
            void loadAiSessionHistory(event.aiSessionId);
          }
          void loadLocalWorkspace();
          return;
        }
        const doneElapsedMs = pending ? Math.round(performance.now() - pending.startedAt) : undefined;
        if (event.text) {
          replacePendingAssistantText(event.aiSessionId, event.text, true);
        } else {
          replacePendingAssistantText(event.aiSessionId, pending.finalText, true);
        }
        completePendingAssistantFromExec(event.aiSessionId);
        window.setTimeout(() => {
          void loadAiSessionHistory(event.aiSessionId, { force: true });
        }, 600);
        setChatRunState(event.aiSessionId, {
          active: false,
          phase: "done",
          title: `${providerName} 已完成`,
          detail: `回复已写入聊天窗口${doneElapsedMs === undefined ? "" : `，用时 ${formatElapsedMs(doneElapsedMs)}`}。正在等待下一条消息。`,
        });
        return;
      }
      if (event.kind === "error") {
        const pending = pendingAssistants.get(event.aiSessionId);
        if (!pending) {
          if (activeAiSession.value?.id === event.aiSessionId) {
            void loadAiSessionHistory(event.aiSessionId);
          }
          void loadLocalWorkspace();
          return;
        }
        if (pending.finalText.trim()) {
          upsertPendingSegment(event.aiSessionId, event.segment ?? {
            type: "status",
            stepId: "provider-warning",
            label: event.text ?? `${runtimeName} 返回了一个后续错误，已保留当前回复。`,
            icon: "warn",
          });
          replacePendingAssistantText(event.aiSessionId, pending.finalText, true);
          completePendingAssistantFromExec(event.aiSessionId);
          setChatRunState(event.aiSessionId, {
            active: false,
            phase: "done",
            title: `${providerName} 已返回部分结果`,
            detail: event.text ?? `${runtimeName} 返回了一个后续错误，已保留当前回复。`,
          });
          return;
        }
        patchPendingAssistant(event.aiSessionId, {
          pending: false,
          role: "error",
          segments: [event.segment ?? { type: "error", title: `${providerName} 执行失败`, message: event.text ?? `${providerName} 执行失败` }],
          text: event.text ?? `${providerName} 执行失败`,
        });
        pendingAssistants.delete(event.aiSessionId);
        assistantDrafts.delete(event.aiSessionId);
        stopRunningElapsedTimerIfIdle();
        thinkingSessionIds.value = { ...thinkingSessionIds.value, [event.aiSessionId]: false };
        setChatRunState(event.aiSessionId, {
          active: false,
          phase: "error",
          title: `${providerName} 执行失败`,
          detail: event.text ?? `${providerName} 执行失败`,
        });
      }
}

async function initWorkspaceEventListeners() {
  if (workspaceEventsInitialized) return;
  if (workspaceEventsInitPromise) return workspaceEventsInitPromise;
  workspaceEventsInitPromise = desktopApi.onWorkspaceChanged(() => {
    const activeSessionId = activeAiSession.value?.id;
    void loadLocalWorkspace();
    if (activeSessionId && !isCodexExternalMirrorSession(activeAiSession.value) && !pendingAssistants.has(activeSessionId)) {
      void loadAiSessionHistory(activeSessionId);
    }
  }).then(async () => {
    await desktopApi.onAiHistoryChanged((event) => {
      void loadLocalWorkspace();
      if (
        activeAiSession.value?.id === event.aiSessionId
        && !isCodexExternalMirrorSession(activeAiSession.value)
        && !pendingAssistants.has(event.aiSessionId)
      ) {
        void loadAiSessionHistory(event.aiSessionId);
      }
    });
    workspaceEventsInitialized = true;
  });
  return workspaceEventsInitPromise;
}

async function refreshShellLiveState(sessionId: string) {
  try {
    const live = await desktopApi.isShellLive(sessionId);
    liveShellSessions.value = { ...liveShellSessions.value, [sessionId]: live };
    return live;
  } catch {
    liveShellSessions.value = { ...liveShellSessions.value, [sessionId]: false };
    return false;
  }
}

function refreshChatMessages() {
  chatMessages.value = [...chatMessages.value];
}

async function saveAssistantDraft(sessionId: string) {
  const draft = assistantDrafts.get(sessionId);
  const text = extractAssistantText(draft?.message.text?.trim() ?? "");
  if (!draft || !text || text === draft.savedText) return;
  await desktopApi.appendLocalAiMessage(sessionId, "assistant", encodeAssistantMessageForStorage({
    text,
    segments: draft.message.segments,
  }));
  assistantDrafts.set(sessionId, { ...draft, savedText: text });
}

async function renameUntitledSession(sessionId: string, prompt: string) {
  const title = sessionTitleFromPrompt(prompt);
  const untitledNames = new Set(["新的 AI CLI 会话", "接管已有 AI CLI 会话"]);
  const current = aiSessions.value.find((s) => s.id === sessionId);
  const shouldRename = !!current && untitledNames.has(current.title);
  if (!shouldRename) return;
  const updatedAt = new Date().toISOString();
  aiSessions.value = aiSessions.value.map((session) =>
    session.id === sessionId ? { ...session, title, updatedAt } : session
  ).sort(sortSessionsByUpdatedAt);
  if (activeAiSession.value?.id === sessionId) {
    activeAiSession.value = { ...activeAiSession.value, title, updatedAt };
    aiSessionTitle.value = title;
  }
  // Persist locally (SQLite) and to the backend (PostgreSQL). The backend will
  // also forward ai.session.rename to other clients over WS.
  try {
    await desktopApi.renameAiSession(sessionId, title);
  } catch (error) {
    console.error("renameAiSession failed:", error);
  }
}

function sessionTitleFromPrompt(prompt: string) {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "新的 AI CLI 会话";
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}...` : firstLine;
}

function sortSessionsByUpdatedAt(left: AiSession, right: AiSession) {
  const rightTime = Date.parse(right.updatedAt ?? "");
  const leftTime = Date.parse(left.updatedAt ?? "");
  return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
}

async function archiveAiSession(sessionId: string, archived: boolean) {
  if (!sessionId) return;
  try {
    const session = await desktopApi.archiveLocalAiSession(sessionId, archived);
    aiSessions.value = [session, ...aiSessions.value.filter((item) => item.id !== session.id)];
    if (archived && activeAiSession.value?.id === session.id) {
      activeAiSession.value = null;
      chatMessages.value = [{ role: "system", text: "会话已归档。可以在最近 AI 会话的“已归档”中恢复。" }];
    }
    if (!archived) showArchivedSessions.value = false;
  } catch (error) {
    chatMessages.value.push({ role: "error", text: `${archived ? "归档" : "恢复"}失败：${String(error)}` });
  }
}

function isSessionPinned(sessionId: string) {
  return pinnedSessionIds.value.has(sessionId);
}

function toggleSessionPinned(sessionId: string) {
  if (!sessionId) return;
  const next = new Set(pinnedSessionIds.value);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  pinnedSessionIds.value = next;
}

function isSessionUnread(sessionId: string) {
  return unreadSessionIds.value.has(sessionId);
}

function markSessionUnread(sessionId: string) {
  if (!sessionId) return;
  const next = new Set(unreadSessionIds.value);
  next.add(sessionId);
  unreadSessionIds.value = next;
}

function markSessionRead(sessionId: string) {
  if (!sessionId) return;
  if (!unreadSessionIds.value.has(sessionId)) return;
  const next = new Set(unreadSessionIds.value);
  next.delete(sessionId);
  unreadSessionIds.value = next;
}

async function renameAiSession(session: AiSession, title: string) {
  const trimmed = title.trim();
  if (!trimmed) {
    chatMessages.value.push({ role: "error", text: "会话名称不能为空。" });
    return;
  }
  try {
    const updated = await desktopApi.renameLocalAiSession(session.id, trimmed);
    aiSessions.value = aiSessions.value.map((item) => (item.id === updated.id ? updated : item));
    if (activeAiSession.value?.id === updated.id) {
      activeAiSession.value = updated;
      aiSessionTitle.value = updated.title;
    }
    chatMessages.value.push({ role: "system", text: `已重命名为「${updated.title}」。` });
  } catch (error) {
    chatMessages.value.push({ role: "error", text: `重命名失败：${String(error)}` });
  }
}

async function openAiSessionInNewWindow(session: AiSession) {
  try {
    await desktopApi.openSessionInNewWindow(session.id);
  } catch (error) {
    chatMessages.value.push({ role: "error", text: `打开新窗口失败：${String(error)}` });
  }
}

function deriveSessionToLocal(session: AiSession) {
  activeAiSession.value = session;
  selectedProjectPath.value = session.summary ?? selectedProjectPath.value;
  selectedProviderId.value = session.providerId;
  void startShellForActiveSession(true);
  chatMessages.value.push({
    role: "system",
    text: `已为「${session.title}」启动本地终端，会话里看到的代码改动也会落到这个目录。`,
  });
}

async function loginDesktop(server: string, email: string, password: string) {
  const trimmedServer = server.trim();
  const trimmedEmail = email.trim();
  pairResult.value = "正在登录桌面端...";
  pairResultError.value = false;
  if (!trimmedServer || !trimmedEmail || !password) {
    pairResult.value = "请填写服务器地址、账号和密码。";
    pairResultError.value = true;
    return false;
  }
  try {
    const value = await desktopApi.loginDesktop(trimmedServer, trimmedEmail, password);
    pairResult.value = value.deviceId ? `已登录并自动绑定：${value.deviceId.slice(0, 8)}...` : "已登录并自动绑定。";
    pairResultError.value = false;
    settingsServer.value = trimmedServer;
    settingsResult.value = `桌面端已登录：${trimmedServer}`;
    await loadCloudConfig();
    return true;
  } catch (error) {
    const message = String(error);
    if (message.includes("HTTP 401")) {
      pairResult.value = "密码不正确。";
    } else if (message.includes("password must be at least 6 characters")) {
      pairResult.value = "密码至少需要 6 位。";
    } else if (message.includes("email is invalid")) {
      pairResult.value = "邮箱格式不正确。";
    } else {
      pairResult.value = `登录失败：${message}`;
    }
    pairResultError.value = true;
    return false;
  }
}

function clearQrPairingTimer() {
  if (qrPairingTimer !== null) {
    window.clearTimeout(qrPairingTimer);
    qrPairingTimer = null;
  }
}

function describeQrPairingStatus(status: DesktopPairingStatus) {
  if (status.status === "approved") return "手机端已确认，桌面配对配置已保存。";
  if (status.status === "expired") return "二维码已过期，请重新生成。";
  return "等待手机扫码确认。";
}

async function pollQrPairing(server: string, code: string) {
  clearQrPairingTimer();
  if (!code || qrPairingStatus.value !== "pending") return;
  try {
    const status = await desktopApi.getDesktopPairingStatus(server, code);
    pairResult.value = describeQrPairingStatus(status);
    pairResultError.value = false;
    if (status.status === "approved") {
      qrPairingStatus.value = "approved";
      settingsServer.value = server;
      settingsResult.value = `配对配置已保存：${server}`;
      await loadCloudConfig();
      return;
    }
    if (status.status === "expired") {
      qrPairingStatus.value = "expired";
      qrPairingPayload.value = "";
      return;
    }
  } catch (error) {
    pairResult.value = `查询配对状态失败：${String(error)}`;
    pairResultError.value = true;
  }
  qrPairingTimer = window.setTimeout(() => void pollQrPairing(server, code), 2000);
}

async function createQrPairingRequest(server: string) {
  const trimmedServer = server.trim().replace(/\/$/, "");
  clearQrPairingTimer();
  pairResultError.value = false;
  if (!trimmedServer) {
    pairResult.value = "请先填写手机可访问的服务器地址。";
    pairResultError.value = true;
    return;
  }
  qrPairingStatus.value = "creating";
  pairResult.value = "正在生成二维码...";
  try {
    const request = await desktopApi.createDesktopPairingRequest(trimmedServer);
    const payload = await desktopApi.buildDesktopPairingQrPayload(trimmedServer, request.code);
    qrPairingCode.value = request.code;
    qrPairingPayload.value = payload;
    qrPairingExpiresAt.value = request.expiresAt;
    qrPairingStatus.value = "pending";
    pairResult.value = "二维码已生成，等待手机扫码确认。";
    pairResultError.value = false;
    settingsServer.value = trimmedServer;
    void pollQrPairing(trimmedServer, request.code);
  } catch (error) {
    qrPairingStatus.value = "error";
    qrPairingPayload.value = "";
    pairResult.value = `生成二维码失败：${String(error)}`;
    pairResultError.value = true;
  }
}

function saveSettings() {
  const server = settingsServer.value.trim();
  settingsResult.value = `已在本地预览保存。服务器地址：${server || "未设置"}；完整历史仍保存在本机 SQLite。`;
}

async function checkAppUpdate() {
  updateChecking.value = true;
  updateResultError.value = false;
  updateResult.value = "正在检查 GitHub Releases...";
  try {
    const update = await desktopApi.checkAppUpdate();
    updateCurrentVersion.value = update.currentVersion || updateCurrentVersion.value;
    if (!update.available) {
      updateAvailableVersion.value = "";
      updateInstallable.value = false;
      updateResult.value = `当前已经是最新版本${update.currentVersion ? `（当前 ${update.currentVersion}` : ""}${update.version ? `，最新 ${update.version}` : ""}${update.currentVersion ? "）" : ""}${update.body ? `。${update.body}` : "。"}`;
      return;
    }
    updateAvailableVersion.value = update.version ?? "";
    updateInstallable.value = update.installable === true;
    updateResult.value = `发现新版本 ${update.version ?? ""}${update.currentVersion ? `（当前 ${update.currentVersion}）` : ""}${update.body ? `。${update.body}` : "。"}`;
  } catch (error) {
    updateInstallable.value = false;
    updateResultError.value = true;
    updateResult.value = `检查更新失败：${String(error)}`;
  } finally {
    updateChecking.value = false;
  }
}

async function installAppUpdate() {
  updateInstalling.value = true;
  updateResultError.value = false;
  if (!updateInstallable.value) {
    updateResultError.value = true;
    updateResult.value = "当前只检测到版本信息，自动更新通道没有返回可安装文件。请重新检查更新，或手动下载安装最新版。";
    updateInstalling.value = false;
    return;
  }
  updateResult.value = "正在下载并安装更新...";
  try {
    const installed = await desktopApi.installAppUpdate();
    if (!installed) {
      updateAvailableVersion.value = "";
      updateInstallable.value = false;
      updateResult.value = "没有可安装的更新。";
    } else {
      updateResult.value = "更新已下载，应用将退出并安装。";
    }
  } catch (error) {
    updateResultError.value = true;
    updateResult.value = `安装更新失败：${String(error)}`;
  } finally {
    updateInstalling.value = false;
  }
}

function switchView(view: ViewName) {
  const path = routePaths[view];
  if (router.currentRoute.value.path !== path) void router.push(path);
}

export function useWorkspace() {
  return {
    providers,
    providerStatuses,
    projects,
    aiSessions,
    codexProjectSessions,
    terminalSessions,
    activeAiSession,
    showArchivedSessions,
    selectedProjectPath,
    selectedProviderId,
    selectedCreationMode,
    selectedTerminalSessionId,
    aiSessionTitle,
    createAiResult,
    createAiError,
    projectResult,
    projectResultError,
    pairResult,
    pairResultError,
    qrPairingCode,
    qrPairingPayload,
    qrPairingExpiresAt,
    qrPairingStatus,
    settingsServer,
    settingsResult,
    updateResult,
    updateResultError,
    updateChecking,
    updateInstalling,
    updateCurrentVersion,
    updateAvailableVersion,
    updateInstallable,
    chatMessages,
    chatDebugEvents,
    activeChatRunState,
    activeChatIsRunning,
    pinnedSessionIds,
    unreadSessionIds,
    shellBuffers,
    liveShellSessions,
    thinkingSessionIds,
    projectShellSessionId,
    activeSessions,
    archivedSessions,
    refreshWorkspace,
    loadProviders,
    loadLocalWorkspace,
    refreshCodexProjectSessions,
    detectProviders,
    refreshTerminalSessions,
    chooseProject,
    registerProject,
    renameProject,
    removeProject,
    openProjectInFileManager,
    selectProjectPath,
    resetChatControlsForNewSession,
    createAiSessionForProject,
    attachAiSessionForProject,
    importCodexProjectSession,
    prepareProjectSession,
    createAiSession,
    startShellForActiveSession,
    restartShellForActiveSession,
    startShellForProject,
    restartShellForProject,
    setActiveAiSession,
    selectAiSessionFromDropdown,
    loadAiSessionHistory,
    sendPrompt,
    stopActiveAiChat,
    sendShellInput,
    sendProjectShellInput,
    resizeShell,
    resizeProjectShell,
    archiveAiSession,
    renameAiSession,
    isSessionPinned,
    toggleSessionPinned,
    isSessionUnread,
    markSessionUnread,
    markSessionRead,
    openAiSessionInNewWindow,
    deriveSessionToLocal,
    loginDesktop,
    createQrPairingRequest,
    saveSettings,
    checkAppUpdate,
    installAppUpdate,
    switchView,
  };
}
