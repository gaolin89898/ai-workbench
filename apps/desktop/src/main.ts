import { invoke } from "@tauri-apps/api/core";
import "./style.css";

type ViewName = "workspace" | "projects" | "aiSessions" | "providers" | "pairing" | "settings";

type TerminalSession = {
  sessionId: string;
  name: string;
  backend: "tmux" | "screen";
  tool: string;
  status: string;
  cwd?: string | null;
  recentOutput?: string | null;
};

type AiProvider = {
  id: string;
  name: string;
  command: string;
  builtIn: boolean;
  enabled: boolean;
};

type ProviderStatus = {
  providerId: string;
  installed: boolean;
  version?: string | null;
  authStatus: string;
  lastCheckedAt: string;
};

type WorkspaceProject = {
  id: string;
  name: string;
  path: string;
  gitBranch?: string | null;
  gitDirty: boolean;
};

type AiSession = {
  id: string;
  providerId: string;
  terminalSessionId?: string | null;
  title: string;
  status: string;
  summary?: string | null;
};

type PairResponse = {
  deviceId?: string;
  device_id?: string;
  accessToken?: string;
  access_token?: string;
};

type ChatMessage = {
  role: "user" | "assistant" | "system" | "error";
  text: string;
};

type AiHistoryMessage = {
  role: "user" | "assistant" | "system" | "error";
  content: string;
  createdAt: string;
};

const providers = new Map<string, AiProvider>();
let providerStatuses: ProviderStatus[] = [];
let projects: WorkspaceProject[] = [];
let aiSessions: AiSession[] = [];
let terminalSessions: TerminalSession[] = [];
let activeAiSession: AiSession | null = null;
let chatMessages: ChatMessage[] = [
  { role: "system", text: "创建或接管一个 AI 会话后，这里会变成聊天界面。" },
];

const providerList = document.querySelector<HTMLDivElement>("#providerList");
const workspaceProviders = document.querySelector<HTMLDivElement>("#workspaceProviders");
const workspaceSessions = document.querySelector<HTMLDivElement>("#workspaceSessions");
const workspaceProjects = document.querySelector<HTMLDivElement>("#workspaceProjects");
const projectConversationTree = document.querySelector<HTMLDivElement>("#projectConversationTree");
const chatProjectSelect = document.querySelector<HTMLSelectElement>("#chatProjectSelect");
const aiSessionSelect = document.querySelector<HTMLSelectElement>("#aiSessionSelect");
const chatProjectSummary = document.querySelector<HTMLDivElement>("#chatProjectSummary");
const providerSelect = document.querySelector<HTMLSelectElement>("#aiProvider");
const terminalSessionSelect = document.querySelector<HTMLSelectElement>("#terminalSessionId");
const chatContextBar = document.querySelector<HTMLDivElement>("#chatContextBar");
const createAiResult = document.querySelector<HTMLDivElement>("#createAiResult");
const terminalSessionList = document.querySelector<HTMLDivElement>("#terminalSessionList");
const projectList = document.querySelector<HTMLDivElement>("#projectList");
const workspaceGit = document.querySelector<HTMLDivElement>("#workspaceGit");
const providerCount = document.querySelector<HTMLElement>("#providerCount");
const providerSummary = document.querySelector<HTMLElement>("#providerSummary");
const projectCount = document.querySelector<HTMLElement>("#projectCount");
const aiSessionCount = document.querySelector<HTMLElement>("#aiSessionCount");
const aiChatPreview = document.querySelector<HTMLDivElement>("#aiChatPreview");
const chatHeaderProject = document.querySelector<HTMLElement>("#chatHeaderProject");
const chatHeaderMeta = document.querySelector<HTMLElement>("#chatHeaderMeta");
const chatTitle = document.querySelector<HTMLElement>("#chatTitle");
const chatStatus = document.querySelector<HTMLElement>("#chatStatus");
const chatPrompt = document.querySelector<HTMLTextAreaElement>("#chatPrompt");
const settingsServer = document.querySelector<HTMLInputElement>("#settingsServer");
const settingsResult = document.querySelector<HTMLDivElement>("#settingsResult");

async function refreshWorkspace() {
  await Promise.all([loadProviders(), loadLocalWorkspace(), detectProviders(), refreshTerminalSessions()]);
  renderAll();
}

