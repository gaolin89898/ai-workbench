import { computed, ref, watch } from "vue";
import router from "../router";
import { tauriApi, type AiProvider, type AiSession, type ChatMessage, type ChatSegment, type DesktopPairingStatus, type ProviderStatus, type TerminalSession, type ViewName, type WorkspaceProject } from "../services/tauri";
import { extractAssistantText } from "../utils/chat";

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
const pairResult = ref("配对成功后显示 device_id 与 token 摘要。");
const pairResultError = ref(false);
const qrPairingCode = ref("");
const qrPairingPayload = ref("");
const qrPairingExpiresAt = ref("");
const qrPairingStatus = ref<"idle" | "creating" | "pending" | "approved" | "expired" | "error">("idle");
const settingsServer = ref("http://118.196.78.91");
const settingsResult = ref("尚未读取配对配置");
const updateResult = ref("尚未检查更新。");
const updateResultError = ref(false);
const updateChecking = ref(false);
const updateInstalling = ref(false);
const updateAvailableVersion = ref("");
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
const activeChatIsRunning = computed(() => Boolean(activeChatRunState.value?.active));

type PendingAssistant = {
  clientId: string;
  message: ChatMessage;
  prompt: string;
  steps: Map<string, ChatSegment>;
  finalText: string;
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
let aiEventsInitialized = false;
let aiEventsInitPromise: Promise<void> | null = null;
let workspaceEventsInitialized = false;
let workspaceEventsInitPromise: Promise<void> | null = null;
let qrPairingTimer: number | null = null;
const supportedChatProviders = new Set(["codex", "claude"]);

function pushChatDebugEvent(message: string) {
  const time = new Date().toLocaleTimeString();
  if (chatDebugEvents.value[0]?.endsWith(message)) return;
  chatDebugEvents.value = [`${time} ${message}`, ...chatDebugEvents.value].slice(0, 8);
}

function formatElapsedMs(elapsedMs: number) {
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)} 秒`;
}

function formatCompactElapsedMs(elapsedMs: number) {
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)}s`;
}

