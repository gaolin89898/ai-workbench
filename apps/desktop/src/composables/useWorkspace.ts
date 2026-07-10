import { computed, ref, watch } from "vue";
import router from "../router";
import { desktopApi, type AiChatOptions, type AiChatOutputEvent, type AiProvider, type AiProviderTrace, type AiSession, type AiTraceUpdateEvent, type AppUpdateDownloadProgress, type AppUpdateInfo, type ChatImageAttachment, type ChatMessage, type ChatSegment, type ProviderStatus, type TerminalSession, type ViewName, type WorkspaceProject } from "../services/desktop";
import { decodeAssistantMessageFromStorage, encodeAssistantMessageForStorage, extractAssistantText } from "../utils/chat";

const providers = ref<AiProvider[]>([]);
const providerStatuses = ref<ProviderStatus[]>([]);
const projects = ref<WorkspaceProject[]>([]);
const aiSessions = ref<AiSession[]>([]);
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
const settingsServer = ref("");
const settingsResult = ref("尚未读取连接配置");
const updateResult = ref("尚未检查更新。");
const updateResultError = ref(false);
const updateChecking = ref(false);
const updateInstalling = ref(false);
const updateCurrentVersion = ref("—");
const updateAvailableVersion = ref("");
const updateInstallable = ref(false);
const updateDownloadProgress = ref<AppUpdateDownloadProgress | null>(null);
const updatePackageSizeBytes = ref<number | null>(null);
const chatMessages = ref<ChatMessage[]>([
  { role: "system", text: "创建 AI 会话后，这里会变成聊天界面。" },
]);
const chatMessagesBySessionId = ref<Record<string, ChatMessage[]>>({});
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
  const list = aiSessions.value.filter((session) => !session.archivedAt && !isCodexExternalMirrorSession(session));
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
const archivedSessions = computed(() => aiSessions.value.filter((session) => !!session.archivedAt && !isCodexExternalMirrorSession(session)));
const activeChatRunState = computed(() => {
  const sessionId = activeAiSession.value?.id;
  return sessionId ? chatRunStates.value[sessionId] : undefined;
});
const activeChatIsRunning = computed(() => {
  const sessionId = activeAiSession.value?.id;
  return Boolean(activeChatRunState.value?.active || (sessionId && pendingAssistants.has(sessionId)));
});
const hasRunningAiSession = computed(() => {
  if (Object.values(thinkingSessionIds.value).some(Boolean)) return true;
  if ([...pendingAssistants.keys()].length > 0) return true;
  return Object.values(chatRunStates.value).some((state) => state.active || state.phase === "running" || state.phase === "starting");
});

async function hasBlockingAiRun() {
  if (hasRunningAiSession.value) return true;
  return desktopApi.hasLiveAiChat();
}