async function loadProviders() {
  const values = await invoke<AiProvider[]>("list_ai_providers");
  providers.clear();
  for (const provider of values) providers.set(provider.id, provider);
}

async function loadLocalWorkspace() {
  const [storedProjects, storedSessions] = await Promise.all([
    invoke<WorkspaceProject[]>("list_workspace_projects"),
    invoke<AiSession[]>("list_local_ai_sessions"),
  ]);
  projects = storedProjects;
  aiSessions = storedSessions;
  if (!activeAiSession && aiSessions.length) {
    activeAiSession = aiSessions[0];
    syncChatControlsWithSession(activeAiSession);
  }
}

async function detectProviders() {
  providerStatuses = await invoke<ProviderStatus[]>("detect_ai_providers");
  renderAll();
}

async function refreshTerminalSessions() {
  terminalSessions = await invoke<TerminalSession[]>("list_sessions");
  renderTerminalSessions();
}

async function addProject() {
  const path = document.querySelector<HTMLInputElement>("#projectPath")?.value.trim() ?? "";
  const result = document.querySelector<HTMLDivElement>("#projectResult");
  if (!path) {
    if (result) result.textContent = "请填写项目目录。";
    return;
  }
  try {
    const project = await invoke<WorkspaceProject>("add_workspace_project", { path });
    registerProject(project);
    if (result) result.textContent = JSON.stringify(project, null, 2);
  } catch (error) {
    if (result) result.textContent = `添加失败：${String(error)}`;
  }
}

async function chooseProject() {
  const result = document.querySelector<HTMLDivElement>("#projectResult");
  if (result) result.textContent = "正在打开文件夹选择器...";
  try {
    const project = await invoke<WorkspaceProject | null>("choose_workspace_project");
    if (!project) {
      if (result) result.textContent = "已取消选择。";
      return;
    }
    registerProject(project);
    if (result) result.textContent = JSON.stringify(project, null, 2);
    switchView("aiSessions");
  } catch (error) {
    if (result) result.textContent = `选择失败：${String(error)}`;
  }
}

function registerProject(project: WorkspaceProject) {
  projects = [project, ...projects.filter((item) => item.path !== project.path)];
  const projectPath = document.querySelector<HTMLInputElement>("#projectPath");
  const aiProjectPath = document.querySelector<HTMLInputElement>("#aiProjectPath");
  if (projectPath) projectPath.value = project.path;
  if (aiProjectPath) aiProjectPath.value = project.path;
  if (chatProjectSelect) chatProjectSelect.value = project.path;
  renderAll();
}

async function createAiSession(): Promise<AiSession | null> {
  const result = document.querySelector<HTMLDivElement>("#createAiResult");
  const projectPath = getSelectedProjectPath();
  const providerId = providerSelect?.value ?? "codex";
  const creationMode = document.querySelector<HTMLSelectElement>("#creationMode")?.value ?? "auto";
  const terminalSessionId = terminalSessionSelect?.value || null;
  const titleInput = document.querySelector<HTMLInputElement>("#aiSessionTitle");
  const title = titleInput?.value.trim() || "新的 AI CLI 会话";
  if (!projectPath) {
    if (result) {
      result.textContent = "请先在左侧选择一个本地项目。";
      result.classList.add("error");
    }
    return null;
  }
  try {
    const session = await invoke<AiSession>("create_ai_session", {
      req: { providerId, projectPath, title, creationMode, terminalSessionId },
    });
    aiSessions = [session, ...aiSessions];
    await setActiveAiSession(session);
    if (result) {
      const modeText = creationMode === "attach" ? "已接管已有会话" : "已新建 AI CLI 会话";
      result.textContent = `${modeText}：${session.title}`;
      result.classList.remove("error");
    }
    renderAll();
    return session;
  } catch (error) {
    if (result) {
      result.textContent = `创建失败：${String(error)}`;
      result.classList.add("error");
    }
    return null;
  }
}

async function createAiSessionForProject(path: string) {
  resetChatControlsForNewSession(path);
  switchView("aiSessions");
  await createAiSession();
}

async function chooseProjectForChat() {
  await chooseProject();
  switchView("aiSessions");
}