function providerDisplayName(providerId?: string | null) {
  if (!providerId) return "AI";
  return providers.value.find((provider) => provider.id === providerId)?.name
    ?? ({ codex: "Codex", claude: "Claude Code", opencode: "OpenCode", deepseek: "DeepSeek" } as Record<string, string>)[providerId]
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

const routePaths: Record<ViewName, string> = {
  workspace: "/workspace",
  projects: "/projects",
  aiSessions: "/chat",
  providers: "/providers",
  pairing: "/pairing",
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
  await Promise.all([loadCloudConfig(), loadProviders(), loadLocalWorkspace(), detectProviders(), refreshTerminalSessions()]);
  ensureSelectedProject();
}

async function loadCloudConfig() {
  try {
    const config = await tauriApi.getCloudConfig();
    if (!config) {
      settingsResult.value = "尚未配对桌面。";
      return;
    }
    settingsServer.value = config.serverUrl;
    pairResult.value = `已读取保存的配对：${config.deviceId.slice(0, 8)}...`;
    pairResultError.value = false;
    settingsResult.value = `已连接到保存的服务器：${config.serverUrl}`;
  } catch (error) {
    settingsResult.value = `读取配对配置失败：${String(error)}`;
  }
}

async function loadProviders() {
  providers.value = await tauriApi.listAiProviders();
  if (!selectedProviderId.value && providers.value.length) selectedProviderId.value = providers.value[0].id;
}

async function loadLocalWorkspace() {
  const [storedProjects, storedSessions] = await Promise.all([
    tauriApi.listWorkspaceProjects(),
    tauriApi.listLocalAiSessions(),
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
  providerStatuses.value = await tauriApi.detectAiProviders();
}

async function refreshTerminalSessions() {
  terminalSessions.value = await tauriApi.listSessions();
}

async function chooseProject() {
  projectResult.value = "正在打开文件夹选择器...";
  projectResultError.value = false;
  try {
    const project = await tauriApi.chooseWorkspaceProject();
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
    const project = await tauriApi.addWorkspaceProject(trimmed);
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
    const updated = await tauriApi.renameWorkspaceProject(project.id, trimmed);
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
    await tauriApi.removeWorkspaceProject(project.id);
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
    await tauriApi.openProjectInFileManager(project.path);
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
    const session = await tauriApi.createAiSession({
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
  void tauriApi.warmupAiSession(sessionId).then((session) => {
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
    await tauriApi.startShellPty({ aiSessionId: sessionId, cwd });
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

async function loadAiSessionHistory(sessionId: string) {
  try {
    const history = await tauriApi.listLocalAiHistory(sessionId);
    if (activeAiSession.value?.id !== sessionId) return;
    chatMessages.value = history.map((message) => ({
      role: message.role,
      text: message.content,
    }));
  } catch (error) {
    chatMessages.value = [{ role: "error", text: `读取历史失败：${String(error)}` }];
  }
}

async function sendPrompt(prompt: string) {
  pushChatDebugEvent("收到发送请求");
  await initAiEventListeners();
  const trimmed = prompt.trim();
  if (!trimmed) return;
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
        message: "Codex / Claude Code 支持结构化聊天。OpenCode、DeepSeek 可以先在终端页直接运行对应 CLI。",
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
  renameUntitledSession(sessionId, trimmed);
  chatMessages.value.push({ clientId: chatClientId("user"), role: "user", text: trimmed });
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
    prompt: trimmed,
    steps: new Map([["initial-thinking", assistantMessage.segments![0]]]),
    finalText: "",
    startedAt: performance.now(),
    hasBackendStatus: false,
    lastStatusText: "",
  });
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
    await tauriApi.appendLocalAiMessage(sessionId, "user", trimmed);
    setChatRunState(sessionId, {
      active: true,
      phase: "starting",
      title: `正在启动 ${providerName}`,
      detail: `消息已保存，正在把任务交给 ${runtimeName}。`,
    });
    pushChatDebugEvent(`用户消息已保存：${sessionId.slice(0, 8)}`);
    pushChatDebugEvent(`已连接 ${runtimeName}`);
    void tauriApi.runAiChat({
      aiSessionId: sessionId,
      projectPath,
      prompt: trimmed,
    }).then((reply) => {
      const pending = pendingAssistants.get(sessionId);
      const startedAt = pending?.startedAt ?? chatRunStates.value[sessionId]?.startedAt ?? performance.now();
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (!pending) {
        pushChatDebugEvent(`${providerName} 进程已退出：之前已收到完成事件，返回 ${reply.length} 字符`);
        setChatRunState(sessionId, {
          active: false,
          phase: "done",
          title: `${providerName} 已完成`,
          detail: `执行已结束，用时 ${formatElapsedMs(elapsedMs)}。正在等待下一条消息。`,
        });
        return;
      }
      pushChatDebugEvent(`${providerName} 已返回结果：${reply.length} 字符，用时 ${formatElapsedMs(elapsedMs)}`);
      replacePendingAssistantText(sessionId, reply, true);
      completePendingAssistantFromExec(sessionId);
      setChatRunState(sessionId, {
        active: false,
        phase: "done",
        title: `${providerName} 已完成`,
        detail: `已返回 ${reply.length} 个字符，用时 ${formatElapsedMs(elapsedMs)}。正在等待下一条消息。`,
      });
    }).catch((error) => {
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
    thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
    setChatRunState(sessionId, {
      active: false,
      phase: "error",
      title: "发送失败",
      detail: String(error),
    });
  }
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
  pending.steps.delete("initial-thinking");
  if (text.includes("会话已连接")) {
    pending.steps.delete("conversation-guided");
  } else {
    pending.steps.set("runtime-status", {
      type: "status",
      stepId: "runtime-status",
      label: text,
      icon: "think",
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

function completePendingAssistantFromExec(sessionId: string) {
  const pending = pendingAssistants.get(sessionId);
  if (!pending) return;
  const text = pending.message.text?.trim() ?? "";
  if (!text) return;
  upsertCompletionSummary(sessionId);
  syncPendingAssistantSegments(sessionId, true);
  thinkingSessionIds.value = { ...thinkingSessionIds.value, [sessionId]: false };
  pendingAssistants.delete(sessionId);
  assistantDrafts.delete(sessionId);
}

function upsertPendingSegment(sessionId: string, segment: ChatSegment) {
  const pending = pendingAssistants.get(sessionId);
  const stepId = segment.stepId;
  if (!pending || !stepId) return;
  pending.steps.delete("initial-thinking");
  if (segment.type === "status") {
    if (shouldHideBackendStatus(segment.label)) return;
    if (pending.lastStatusText === segment.label) return;
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
    pending.steps.delete("initial-thinking");
    if (segment.label.includes("会话已连接")) {
      pending.steps.delete("conversation-guided");
    } else {
      pending.steps.set("runtime-status", { ...segment, stepId: "runtime-status" } as ChatSegment);
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
  ));
  if (pending.finalText.trim()) {
    segments.push({ type: "text", text: pending.finalText });
  }
  patchPendingAssistant(sessionId, {
    pending: !done,
    role: "assistant",
    text: pending.finalText,
    segments,
  });
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
    icon: "check",
  });
}

function isPersistentStatusSegment(segment: ChatSegment) {
  return segment.type === "status" && (
    segment.stepId === "final-summary"
  );
}

function shouldHideBackendStatus(text: string) {
  return text.includes("已生成一段回复") || text.includes("继续等待最终完成信号");
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
  await tauriApi.sendShellInput({ aiSessionId: sessionId, text, submit: false });
}

async function resizeShell(cols: number, rows: number) {
  const sessionId = activeAiSession.value?.id;
  if (!sessionId) return;
  if (liveShellSessions.value[sessionId] === false) return;
  await tauriApi.resizeShell({ aiSessionId: sessionId, cols, rows });
}

async function initAiEventListeners() {
  if (aiEventsInitialized) return;
  if (aiEventsInitPromise) return aiEventsInitPromise;
  aiEventsInitPromise = Promise.all([
    tauriApi.onShellTerminalOutput((event) => {
    const previous = shellBuffers.value[event.aiSessionId] ?? "";
    shellBuffers.value = { ...shellBuffers.value, [event.aiSessionId]: previous + event.chunk };
    }),
    tauriApi.onShellSessionStatus((event) => {
    liveShellSessions.value = {
      ...liveShellSessions.value,
      [event.aiSessionId]: event.status === "running",
    };
    }),
    tauriApi.onAiChatOutput((event) => {
      const pending = pendingAssistants.get(event.aiSessionId);
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
        replacePendingAssistantText(event.aiSessionId, `${pending.finalText}${event.text ?? ""}`, false);
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
        replacePendingAssistantText(event.aiSessionId, event.text ?? pending.finalText, true);
        completePendingAssistantFromExec(event.aiSessionId);
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
        thinkingSessionIds.value = { ...thinkingSessionIds.value, [event.aiSessionId]: false };
        setChatRunState(event.aiSessionId, {
          active: false,
          phase: "error",
          title: `${providerName} 执行失败`,
          detail: event.text ?? `${providerName} 执行失败`,
        });
      }
    }),
  ]).then(() => {
    aiEventsInitialized = true;
  });
  return aiEventsInitPromise;
}

async function initWorkspaceEventListeners() {
  if (workspaceEventsInitialized) return;
  if (workspaceEventsInitPromise) return workspaceEventsInitPromise;
  workspaceEventsInitPromise = tauriApi.onWorkspaceChanged(() => {
    const activeSessionId = activeAiSession.value?.id;
    void loadLocalWorkspace();
    if (activeSessionId) void loadAiSessionHistory(activeSessionId);
  }).then(async () => {
    await tauriApi.onAiHistoryChanged((event) => {
      void loadLocalWorkspace();
      if (activeAiSession.value?.id === event.aiSessionId) {
        void loadAiSessionHistory(event.aiSessionId);
      }
    });
    workspaceEventsInitialized = true;
  });
  return workspaceEventsInitPromise;
}

async function refreshShellLiveState(sessionId: string) {
  try {
    const live = await tauriApi.isShellLive(sessionId);
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
  await tauriApi.appendLocalAiMessage(sessionId, "assistant", text);
  assistantDrafts.set(sessionId, { ...draft, savedText: text });
}

function renameUntitledSession(sessionId: string, prompt: string) {
  const title = sessionTitleFromPrompt(prompt);
  const untitledNames = new Set(["新的 AI CLI 会话", "接管已有 AI CLI 会话"]);
  const updatedAt = new Date().toISOString();
  aiSessions.value = aiSessions.value.map((session) => {
    if (session.id !== sessionId) return session;
    return { ...session, title: untitledNames.has(session.title) ? title : session.title, updatedAt };
  }).sort(sortSessionsByUpdatedAt);
  if (activeAiSession.value?.id === sessionId) {
    const nextTitle = untitledNames.has(activeAiSession.value.title) ? title : activeAiSession.value.title;
    activeAiSession.value = { ...activeAiSession.value, title: nextTitle, updatedAt };
    aiSessionTitle.value = nextTitle;
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
    const session = await tauriApi.archiveLocalAiSession(sessionId, archived);
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
    const updated = await tauriApi.renameLocalAiSession(session.id, trimmed);
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
    await tauriApi.openSessionInNewWindow(session.id);
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

async function pairDesktop(server: string, code: string) {
  const trimmedServer = server.trim();
  const trimmedCode = code.trim();
  pairResult.value = "正在配对...";
  pairResultError.value = false;
  if (!trimmedServer || !trimmedCode) {
    pairResult.value = "请先填写服务器地址和移动端配对码。";
    pairResultError.value = true;
    return;
  }
  try {
    const value = await tauriApi.pairDesktop(trimmedServer, trimmedCode);
    pairResult.value = JSON.stringify(value, null, 2);
    pairResultError.value = false;
    settingsServer.value = trimmedServer;
    settingsResult.value = `配对配置已保存：${trimmedServer}`;
  } catch (error) {
    pairResult.value = `配对失败：${String(error)}`;
    pairResultError.value = true;
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
    const status = await tauriApi.getDesktopPairingStatus(server, code);
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
    const request = await tauriApi.createDesktopPairingRequest(trimmedServer);
    const payload = await tauriApi.buildDesktopPairingQrPayload(trimmedServer, request.code);
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
    const update = await tauriApi.checkAppUpdate();
    if (!update.available) {
      updateAvailableVersion.value = "";
      updateResult.value = "当前已经是最新版本。";
      return;
    }
    updateAvailableVersion.value = update.version ?? "";
    updateResult.value = `发现新版本 ${update.version ?? ""}${update.currentVersion ? `（当前 ${update.currentVersion}）` : ""}。`;
  } catch (error) {
    updateResultError.value = true;
    updateResult.value = `检查更新失败：${String(error)}`;
  } finally {
    updateChecking.value = false;
  }
}

async function installAppUpdate() {
  updateInstalling.value = true;
  updateResultError.value = false;
  updateResult.value = "正在下载并安装更新...";
  try {
    const installed = await tauriApi.installAppUpdate();
    if (!installed) {
      updateAvailableVersion.value = "";
      updateResult.value = "没有可安装的更新。";
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
    updateAvailableVersion,
    chatMessages,
    chatDebugEvents,
    activeChatRunState,
    activeChatIsRunning,
    pinnedSessionIds,
    unreadSessionIds,
    shellBuffers,
    liveShellSessions,
    thinkingSessionIds,
    activeSessions,
    archivedSessions,
    refreshWorkspace,
    loadProviders,
    loadLocalWorkspace,
    detectProviders,
    refreshTerminalSessions,
    chooseProject,
    addProject,
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
    setActiveAiSession,
    selectAiSessionFromDropdown,
    loadAiSessionHistory,
    sendPrompt,
    sendShellInput,
    resizeShell,
    archiveAiSession,
    renameAiSession,
    isSessionPinned,
    toggleSessionPinned,
    isSessionUnread,
    markSessionUnread,
    markSessionRead,
    openAiSessionInNewWindow,
    deriveSessionToLocal,
    pairDesktop,
    createQrPairingRequest,
    saveSettings,
    checkAppUpdate,
    installAppUpdate,
    switchView,
  };
}