type PendingAssistant = {
  clientId: string;
  message: ChatMessage;
  prompt: string;
  steps: Map<string, ChatSegment>;
  finalText: string;
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
let updateEventsInitialized = false;
let updateEventsInitPromise: Promise<void> | null = null;
let updatePackageSizeLookupSeq = 0;
let runningElapsedTimer: number | null = null;
const supportedChatProviders = new Set(["codex", "claude", "opencode", "mimo"]);

function updateProgressPercentFrom(progress: AppUpdateDownloadProgress | null) {
  if (!progress) return null;
  if (Number.isFinite(progress.percent)) {
    return Math.min(100, Math.max(0, progress.percent ?? 0));
  }
  if (
    Number.isFinite(progress.transferred)
    && Number.isFinite(progress.total)
    && (progress.total ?? 0) > 0
  ) {
    return Math.min(100, Math.max(0, ((progress.transferred ?? 0) / (progress.total ?? 1)) * 100));
  }
  return null;
}

function formatUpdateBytes(value?: number) {
  if (!Number.isFinite(value) || !value || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const precision = amount >= 10 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

const updateDownloadPercent = computed(() => updateProgressPercentFrom(updateDownloadProgress.value));
const updateDownloadProgressLabel = computed(() => {
  const percent = updateDownloadPercent.value;
  if (percent !== null) return `下载进度 ${percent.toFixed(0)}%`;
  if (updateInstalling.value) return "正在下载更新...";
  return "";
});
const updateDownloadSizeLabel = computed(() => {
  const progress = updateDownloadProgress.value;
  if (!progress) return "";
  const transferred = formatUpdateBytes(progress.transferred);
  const total = formatUpdateBytes(updatePackageSizeBytes.value ?? progress.total);
  const speed = formatUpdateBytes(progress.bytesPerSecond);
  const sizeLabel = transferred && total ? `${transferred} / ${total}` : transferred || total;
  if (sizeLabel && speed) return `${sizeLabel}，${speed}/s`;
  if (sizeLabel) return sizeLabel;
  if (speed) return `${speed}/s`;
  return "";
});

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
    ?? ({ codex: "Codex", claude: "Claude Code", opencode: "OpenCode", mimo: "MiMo Code" } as Record<string, string>)[providerId]
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
  if (providerId === "claude") return "Claude Agent SDK";
  if (providerId === "opencode") return "OpenCode ACP";
  if (providerId === "mimo") return "MiMo local API";
  return providerDisplayName(providerId);
}

function isTraceProvider(providerId?: string | null) {
  return providerId === "codex" || providerId === "claude" || providerId === "opencode" || providerId === "mimo";
}

function traceKindForProvider(providerId?: string | null) {
  if (providerId === "claude") return "claude";
  if (providerId === "opencode" || providerId === "mimo") return providerId ?? "codex";
  return "codex";
}

function setChatRunState(sessionId: string, patch: Partial<ChatRunState>) {
  const previous = chatRunStates.value[sessionId];
  const next = {
    active: patch.active ?? previous?.active ?? false,
    phase: patch.phase ?? previous?.phase ?? "idle",
    title: patch.title ?? previous?.title ?? "就绪",
    detail: patch.detail ?? previous?.detail ?? "",
    startedAt: patch.startedAt ?? previous?.startedAt,
    updatedAt: Date.now(),
  };
  if (previous
    && previous.active === next.active
    && previous.phase === next.phase
    && previous.title === next.title
    && previous.detail === next.detail
    && previous.startedAt === next.startedAt) {
    return;
  }
  chatRunStates.value = {
    ...chatRunStates.value,
    [sessionId]: next,
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

function withMessageCreatedAt(message: ChatMessage): ChatMessage {
  return message.createdAt ? message : { ...message, createdAt: new Date().toISOString() };
}

function withMessagesCreatedAt(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(withMessageCreatedAt);
}

function setChatMessagesForSession(sessionId: string, messages: ChatMessage[]) {
  const normalizedMessages = withMessagesCreatedAt(messages);
  chatMessagesBySessionId.value = {
    ...chatMessagesBySessionId.value,
    [sessionId]: normalizedMessages,
  };
  if (activeAiSession.value?.id === sessionId) {
    chatMessages.value = normalizedMessages;
  }
}

function chatMessagesForSession(sessionId: string) {
  return activeAiSession.value?.id === sessionId
    ? chatMessages.value
    : chatMessagesBySessionId.value[sessionId] ?? [];
}

function replaceCurrentChatMessages(messages: ChatMessage[]) {
  const sessionId = activeAiSession.value?.id;
  if (sessionId) {
    setChatMessagesForSession(sessionId, messages);
    return;
  }
  chatMessages.value = withMessagesCreatedAt(messages);
}

function appendCurrentChatMessage(message: ChatMessage) {
  replaceCurrentChatMessages([...chatMessages.value, message]);
}

function appendChatMessageForSession(sessionId: string, message: ChatMessage) {
  setChatMessagesForSession(sessionId, [...chatMessagesForSession(sessionId), message]);
}

function cacheActiveChatMessages() {
  const sessionId = activeAiSession.value?.id;
  if (!sessionId) return;
  setChatMessagesForSession(sessionId, chatMessages.value);
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
  tokenUsage: "/token-usage",
};

watch(providers, (next) => {
  if (!selectedProviderId.value && next.length) selectedProviderId.value = next[0].id;
});

watch(selectedProjectPath, () => {
  if (activeAiSession.value && selectedProjectPath.value && activeAiSession.value.summary !== selectedProjectPath.value) {
    cacheActiveChatMessages();
    activeAiSession.value = null;
    chatMessages.value = [];
    aiSessionTitle.value = "新的 AI CLI 会话";
    selectedTerminalSessionId.value = "";
  }
});

async function refreshWorkspace() {
  await initAiEventListeners();
  await initWorkspaceEventListeners();
  await initUpdateEventListeners();
  await Promise.all([loadCloudConfig(), loadProviders(), loadLocalWorkspace(), refreshTerminalSessions(), loadAppVersion()]);
  ensureSelectedProject();
  void detectProviders();
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
    settingsResult.value = "已读取保存的连接配置。";
  } catch (error) {
    settingsResult.value = `读取连接配置失败：${String(error)}`;
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
  ensureSelectedProject();
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
      cacheActiveChatMessages();
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
  cacheActiveChatMessages();
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
  cacheActiveChatMessages();
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
  cacheActiveChatMessages();
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
  if (activeAiSession.value?.id) {
    cacheActiveChatMessages();
    await saveAssistantDraft(activeAiSession.value.id);
  }
  activeAiSession.value = session;
  markSessionRead(session.id);
  syncChatControlsWithSession(session);
  switchView("aiSessions");
  chatMessages.value = chatMessagesBySessionId.value[session.id] ?? [];
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
  const messages = dedupeAdjacentChatMessages(history.map((message) => {
    if (message.role !== "assistant") {
      const decoded = decodeAssistantMessageFromStorage(message.content);
      return { role: message.role, text: decoded.text, images: decoded.images, createdAt: message.createdAt };
    }
    const decoded = decodeAssistantMessageFromStorage(message.content);
    return {
      role: message.role,
      text: decoded.text,
      segments: decoded.segments,
      createdAt: message.createdAt,
    };
  }));
  const session = aiSessions.value.find((item) => item.id === sessionId) ?? activeAiSession.value;
  if (session?.id !== sessionId || !isTraceProvider(session.providerId)) return messages;
  const trace = await desktopApi.getLocalAiTrace(sessionId, traceKindForProvider(session.providerId)).catch(() => null);
  return mergeProviderTraceIntoMessages(messages, trace);
}

function providerTraceFinalText(trace: AiProviderTrace | null | undefined) {
  if (!trace) return "";
  const snapshot = trace.snapshot as { finalText?: unknown };
  return (typeof trace.finalText === "string" && trace.finalText.trim())
    ? trace.finalText.trim()
    : (typeof snapshot.finalText === "string" ? snapshot.finalText.trim() : "");
}

function providerTraceSegments(trace: AiProviderTrace | null | undefined) {
  return Array.isArray(trace?.segments) ? trace.segments : [];
}

function providerTracePending(trace: AiProviderTrace | null | undefined) {
  return trace?.status === "running";
}

function providerTraceRunState(trace: AiProviderTrace) {
  const providerName = providerDisplayName(trace.providerId);
  if (trace.status === "running") {
    return {
      active: true,
      phase: "running" as const,
      title: `${providerName} 正在执行`,
      detail: `正在同步 ${providerName} 执行记录。`,
    };
  }
  if (trace.status === "failed") {
    return {
      active: false,
      phase: "error" as const,
      title: `${providerName} 执行失败`,
      detail: `${providerName} 原生状态显示本次执行失败。`,
    };
  }
  if (trace.status === "canceled") {
    return {
      active: false,
      phase: "done" as const,
      title: `${providerName} 已取消`,
      detail: `${providerName} 原生状态显示本次执行已取消。`,
    };
  }
  return {
    active: false,
    phase: "done" as const,
    title: `${providerName} 已完成`,
    detail: "执行记录和最终回答已同步。",
  };
}

function providerTraceToChatMessage(trace: AiProviderTrace): ChatMessage | null {
  const segments = providerTraceSegments(trace);
  const text = providerTraceFinalText(trace);
  if (!segments.length && !text) return null;
  return {
    role: "assistant",
    pending: providerTracePending(trace),
    text,
    segments,
    createdAt: trace.createdAt ?? trace.updatedAt,
  };
}

function mergeTraceSegments(existing: ChatSegment[] = [], incoming: ChatSegment[] = [], done = false) {
  const merged = new Map<string, ChatSegment>();
  const order: string[] = [];
  const put = (segment: ChatSegment, fallbackKey: string) => {
    const key = segment.stepId || fallbackKey;
    if (!merged.has(key)) order.push(key);
    merged.set(key, { ...(merged.get(key) ?? {}), ...segment } as ChatSegment);
  };
  existing.forEach((segment, index) => put(segment, `existing-${index}`));
  incoming.forEach((segment, index) => put(segment, `incoming-${index}`));
  return order
    .map((key) => merged.get(key))
    .filter((segment): segment is ChatSegment => Boolean(segment))
    .filter((segment) => !(done && (segment.stepId === "runtime-status" || segment.stepId === "initial-thinking")))
    .map((segment) => finalizeSegmentForDone(segment, done));
}

function mergeProviderTraceIntoMessages(messages: ChatMessage[], trace: AiProviderTrace | null) {
  if (!trace || !isTraceProvider(trace.providerId)) return messages;
  const traceMessage = providerTraceToChatMessage(trace);
  if (!traceMessage) return messages;
  const next = [...messages];
  const lastAssistantIndex = next.map((message) => message.role).lastIndexOf("assistant");
  if (lastAssistantIndex >= 0) {
    next[lastAssistantIndex] = {
      ...next[lastAssistantIndex],
      pending: traceMessage.pending,
      text: traceMessage.text || next[lastAssistantIndex].text,
      segments: mergeTraceSegments(next[lastAssistantIndex].segments ?? [], traceMessage.segments ?? [], !traceMessage.pending),
    };
    return dedupeAdjacentChatMessages(next);
  }
  return dedupeAdjacentChatMessages([...next, traceMessage]);
}

function dedupeAdjacentChatMessages(messages: ChatMessage[]) {
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const previous = deduped[deduped.length - 1];
    if (previous && areDuplicateChatMessages(previous, message)) {
      if (chatMessageScore(message) > chatMessageScore(previous)) {
        deduped[deduped.length - 1] = message;
      }
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}

function areDuplicateChatMessages(left: ChatMessage, right: ChatMessage) {
  if (left.role !== right.role) return false;
  if (left.role !== "assistant") return chatMessageFingerprint(left) === chatMessageFingerprint(right);
  return areDuplicateAssistantDisplays(
    assistantVisibleText(left),
    assistantVisibleText(right),
  );
}

function assistantVisibleText(message: ChatMessage) {
  return stripProcessTextFromFinalText(message.text ?? "", message.segments ?? []);
}

function areDuplicateAssistantDisplays(left: string, right: string) {
  const a = normalizeAssistantDisplayText(left);
  const b = normalizeAssistantDisplayText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 80 && longer.startsWith(shorter)) return true;
  if (shorter.length < 160) return false;
  return commonPrefixLength(shorter, longer) / shorter.length >= 0.86;
}

function normalizeAssistantDisplayText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function chatMessageFingerprint(message: ChatMessage) {
  const text = message.role === "assistant"
    ? assistantVisibleText(message)
    : (message.text ?? "").trim();
  return JSON.stringify({
    role: message.role,
    text,
    images: (message.images ?? []).map((image) => ({
      name: image.name,
      mimeType: image.mimeType,
      dataUrl: image.dataUrl,
    })),
  });
}

function chatMessageScore(message: ChatMessage) {
  // 移除 final-summary 评分加成，所有状态都绑定到具体步骤
  let score = (message.text ?? "").length + (message.segments?.length ?? 0) * 100;
  return score;
}

async function loadAiSessionHistory(sessionId: string, options: { force?: boolean } = {}) {
  try {
    const hasPending = pendingAssistants.has(sessionId);
    const history = await loadAiSessionHistorySnapshot(sessionId);
    if (activeAiSession.value?.id !== sessionId) return;
    void repairGeneratedCodexSessionTitleFromHistory(sessionId, history);
    if (!options.force && hasPending) {
      restorePendingSessionMessages(sessionId, history);
      return;
    }
    setChatMessagesForSession(sessionId, history);
  } catch (error) {
    if (activeAiSession.value?.id !== sessionId) return;
    if (pendingAssistants.has(sessionId) && !options.force) {
      restorePendingSessionMessages(sessionId);
      return;
    }
    setChatMessagesForSession(sessionId, [{ role: "error", text: `读取历史失败：${String(error)}` }]);
  }
}

function restorePendingSessionMessages(sessionId: string, history: ChatMessage[] = []) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending || activeAiSession.value?.id !== sessionId) return false;
  const base = [...history];
  const lastAssistantIndex = base.map((message) => message.role).lastIndexOf("assistant");
  if (lastAssistantIndex >= 0 && base[lastAssistantIndex].pending) {
    base[lastAssistantIndex] = pending.message;
  } else {
    base.push(pending.message);
  }
  setChatMessagesForSession(sessionId, dedupeAdjacentChatMessages(base));
  return true;
}

async function repairGeneratedCodexSessionTitleFromHistory(sessionId: string, history: ChatMessage[]) {
  const session = activeAiSession.value?.id === sessionId
    ? activeAiSession.value
    : aiSessions.value.find((item) => item.id === sessionId);
  if (!session || session.providerId !== "codex" || !isGeneratedCodexSessionTitle(session.title)) return;
  const firstUserText = history.find((message) => message.role === "user" && message.text?.trim())?.text?.trim();
  if (!firstUserText) return;
  const title = sessionTitleFromPrompt(firstUserText);
  if (!title || title === session.title || isGeneratedCodexSessionTitle(title)) return;
  const updatedAt = new Date().toISOString();
  aiSessions.value = aiSessions.value.map((item) =>
    item.id === sessionId ? { ...item, title, updatedAt } : item
  ).sort(sortSessionsByUpdatedAt);
  if (activeAiSession.value?.id === sessionId) {
    activeAiSession.value = { ...activeAiSession.value, title, updatedAt };
    aiSessionTitle.value = title;
  }
  try {
    await desktopApi.renameAiSession(sessionId, title);
  } catch (error) {
    pushChatDebugEvent(`修复会话标题失败：${String(error)}`);
  }
}

function isGeneratedCodexSessionTitle(title: string) {
  return /^(?:[\w.-]+|Codex)\s+会话\s+[0-9a-f]{8}$/i.test(title.trim());
}

function isCodexExternalMirrorSession(session: AiSession | null) {
  if (!session || session.providerId !== "codex" || !session.providerSessionId) return false;
  return !session.providerSessionId.startsWith("app-server:");
}

async function sendPrompt(prompt: string, images: ChatImageAttachment[] = [], chatOptions: AiChatOptions = {}) {
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
    appendCurrentChatMessage({ role: "error", text: "这个会话已归档。请先在“已归档”列表中恢复，再继续发送消息。" });
    return;
  }
  const sessionId = activeAiSession.value.id;
  const providerId = activeAiSession.value.providerId;
  const providerName = providerDisplayName(providerId);
  const runtimeName = providerRuntimeName(providerId);
  const projectPath = activeAiSession.value.summary || selectedProjectPath.value;
  if (!supportedChatProviders.has(providerId)) {
    appendCurrentChatMessage({
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
    appendCurrentChatMessage({ role: "error", text: `当前 ${providerName} 会话没有项目路径，请先在左侧选择项目。` });
    return;
  }
  if (pendingAssistants.has(sessionId)) {
    appendCurrentChatMessage({ role: "error", text: "上一条消息还在处理，请等它完成后再发送。" });
    return;
  }
  await saveAssistantDraft(sessionId);
  const promptForSession = trimmed || `查看这 ${plainImages.length} 张图片`;
  const displayText = trimmed;
  renameUntitledSession(sessionId, promptForSession);
  appendChatMessageForSession(sessionId, { clientId: chatClientId("user"), role: "user", text: displayText, images: plainImages });
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
  appendChatMessageForSession(sessionId, assistantMessage);
  pendingAssistants.set(sessionId, {
    clientId: assistantClientId,
    message: assistantMessage,
    prompt: promptForSession,
    steps: new Map([["initial-thinking", assistantMessage.segments![0]]]),
    finalText: "",
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
    const runRequest = {
      aiSessionId: sessionId,
      projectPath,
      prompt: promptForSession,
      images: plainImages,
      ...chatOptions,
    };
    void runChat(runRequest).then((providerSessionId) => {
      const pending = pendingAssistants.get(sessionId);
      const startedAt = pending?.startedAt ?? chatRunStates.value[sessionId]?.startedAt ?? performance.now();
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (!pending) {
        const wasStopped = stoppedAiSessions.delete(sessionId);
        pushChatDebugEvent(wasStopped
          ? `${providerName} 执行已由用户主动停止`
          : `${providerName} 进程已退出：providerSessionId ${providerSessionId ? "已更新" : "为空"}`);
        setChatRunState(sessionId, {
          active: false,
          phase: "done",
          title: wasStopped ? "用户主动停止" : `${providerName} 已完成`,
          detail: wasStopped
            ? "本次执行已停止，已保留中断前的执行过程。"
            : `执行已结束，用时 ${formatElapsedMs(elapsedMs)}。正在等待下一条消息。`,
        });
        return;
      }
      pushChatDebugEvent(`${providerName} 进程已退出：用时 ${formatElapsedMs(elapsedMs)}`);
      if (isTraceProvider(providerId)) {
        void desktopApi.getLocalAiTrace(sessionId, traceKindForProvider(providerId)).then((trace) => {
          if (trace) void handleAiTraceUpdateEvent({ aiSessionId: sessionId, trace });
        });
        window.setTimeout(() => {
          void loadAiSessionHistory(sessionId, { force: true });
        }, 600);
        setChatRunState(sessionId, {
          active: false,
          phase: "done",
          title: `${providerName} 已完成`,
          detail: `执行已结束，用时 ${formatElapsedMs(elapsedMs)}。正在等待下一条消息。`,
        });
        return;
      }
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
        pushChatDebugEvent(`${providerName} 执行已由用户主动停止`);
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

async function ensureIncomingPendingAssistantAfterRefresh(sessionId: string) {
  if (pendingAssistants.has(sessionId)) return pendingAssistants.get(sessionId) ?? null;
  await loadLocalWorkspace();
  const history = await loadAiSessionHistorySnapshot(sessionId).catch(() => []);
  return ensureIncomingPendingAssistant(sessionId, history);
}

function ensureIncomingPendingAssistant(sessionId: string, history: ChatMessage[] = []) {
  const existing = pendingAssistants.get(sessionId);
  if (existing) return existing;
  const session = activeAiSession.value?.id === sessionId
    ? activeAiSession.value
    : aiSessions.value.find((item) => item.id === sessionId);
  if (!session) return null;
  const providerName = providerNameForSession(sessionId);
  if (history.length) setChatMessagesForSession(sessionId, history);
  if (activeAiSession.value?.id !== sessionId) markSessionUnread(sessionId);
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
  appendChatMessageForSession(sessionId, assistantMessage);
  const pending: PendingAssistant = {
    clientId: assistantClientId,
    message: assistantMessage,
    prompt: "",
    steps: new Map([["initial-thinking", assistantMessage.segments![0]]]),
    finalText: "",
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

function stripProcessTextFromFinalText(text: string, sourceSegments: ChatSegment[]) {
  let cleaned = text.trim();
  if (!cleaned) return cleaned;
  for (const segment of sourceSegments) {
    if (!isProcessTextSegment(segment)) continue;
    cleaned = removeTextBlock(cleaned, segment.text);
    if (!cleaned) break;
  }
  return cleaned.trim();
}

function removeMatchingProcessText(pending: PendingAssistant, text: string) {
  const target = text.trim();
  if (!target) return;
  for (const [stepId, segment] of pending.steps.entries()) {
    if (isProcessTextSegment(segment) && segment.text.trim() === target) {
      pending.steps.delete(stepId);
    }
  }
}

function isProcessTextSegment(segment: ChatSegment) {
  return segment.type === "text" && Boolean(segment.stepId && /^(?:process-text|thought|commentary)-/.test(segment.stepId));
}

function isProcessConclusionTextSegment(segment: ChatSegment) {
  return segment.type === "text" && Boolean(segment.stepId?.startsWith("process-text-conclusion-"));
}

function processTextStepId(stepId?: string | null) {
  if (!stepId) return "process-text-agent-message";
  return stepId.startsWith("process-text-") ? stepId : `process-text-${stepId}`;
}

function removeTextBlock(text: string, block: string) {
  const target = block.trim();
  let source = text.trim();
  if (!target || !source) return source;
  if (source === target) return "";
  if (source.startsWith(target)) return source.slice(target.length).trimStart();
  const surrounded = `\n\n${target}\n\n`;
  const index = source.indexOf(surrounded);
  if (index >= 0) {
    source = `${source.slice(0, index)}\n\n${source.slice(index + surrounded.length)}`;
  }
  return source.trim();
}

function appendPendingAssistantText(sessionId: string, text: string, stepId?: string | null, phase: AiChatOutputEvent["phase"] = "final") {
  const pending = pendingAssistants.get(sessionId);
  if (!pending || !text) return;
  if (stepId && stepId !== pending.currentAgentMessageStepId) {
    pending.currentAgentMessageStepId = stepId;
  }
  if (phase === "process") {
    const processStepId = processTextStepId(stepId);
    const previous = pending.steps.get(processStepId);
    const previousText = previous?.type === "text" ? previous.text : "";
    if (stepId) pending.steps.delete(stepId);
    pending.steps.set(processStepId, {
      type: "text",
      stepId: processStepId,
      text: extractAssistantText(`${previousText}${text}`),
    });
  } else {
    pending.finalText = extractAssistantText(`${pending.finalText}${text}`);
  }
  syncPendingAssistantSegments(sessionId, false);
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: true };
}

function persistPendingAssistantSnapshot(sessionId: string, pending: PendingAssistant, fallbackText = "") {
  const finalText = extractAssistantText((pending.finalText || pending.message.text || fallbackText).trim());
  const finalSegments = pending.message.segments ?? [];
  if (!finalText && !finalSegments.length) return;
  const storageKey = finalText || JSON.stringify(finalSegments);
  const draft = assistantDrafts.get(sessionId);
  if (draft && storageKey === draft.savedText) return;
  assistantDrafts.set(sessionId, { message: pending.message, savedText: storageKey });
  void desktopApi.appendLocalAiMessage(sessionId, "assistant", encodeAssistantMessageForStorage({
    text: finalText,
    segments: finalSegments,
  })).catch((error) => {
    pushChatDebugEvent(`保存回答失败：${String(error)}`);
  });
}

function completePendingAssistantFromExec(sessionId: string) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  const text = extractAssistantText((pending.finalText || pending.message.text).trim());
  removeMatchingProcessText(pending, text);
  pending.finalText = stripProcessTextFromFinalText(text, [...pending.steps.values()]);
  upsertCompletionSummary(sessionId);
  syncPendingAssistantSegments(sessionId, true);
  persistPendingAssistantSnapshot(sessionId, pending);
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
  pendingAssistants.delete(sessionId);
  assistantDrafts.delete(sessionId);
  stopRunningElapsedTimerIfIdle();
}

function interruptPendingAssistant(sessionId: string) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  pending.steps.delete("runtime-status");
  pending.steps.delete("initial-thinking");
  pending.steps.set("interrupted", {
    type: "status",
    stepId: "interrupted",
    label: "用户主动停止",
    icon: "warn",
    status: "canceled",
  });
  syncPendingAssistantSegments(sessionId, true);
  persistPendingAssistantSnapshot(sessionId, pending, "用户主动停止");
  pendingAssistants.delete(sessionId);
  assistantDrafts.delete(sessionId);
  stopRunningElapsedTimerIfIdle();
}

function expirePendingApproval(sessionId: string, approvalId: string, detail = "Approval request expired.") {
  const expireSegment = (segment: ChatSegment): ChatSegment => {
    if (segment.type !== "approval" || segment.approvalId !== approvalId || segment.status !== "pending") return segment;
    return { ...segment, status: "expired", detail };
  };

  const pending = pendingAssistants.get(sessionId);
  if (pending) {
    pending.steps = new Map([...pending.steps.entries()].map(([key, segment]) => [key, expireSegment(segment)]));
    syncPendingAssistantSegments(sessionId, true);
    persistPendingAssistantSnapshot(sessionId, pending);
    pendingAssistants.delete(sessionId);
    assistantDrafts.delete(sessionId);
  } else {
    const nextMessages = chatMessagesForSession(sessionId).map((message) => (
      message.segments?.some((segment) => segment.type === "approval" && segment.approvalId === approvalId && segment.status === "pending")
        ? {
          ...message,
          pending: false,
          segments: message.segments.map(expireSegment),
        }
        : message
    ));
    setChatMessagesForSession(sessionId, nextMessages);
  }

  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
  setChatRunState(sessionId, {
    active: false,
    phase: "done",
    title: "Approval expired",
    detail,
  });
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
      interruptPendingAssistant(sessionId);
    }
  }
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
  setChatRunState(sessionId, {
    active: false,
    phase: "done",
    title: "用户主动停止",
    detail: "本次执行已停止，可以继续发送新消息。",
  });
}

function upsertPendingSegment(sessionId: string, segment: ChatSegment) {
  const pending = pendingAssistants.get(sessionId);
  const stepId = segment.stepId;
  if (!pending || !stepId) return;
  if (segment.type === "status") {
    if (shouldHideBackendStatus(segment.label)) {
      return;
    }
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
  if (!done) return segment;
  if (segment.type === "tool" && segment.status === "running") return { ...segment, status: "success" };
  if (segment.type === "approval" && segment.status === "pending") return { ...segment, status: "expired" };
  return segment;
}

function upsertCompletionSummary(sessionId: string) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  // 移除 final-summary，completed 状态已绑定到各个执行步骤
  pending.steps.delete("runtime-status");
  pending.steps.delete("initial-thinking");
}

function isPersistentStatusSegment(segment: ChatSegment) {
  // 移除 final-summary，所有状态都绑定到具体步骤
  return false;
}

function shouldHideBackendStatus(text: string) {
  return text.includes("已生成一段回复") || text.includes("继续等待最终完成信号") || text === "mobile sent message" || text === "created";
}

function patchPendingAssistant(sessionId: string, patch: Partial<ChatMessage>) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return null;
  const currentMessage = pending.message;
  const nextMessage = { ...currentMessage, ...patch };
  pending.message = nextMessage;
  const draft = assistantDrafts.get(sessionId);
  if (draft) assistantDrafts.set(sessionId, { message: nextMessage, savedText: draft.savedText });
  let replaced = false;
  const nextMessages = chatMessagesForSession(sessionId).map((message) => (
    message.clientId === pending.clientId || message === currentMessage
      ? (replaced = true, nextMessage)
      : message
  ));
  if (!replaced) {
    setChatMessagesForSession(sessionId, [...nextMessages, nextMessage]);
  } else {
    setChatMessagesForSession(sessionId, nextMessages);
  }
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
    desktopApi.onAiTraceUpdate((event) => {
      void handleAiTraceUpdateEvent(event);
    }),
  ]).then(() => {
    aiEventsInitialized = true;
  });
  return aiEventsInitPromise;
}

function isTraceProviderSessionId(sessionId: string) {
  const session = activeAiSession.value?.id === sessionId
    ? activeAiSession.value
    : aiSessions.value.find((item) => item.id === sessionId);
  return isTraceProvider(session?.providerId);
}

async function handleAiTraceUpdateEvent(event: AiTraceUpdateEvent) {
  if (!isTraceProvider(event.trace.providerId) || event.trace.traceKind !== traceKindForProvider(event.trace.providerId)) return;
  let pending = pendingAssistants.get(event.aiSessionId);
  if (!pending && providerTracePending(event.trace)) {
    pending = await ensureIncomingPendingAssistantAfterRefresh(event.aiSessionId) ?? undefined;
  }
  const traceMessage = providerTraceToChatMessage(event.trace);
  const stopped = stoppedAiSessions.has(event.aiSessionId);
  if (stopped && !providerTracePending(event.trace)) {
    if (pending) {
      if (traceMessage?.text) pending.finalText = traceMessage.text;
      for (const [index, segment] of (traceMessage?.segments ?? []).entries()) {
        pending.steps.set(segment.stepId ?? `${event.trace.providerId}-trace-${index}`, segment);
      }
      interruptPendingAssistant(event.aiSessionId);
    }
    thinkingSessionIds.value = { ...thinkingSessionIds.value, [event.aiSessionId]: false };
    setChatRunState(event.aiSessionId, {
      active: false,
      phase: "done",
      title: "用户主动停止",
      detail: "本次执行已停止，已保留中断前的执行过程。",
    });
    return;
  }
  if (!traceMessage) return;
  const pendingState = providerTracePending(event.trace);
  if (pending) {
    pending.finalText = traceMessage.text ?? pending.finalText;
    const mergedSegments = mergeTraceSegments([...pending.steps.values()], traceMessage.segments ?? [], !traceMessage.pending);
    pending.steps = new Map(mergedSegments.map((segment, index) => [
      segment.stepId ?? `${event.trace.providerId}-trace-${index}`,
      segment,
    ]));
    patchPendingAssistant(event.aiSessionId, {
      role: "assistant",
      pending: traceMessage.pending,
      text: traceMessage.text || pending.finalText,
      segments: mergedSegments,
    });
  } else if (activeAiSession.value?.id === event.aiSessionId) {
    setChatMessagesForSession(
      event.aiSessionId,
      mergeProviderTraceIntoMessages(chatMessagesForSession(event.aiSessionId), event.trace),
    );
  }

  if (thinkingSessionIds.value[event.aiSessionId] !== pendingState) {
    thinkingSessionIds.value = {
      ...thinkingSessionIds.value,
      [event.aiSessionId]: pendingState,
    };
  }
  setChatRunState(event.aiSessionId, providerTraceRunState(event.trace));

  if (!providerTracePending(event.trace) && pending) {
    const finalText = providerTraceFinalText(event.trace);
    const finalSegments = [...pending.steps.values()];
    const shouldPersist = Boolean(finalText || finalSegments.some((segment) => segment.type === "error"));
    if (shouldPersist) {
      const storageKey = finalText || JSON.stringify(finalSegments);
      const draft = assistantDrafts.get(event.aiSessionId);
      if (!draft || storageKey !== draft.savedText) {
        assistantDrafts.set(event.aiSessionId, { message: pending.message, savedText: storageKey });
        await desktopApi.appendLocalAiMessage(event.aiSessionId, "assistant", encodeAssistantMessageForStorage({
          text: finalText,
          segments: finalSegments,
        })).catch((error) => {
          pushChatDebugEvent(`保存 ${providerDisplayName(event.trace.providerId)} 回答失败：${String(error)}`);
        });
      }
    }
    pendingAssistants.delete(event.aiSessionId);
    assistantDrafts.delete(event.aiSessionId);
    stopRunningElapsedTimerIfIdle();
    window.setTimeout(() => {
      void loadAiSessionHistory(event.aiSessionId, { force: true });
    }, 300);
  }
}

async function handleAiChatOutputEvent(event: AiChatOutputEvent) {
  if (isTraceProviderSessionId(event.aiSessionId) && event.kind !== "error") return;
  if (event.kind === "status" && shouldHideBackendStatus(event.text ?? "")) return;
  let pending = pendingAssistants.get(event.aiSessionId);
  if (!pending && event.kind !== "done" && event.kind !== "error") {
    const created = await ensureIncomingPendingAssistantAfterRefresh(event.aiSessionId);
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
    appendPendingAssistantText(event.aiSessionId, event.text ?? "", event.stepId, event.phase ?? "final");
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
        if (event.text?.trim()) {
          replacePendingAssistantText(event.aiSessionId, event.text, true);
        } else if (pending.finalText.trim()) {
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

async function initUpdateEventListeners() {
  if (updateEventsInitialized) return;
  if (updateEventsInitPromise) return updateEventsInitPromise;
  updateEventsInitPromise = Promise.all([
    desktopApi.onAppUpdateDownloadProgress((progress) => {
      updateDownloadProgress.value = progress;
      updateResultError.value = false;
    }),
    desktopApi.onAppUpdateDownloaded(() => {
      updateDownloadProgress.value = null;
      updateResultError.value = false;
      updateResult.value = "更新已下载，应用将退出并安装。";
    }),
    desktopApi.onAppUpdateError((event) => {
      updateDownloadProgress.value = null;
      updateInstalling.value = false;
      updateResultError.value = true;
      updateResult.value = `安装更新失败：${event.message ?? "未知错误"}`;
    }),
    desktopApi.onAppUpdateAvailableNotice((event) => {
      applyAppUpdateNotice(event);
    }),
  ]).then(() => {
    updateEventsInitialized = true;
  });
  return updateEventsInitPromise;
}

function applyAppUpdateNotice(update: AppUpdateInfo) {
  updateDownloadProgress.value = null;
  updateResultError.value = false;
  updateAvailableVersion.value = update.version ?? "";
  updateInstallable.value = update.installable === true;
  updateCurrentVersion.value = update.currentVersion || updateCurrentVersion.value;
  void refreshUpdatePackageSize(update);
  updateResult.value = update.required
    ? `当前版本过低，需要更新到 ${update.version ?? "最新版本"} 后继续使用。${update.body ?? ""}`
    : `发现新版本 ${update.version ?? ""}${update.body ? `。${update.body}` : "。"}`;
}

function updateDownloadUrlForCurrentPlatform(update: AppUpdateInfo) {
  const platform = window.navigator.platform.toLowerCase();
  if (platform.includes("win") && update.windowsDownloadUrl) return update.windowsDownloadUrl;
  if (platform.includes("linux") && update.linuxDownloadUrl) return update.linuxDownloadUrl;
  return update.downloadUrl ?? update.windowsDownloadUrl ?? update.linuxDownloadUrl ?? "";
}

async function refreshUpdatePackageSize(update: AppUpdateInfo) {
  const seq = ++updatePackageSizeLookupSeq;
  updatePackageSizeBytes.value = typeof update.downloadSize === "number" && update.downloadSize > 0
    ? update.downloadSize
    : null;
  if (updatePackageSizeBytes.value) return;
  const url = updateDownloadUrlForCurrentPlatform(update);
  if (!url) return;
  try {
    const size = await desktopApi.getUpdateDownloadSize(url);
    if (seq === updatePackageSizeLookupSeq && typeof size === "number" && size > 0) {
      updatePackageSizeBytes.value = size;
    }
  } catch {
    // Keep progress.total as the fallback if the asset size cannot be resolved.
  }
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
  if (pendingAssistants.has(sessionId)) return;
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
      cacheActiveChatMessages();
      activeAiSession.value = null;
      chatMessages.value = [{ role: "system", text: "会话已归档。可以在最近 AI 会话的“已归档”中恢复。" }];
    }
    if (!archived) showArchivedSessions.value = false;
  } catch (error) {
    if (activeAiSession.value?.id === sessionId) {
      appendCurrentChatMessage({ role: "error", text: `${archived ? "归档" : "恢复"}失败：${String(error)}` });
    }
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
    appendChatMessageForSession(session.id, { role: "error", text: "会话名称不能为空。" });
    return;
  }
  try {
    const updated = await desktopApi.renameLocalAiSession(session.id, trimmed);
    aiSessions.value = aiSessions.value.map((item) => (item.id === updated.id ? updated : item));
    if (activeAiSession.value?.id === updated.id) {
      activeAiSession.value = updated;
      aiSessionTitle.value = updated.title;
    }
    appendChatMessageForSession(session.id, { role: "system", text: `已重命名为「${updated.title}」。` });
  } catch (error) {
    appendChatMessageForSession(session.id, { role: "error", text: `重命名失败：${String(error)}` });
  }
}

async function openAiSessionInNewWindow(session: AiSession) {
  try {
    await desktopApi.openSessionInNewWindow(session.id);
  } catch (error) {
    appendChatMessageForSession(session.id, { role: "error", text: `打开新窗口失败：${String(error)}` });
  }
}

function deriveSessionToLocal(session: AiSession) {
  if (activeAiSession.value?.id !== session.id) cacheActiveChatMessages();
  activeAiSession.value = session;
  selectedProjectPath.value = session.summary ?? selectedProjectPath.value;
  selectedProviderId.value = session.providerId;
  chatMessages.value = chatMessagesBySessionId.value[session.id] ?? [];
  void startShellForActiveSession(true);
  appendChatMessageForSession(session.id, {
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
    pairResult.value = !trimmedServer ? "请填写服务器地址。" : "请填写账号和密码。";
    pairResultError.value = true;
    return false;
  }
  try {
    const value = await desktopApi.loginDesktop(trimmedServer, trimmedEmail, password);
    pairResult.value = value.deviceId ? `已登录并自动绑定：${value.deviceId.slice(0, 8)}...` : "已登录并自动绑定。";
    pairResultError.value = false;
    settingsServer.value = trimmedServer;
    settingsResult.value = "桌面端已登录。";
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

async function refreshAppUpdateNotice() {
  await initUpdateEventListeners();
  if (updateChecking.value || updateInstalling.value) return;
  try {
    const update = await desktopApi.checkServerAppUpdate();
    if (!update) return;
    updateCurrentVersion.value = update.currentVersion || updateCurrentVersion.value;
    if (!update.available) {
      if (updateAvailableVersion.value) {
        updateAvailableVersion.value = "";
        updateInstallable.value = false;
        updateDownloadProgress.value = null;
        updatePackageSizeBytes.value = null;
      }
      return;
    }
    applyAppUpdateNotice(update);
  } catch {
    // Background update notices should not surface transient network errors.
  }
}

async function checkAppUpdate() {
  await initUpdateEventListeners();
  updateChecking.value = true;
  updateResultError.value = false;
  updateDownloadProgress.value = null;
  updateResult.value = "正在检查 GitHub Releases...";
  try {
    const update = await desktopApi.checkAppUpdate();
    updateCurrentVersion.value = update.currentVersion || updateCurrentVersion.value;
    if (!update.available) {
      updateAvailableVersion.value = "";
      updateInstallable.value = false;
      updateDownloadProgress.value = null;
      updatePackageSizeBytes.value = null;
      updateResult.value = `当前已经是最新版本${update.currentVersion ? `（当前 ${update.currentVersion}` : ""}${update.version ? `，最新 ${update.version}` : ""}${update.currentVersion ? "）" : ""}${update.body ? `。${update.body}` : "。"}`;
      return;
    }
    updateAvailableVersion.value = update.version ?? "";
    updateInstallable.value = update.installable === true;
    void refreshUpdatePackageSize(update);
    updateResult.value = `发现新版本 ${update.version ?? ""}${update.currentVersion ? `（当前 ${update.currentVersion}）` : ""}${update.body ? `。${update.body}` : "。"}`;
  } catch (error) {
    updateInstallable.value = false;
    updateDownloadProgress.value = null;
    updateResultError.value = true;
    updateResult.value = `检查更新失败：${String(error)}`;
  } finally {
    updateChecking.value = false;
  }
}

async function installAppUpdate() {
  await initUpdateEventListeners();
  updateInstalling.value = true;
  updateResultError.value = false;
  updateDownloadProgress.value = null;
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
      updatePackageSizeBytes.value = null;
      updateResult.value = "没有可安装的更新。";
    } else {
      updateResult.value = "更新已下载，应用将退出并安装。";
    }
  } catch (error) {
    updateDownloadProgress.value = null;
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
    settingsServer,
    settingsResult,
    updateResult,
    updateResultError,
    updateChecking,
    updateInstalling,
    updateCurrentVersion,
    updateAvailableVersion,
    updateInstallable,
    updateDownloadProgress,
    updateDownloadPercent,
    updateDownloadProgressLabel,
    updateDownloadSizeLabel,
    chatMessages,
    chatDebugEvents,
    activeChatRunState,
    activeChatIsRunning,
    hasRunningAiSession,
    hasBlockingAiRun,
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
    expirePendingApproval,
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
    refreshAppUpdateNotice,
    checkAppUpdate,
    installAppUpdate,
    switchView,
  };
}