async function setActiveAiSession(session: AiSession) {
  activeAiSession = session;
  chatMessages = [];
  syncChatControlsWithSession(session);
  switchView("aiSessions");
  renderChat();
  await loadAiSessionHistory(session.id);
}

async function sendPrompt() {
  const prompt = chatPrompt?.value.trim() ?? "";
  if (!prompt) return;
  if (!activeAiSession) {
    chatMessages = [{ role: "error", text: "请先点击左下角的新建按钮，启动一个 Codex/Claude/Gemini/DeepSeek CLI 会话，或选择“接管已有会话”。" }];
    renderChat();
    return;
  }
  if (!activeAiSession.terminalSessionId) {
    chatMessages.push({ role: "error", text: "当前 AI 会话没有绑定底层 tmux/screen 会话。" });
    renderChat();
    return;
  }
  chatMessages.push({ role: "user", text: prompt });
  if (chatPrompt) chatPrompt.value = "";
  renderChat();
  try {
    const output = await invoke<string>("send_ai_prompt", {
      req: {
        aiSessionId: activeAiSession.id,
        terminalSessionId: activeAiSession.terminalSessionId,
        prompt,
      },
    });
    const cleanedOutput = cleanAssistantOutput(output, prompt);
    chatMessages.push({
      role: cleanedOutput ? "assistant" : "system",
      text: cleanedOutput || "消息已发送，AI 可能仍在生成；当前没有捕获到新的可显示回复。",
    });
  } catch (error) {
    chatMessages.push({ role: "error", text: `发送失败：${String(error)}` });
  }
  renderChat();
}

async function loadAiSessionHistory(sessionId: string) {
  try {
    const history = await invoke<AiHistoryMessage[]>("list_local_ai_history", { aiSessionId: sessionId });
    if (activeAiSession?.id !== sessionId) return;
    chatMessages = history.map((message) => ({
      role: message.role,
      text: message.content,
    }));
  } catch (error) {
    chatMessages = [{ role: "error", text: `读取历史失败：${String(error)}` }];
  }
  renderChat();
}

async function pairDesktop() {
  const server = readSharedInput("[data-server-input]");
  const code = readSharedInput("[data-code-input]");
  updatePairResults("正在配对...");
  if (!server || !code) {
    updatePairResults("请先填写服务器地址和移动端配对码。", true);
    return;
  }
  try {
    const value = await invoke<PairResponse>("pair_desktop", { server, code });
    updatePairResults(JSON.stringify(value, null, 2));
    if (settingsServer) settingsServer.value = server;
  } catch (error) {
    updatePairResults(`配对失败：${String(error)}`, true);
  }
}

function renderAll() {
  renderProviderSelect();
  renderProviders();
  renderProjects();
  renderAiSessions();
  renderAiSessionSelect();
  renderProjectConversationTree();
  renderTerminalSessions();
  if (activeAiSession) syncChatControlsWithSession(activeAiSession);
  updateCreationModeVisibility();
  renderMetrics();
}

function renderMetrics() {
  const installed = providerStatuses.filter((item) => item.installed).length;
  if (providerCount) providerCount.textContent = String(providerStatuses.length || providers.size);
  if (providerSummary) providerSummary.textContent = `${installed} 个可用`;
  if (projectCount) projectCount.textContent = String(projects.length);
  if (aiSessionCount) aiSessionCount.textContent = String(aiSessions.length);
}

function renderProviderSelect() {
  if (!providerSelect) return;
  providerSelect.innerHTML = [...providers.values()]
    .map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`)
    .join("");
}

function renderProviders() {
  const items = providerStatuses.length
    ? providerStatuses
    : [...providers.values()].map((provider) => ({
        providerId: provider.id,
        installed: false,
        version: "等待检测",
        authStatus: "unknown",
        lastCheckedAt: "",
      }));
  const html = items
    .map((status) => {
      const provider = providers.get(status.providerId);
      return `
        <article class="provider-card">
          <div>
            <strong>${escapeHtml(provider?.name ?? status.providerId)}</strong>
            <p>${escapeHtml(status.version ?? provider?.command ?? "未检测")}</p>
          </div>
          <span class="badge ${status.installed ? "success" : "warning"}">${status.installed ? "可用" : "未安装"}</span>
        </article>
      `;
    })
    .join("");
  if (providerList) providerList.innerHTML = html || `<div class="empty-state">暂无 Provider。</div>`;
  if (workspaceProviders) workspaceProviders.innerHTML = html || `<div class="empty-state">暂无 Provider。</div>`;
}

function renderProjects() {
  const html = projects
    .map(
      (project) => `
        <article class="compact-row project-row">
          <div class="compact-main">
            <strong>${escapeHtml(project.name)}</strong>
            <p>${escapeHtml(project.path)}</p>
          </div>
          <div class="row-actions">
            <span class="badge ${project.gitDirty ? "warning" : "success"}">${project.gitDirty ? "有变更" : "干净"}</span>
            <button class="button secondary mini" data-project-action="create" data-project-path="${escapeHtml(project.path)}" type="button">创建会话</button>
            <button class="button secondary mini" data-project-action="attach" data-project-path="${escapeHtml(project.path)}" type="button">接管会话</button>
          </div>
        </article>
      `,
    )
    .join("");
  const empty = `<div class="empty-state">还没有项目。先添加本机项目目录，再创建或接管 AI 会话。</div>`;
  if (projectList) projectList.innerHTML = html || empty;
  if (workspaceProjects) workspaceProjects.innerHTML = html || empty;
  renderChatProjectSelect();
  bindProjectActions(projectList);
  bindProjectActions(workspaceProjects);
  if (workspaceGit) {
    const project = projects[0];
    workspaceGit.textContent = project
      ? `${project.name} · ${project.gitBranch ?? "未知分支"} · ${project.gitDirty ? "有变更" : "Git 干净"}`
      : "添加项目后显示 Git 状态。";
  }
}

function renderProjectConversationTree() {
  if (!projectConversationTree) return;
  if (!projects.length) {
    projectConversationTree.innerHTML = `
      <button class="tree-empty" data-sidebar-choose-project type="button">选择本地项目</button>
    `;
    projectConversationTree.querySelector<HTMLButtonElement>("[data-sidebar-choose-project]")?.addEventListener("click", chooseProjectForChat);
    return;
  }
  projectConversationTree.innerHTML = projects
    .map((project) => {
      const sessions = aiSessions.filter((session) => session.summary === project.path);
      const sessionItems = sessions.length
        ? sessions
            .map(
              (session) => `
                <button class="tree-chat ${activeAiSession?.id === session.id ? "active" : ""}" data-sidebar-session-id="${escapeHtml(session.id)}" type="button">
                  <span>${escapeHtml(session.title)}</span>
                  <small>${escapeHtml(providers.get(session.providerId)?.name ?? session.providerId)}</small>
                </button>
              `,
            )
            .join("")
        : `<button class="tree-chat muted" data-sidebar-new-chat="${escapeHtml(project.path)}" type="button">新建 CLI 会话</button>`;
      return `
        <section class="tree-project">
          <div class="tree-project-row">
            <button class="tree-project-title" data-sidebar-project-path="${escapeHtml(project.path)}" type="button">
              <span>▱</span>
              <strong>${escapeHtml(project.name)}</strong>
            </button>
            <button class="tree-project-add" data-sidebar-create-session="${escapeHtml(project.path)}" title="新建 AI CLI 会话" type="button">＋</button>
          </div>
          <div class="tree-chat-list">${sessionItems}</div>
        </section>
      `;
    })
    .join("");
  projectConversationTree.querySelectorAll<HTMLButtonElement>("[data-sidebar-project-path]").forEach((button) => {
    button.addEventListener("click", () => {
      selectProjectPath(button.dataset.sidebarProjectPath ?? "");
      switchView("aiSessions");
    });
  });
  projectConversationTree.querySelectorAll<HTMLButtonElement>("[data-sidebar-new-chat]").forEach((button) => {
    button.addEventListener("click", () => {
      resetChatControlsForNewSession(button.dataset.sidebarNewChat ?? "");
      switchView("aiSessions");
    });
  });
  projectConversationTree.querySelectorAll<HTMLButtonElement>("[data-sidebar-create-session]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      createAiSessionForProject(button.dataset.sidebarCreateSession ?? "");
    });
  });
  projectConversationTree.querySelectorAll<HTMLButtonElement>("[data-sidebar-session-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const session = aiSessions.find((item) => item.id === button.dataset.sidebarSessionId);
      if (session) setActiveAiSession(session);
    });
  });
}

function selectProjectPath(path: string) {
  if (chatProjectSelect) chatProjectSelect.value = path;
  const projectPathInput = document.querySelector<HTMLInputElement>("#aiProjectPath");
  if (projectPathInput) projectPathInput.value = path;
  updateChatProjectContext();
}

function getSelectedProjectPath() {
  return (
    chatProjectSelect?.value.trim() ||
    document.querySelector<HTMLInputElement>("#aiProjectPath")?.value.trim() ||
    ""
  );
}

function renderChatProjectSelect() {
  if (!chatProjectSelect) return;
  const current = chatProjectSelect.value || document.querySelector<HTMLInputElement>("#aiProjectPath")?.value || "";
  chatProjectSelect.innerHTML = projects.length
    ? `<option value="">请选择项目</option>${projects
        .map((project) => `<option value="${escapeHtml(project.path)}">${escapeHtml(project.name)} · ${escapeHtml(project.path)}</option>`)
        .join("")}`
    : `<option value="">先选择本地项目</option>`;
  if (current && projects.some((project) => project.path === current)) {
    chatProjectSelect.value = current;
  }
  updateChatProjectContext();
}

function renderAiSessionSelect() {
  if (!aiSessionSelect) return;
  const projectPath = getSelectedProjectPath();
  const visibleSessions = projectPath
    ? aiSessions.filter((session) => session.summary === projectPath)
    : aiSessions;
  aiSessionSelect.innerHTML = [
    `<option value="">新建会话</option>`,
    ...visibleSessions.map(
      (session) =>
        `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`,
    ),
  ].join("");
  aiSessionSelect.value = activeAiSession?.id ?? "";
}

function updateChatProjectContext() {
  const path = chatProjectSelect?.value ?? "";
  const projectPathInput = document.querySelector<HTMLInputElement>("#aiProjectPath");
  if (projectPathInput && path) projectPathInput.value = path;
  if (activeAiSession && path && activeAiSession.summary !== path) {
    activeAiSession = null;
    chatMessages = [];
    const titleInput = document.querySelector<HTMLInputElement>("#aiSessionTitle");
    if (titleInput) titleInput.value = "新的 AI CLI 会话";
    if (terminalSessionSelect) terminalSessionSelect.value = "";
  }
  const project = projects.find((item) => item.path === path);
  if (chatHeaderProject) chatHeaderProject.textContent = project?.name ?? "未选择项目";
  if (chatHeaderMeta) {
    chatHeaderMeta.textContent = project
      ? `${project.gitBranch ?? "未知分支"} · ${project.gitDirty ? "有变更" : "Git 干净"}`
      : "选择项目后开始聊天";
  }
  if (chatProjectSummary) {
    chatProjectSummary.textContent = project
      ? `${project.name}\n${project.path}\n${project.gitBranch ?? "未知分支"} · ${project.gitDirty ? "有变更" : "Git 干净"}`
      : "还没有选择项目。";
  }
  renderAiSessionSelect();
}

function syncChatControlsWithSession(session: AiSession) {
  const titleInput = document.querySelector<HTMLInputElement>("#aiSessionTitle");
  const projectPathInput = document.querySelector<HTMLInputElement>("#aiProjectPath");
  const modeSelect = document.querySelector<HTMLSelectElement>("#creationMode");

  if (titleInput) titleInput.value = session.title;
  if (aiSessionSelect) aiSessionSelect.value = session.id;
  if (providerSelect) providerSelect.value = session.providerId;
  if (terminalSessionSelect && session.terminalSessionId) terminalSessionSelect.value = session.terminalSessionId;
  if (modeSelect) modeSelect.value = session.terminalSessionId ? "attach" : "auto";

  if (session.summary) {
    if (chatProjectSelect) chatProjectSelect.value = session.summary;
    if (projectPathInput) projectPathInput.value = session.summary;
  }

  updateCreationModeVisibility();
  updateChatProjectContext();
}

function resetChatControlsForNewSession(path: string) {
  const titleInput = document.querySelector<HTMLInputElement>("#aiSessionTitle");
  const projectPathInput = document.querySelector<HTMLInputElement>("#aiProjectPath");
  const modeSelect = document.querySelector<HTMLSelectElement>("#creationMode");

  activeAiSession = null;
  chatMessages = [];
  if (titleInput) titleInput.value = "新的 AI CLI 会话";
  if (aiSessionSelect) aiSessionSelect.value = "";
  if (projectPathInput) projectPathInput.value = path;
  if (chatProjectSelect) chatProjectSelect.value = path;
  if (modeSelect) modeSelect.value = "auto";
  if (terminalSessionSelect) terminalSessionSelect.value = "";
  updateCreationModeVisibility();
  updateChatProjectContext();
  renderChat();
}

function selectAiSessionFromDropdown() {
  const sessionId = aiSessionSelect?.value ?? "";
  if (!sessionId) {
    resetChatControlsForNewSession(getSelectedProjectPath());
    return;
  }
  const session = aiSessions.find((item) => item.id === sessionId);
  if (session) setActiveAiSession(session);
}

function updateCreationModeVisibility() {
  const mode = document.querySelector<HTMLSelectElement>("#creationMode")?.value ?? "auto";
  chatContextBar?.classList.toggle("attach-mode", mode === "attach");
  chatContextBar?.classList.toggle("history-mode", Boolean(activeAiSession));
  if (createAiResult) {
    createAiResult.hidden = Boolean(activeAiSession);
  }
}

function bindProjectActions(container: HTMLElement | null) {
  container?.querySelectorAll<HTMLButtonElement>("[data-project-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const path = button.dataset.projectPath ?? "";
      const action = button.dataset.projectAction ?? "create";
      const projectPathInput = document.querySelector<HTMLInputElement>("#aiProjectPath");
      const modeSelect = document.querySelector<HTMLSelectElement>("#creationMode");
      activeAiSession = null;
      chatMessages = [];
      const titleInput = document.querySelector<HTMLInputElement>("#aiSessionTitle");
      if (titleInput) titleInput.value = action === "attach" ? "接管已有 AI CLI 会话" : "新的 AI CLI 会话";
      if (projectPathInput) projectPathInput.value = path;
      if (chatProjectSelect) chatProjectSelect.value = path;
      if (modeSelect) modeSelect.value = action === "attach" ? "attach" : "auto";
      updateChatProjectContext();
      updateCreationModeVisibility();
      renderChat();
      switchView("aiSessions");
    });
  });
}

function renderAiSessions() {
  const html = aiSessions
    .map(
      (session) => `
        <article class="session-card ${activeAiSession?.id === session.id ? "selected" : ""}" data-ai-session-id="${escapeHtml(session.id)}">
          <div class="session-icon">AI</div>
          <div class="session-copy">
            <div class="session-title">
              <strong>${escapeHtml(session.title)}</strong>
              <span>${escapeHtml(providers.get(session.providerId)?.name ?? session.providerId)}</span>
            </div>
            <p>${escapeHtml(session.summary ?? session.terminalSessionId ?? "本地 AI 会话")}</p>
          </div>
          <div class="session-state"><span class="status-dot online"></span><span>${escapeHtml(statusText(session.status))}</span></div>
        </article>
      `,
    )
    .join("");
  if (workspaceSessions) workspaceSessions.innerHTML = html || `<div class="empty-state">还没有 AI 会话。</div>`;
  workspaceSessions?.querySelectorAll<HTMLElement>("[data-ai-session-id]").forEach((card) => {
    card.addEventListener("click", () => {
      const session = aiSessions.find((item) => item.id === card.dataset.aiSessionId);
      if (session) setActiveAiSession(session);
    });
  });
  renderProjectConversationTree();
  renderChat();
}

function renderChat() {
  if (chatTitle) chatTitle.textContent = activeAiSession?.title ?? "AI 聊天";
  if (chatStatus) {
    chatStatus.textContent = activeAiSession ? statusText(activeAiSession.status) : "未创建";
    chatStatus.classList.toggle("success", Boolean(activeAiSession));
  }
  if (!aiChatPreview) return;
  if (!activeAiSession && chatMessages.length === 1 && chatMessages[0]?.role === "system") {
    aiChatPreview.innerHTML = `
      <div class="chat-welcome">
        <h2>从一个项目启动 AI CLI</h2>
        <p>左侧选择本地项目，再点击左下角的新建按钮启动 Codex/Claude/Gemini/DeepSeek CLI。已有 tmux/screen 会话可以在顶部切换为“接管已有会话”。</p>
      </div>
    `;
    return;
  }
  if (activeAiSession && !chatMessages.length) {
    aiChatPreview.innerHTML = `
      <div class="chat-welcome">
        <h2>${escapeHtml(activeAiSession.title)}</h2>
        <p>AI CLI 会话已连接。现在输入 prompt，会发送到底层 tmux/screen 中的真实 CLI 进程。</p>
      </div>
    `;
    return;
  }
  aiChatPreview.innerHTML = chatMessages
    .map(
      (message) => `
        <div class="chat-preview-row ${message.role}">
          <span>${message.role === "user" ? "你" : message.role === "assistant" ? "AI" : message.role === "error" ? "!" : "i"}</span>
          <p>${escapeHtml(formatChatMessageText(message.text))}</p>
        </div>
      `,
    )
    .join("");
  aiChatPreview.scrollTop = aiChatPreview.scrollHeight;
}

function renderTerminalSessions() {
  if (terminalSessionSelect) {
    terminalSessionSelect.innerHTML = terminalSessions.length
      ? `<option value="">请选择已有会话</option>${terminalSessions
          .map(
            (session) =>
              `<option value="${escapeHtml(session.sessionId)}">${escapeHtml(session.name)} · ${escapeHtml(session.sessionId)} · ${escapeHtml(session.cwd ?? session.backend)}</option>`,
          )
          .join("")}`
      : `<option value="">未发现 tmux/screen 会话</option>`;
  }
  if (!terminalSessionList) return;
  terminalSessionList.innerHTML =
    terminalSessions
      .map(
        (session) => `
          <article class="compact-row">
            <div>
              <strong>${escapeHtml(session.name)} · ${escapeHtml(session.sessionId)}</strong>
              <p>${escapeHtml([session.cwd, session.recentOutput].filter(Boolean).join(" · ") || session.backend)}</p>
            </div>
            <button class="button secondary mini" data-terminal-attach="${escapeHtml(session.sessionId)}" data-terminal-path="${escapeHtml(session.cwd ?? "")}" type="button">接管</button>
          </article>
        `,
      )
      .join("") || `<div class="empty-state">没有发现 tmux/screen 会话。</div>`;
  terminalSessionList.querySelectorAll<HTMLButtonElement>("[data-terminal-attach]").forEach((button) => {
    button.addEventListener("click", () => {
      const projectPathInput = document.querySelector<HTMLInputElement>("#aiProjectPath");
      const modeSelect = document.querySelector<HTMLSelectElement>("#creationMode");
      if (terminalSessionSelect) terminalSessionSelect.value = button.dataset.terminalAttach ?? "";
      if (projectPathInput && button.dataset.terminalPath) projectPathInput.value = button.dataset.terminalPath;
      if (modeSelect) modeSelect.value = "attach";
    });
  });
}

function saveSettings() {
  const server = settingsServer?.value.trim() ?? "";
  if (settingsResult) {
    settingsResult.textContent = `已在本地预览保存。云端：${server || "未设置"}；完整历史仍保存在本机 SQLite。`;
  }
}

function switchView(nextView: ViewName) {
  document.querySelectorAll<HTMLButtonElement>(".nav-item[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === nextView);
  });
  document.querySelectorAll<HTMLElement>("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === nextView);
  });
}

function readSharedInput(selector: string) {
  return Array.from(document.querySelectorAll<HTMLInputElement>(selector))
    .find((input) => input.value.trim())
    ?.value.trim() ?? "";
}

function updatePairResults(message: string, isError = false) {
  document.querySelectorAll<HTMLDivElement>("[data-pair-result]").forEach((result) => {
    result.textContent = message;
    result.classList.toggle("error", isError);
  });
}

function statusText(status: string) {
  const names: Record<string, string> = {
    running: "运行中",
    idle: "空闲",
    completed: "完成",
    failed: "失败",
    missing: "不存在",
  };
  return names[status] ?? status;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}

function cleanAssistantOutput(output: string, prompt: string) {
  const normalizedPrompt = normalizeChatText(prompt);
  return output
    .split(/\r?\n/)
    .filter((line) => {
      const normalizedLine = normalizeChatText(line);
      return (
        normalizedLine &&
        normalizedLine !== normalizedPrompt &&
        normalizedLine !== `> ${normalizedPrompt}` &&
        !isTerminalStatusLine(normalizedLine)
      );
    })
    .join("\n")
    .trim();
}

function formatChatMessageText(text: string) {
  const lines = text.split(/\r?\n/);
  const visibleLines = lines.filter((line) => !isToolTraceLine(normalizeChatText(line)));
  const hasToolTrace = visibleLines.length !== lines.length;
  const content = visibleLines.join("\n").trim();
  if (hasToolTrace && !content) return "思考中";
  if (hasToolTrace) return `${content}\n\n思考中`;
  return text;
}

function normalizeChatText(value: string) {
  return value.replace(/^[>›$❯❮┃|│\s]+/, "").trim();
}

function isTerminalStatusLine(value: string) {
  return (
    value.includes("Working") ||
    value.includes("esc to interrupt") ||
    value.startsWith("Use /skills") ||
    value.startsWith("/ for commands") ||
    value.startsWith("! for shell commands") ||
    value.startsWith("gpt-") ||
    value.startsWith("model:") ||
    value.startsWith("directory:") ||
    value.startsWith("Tip:")
  );
}

function isToolTraceLine(value: string) {
  return (
    value === "Explored" ||
    value.startsWith("Read ") ||
    value.startsWith("List ") ||
    value.startsWith("Bash ") ||
    value.startsWith("Edit ") ||
    value.startsWith("Search ") ||
    value.startsWith("Grep ") ||
    value.startsWith("Open ") ||
    value.startsWith("Run ") ||
    value.startsWith("└") ||
    value.startsWith("├") ||
    value.startsWith("│") ||
    value.startsWith("• Explored")
  );
}

document.querySelectorAll<HTMLButtonElement>(".nav-item[data-view], [data-view-shortcut]").forEach((button) => {
  button.addEventListener("click", () => switchView((button.dataset.view ?? button.dataset.viewShortcut) as ViewName));
});
document.querySelector<HTMLButtonElement>("#refreshWorkspace")?.addEventListener("click", refreshWorkspace);
document.querySelector<HTMLButtonElement>("#detectProviders")?.addEventListener("click", detectProviders);
document.querySelector<HTMLButtonElement>("#addProject")?.addEventListener("click", addProject);
document.querySelector<HTMLButtonElement>("#chooseProject")?.addEventListener("click", chooseProject);
document.querySelector<HTMLButtonElement>("#chooseProjectInPanel")?.addEventListener("click", chooseProject);
document.querySelector<HTMLButtonElement>("#chooseProjectForChat")?.addEventListener("click", chooseProjectForChat);
chatProjectSelect?.addEventListener("change", updateChatProjectContext);
aiSessionSelect?.addEventListener("change", selectAiSessionFromDropdown);
document.querySelector<HTMLSelectElement>("#creationMode")?.addEventListener("change", updateCreationModeVisibility);
document.querySelector<HTMLButtonElement>("#refreshAttachSessions")?.addEventListener("click", refreshTerminalSessions);
document.querySelector<HTMLButtonElement>("#createAiSession")?.addEventListener("click", createAiSession);
document.querySelector<HTMLButtonElement>("#startAiSession")?.addEventListener("click", createAiSession);
document.querySelector<HTMLButtonElement>("#sendPrompt")?.addEventListener("click", sendPrompt);
chatPrompt?.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    sendPrompt();
  }
});
document.querySelector<HTMLButtonElement>("#saveSettings")?.addEventListener("click", saveSettings);
document.querySelectorAll<HTMLButtonElement>("[data-pair-button]").forEach((button) => {
  button.addEventListener("click", pairDesktop);
});

refreshWorkspace().catch((error) => {
  if (workspaceSessions) workspaceSessions.innerHTML = `<div class="empty-state error">初始化失败：${escapeHtml(String(error))}</div>`;
});
