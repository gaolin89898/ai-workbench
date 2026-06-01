<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatView from "./components/ChatView.vue";
import PairingView from "./components/PairingView.vue";
import ProjectsView from "./components/ProjectsView.vue";
import ProvidersView from "./components/ProvidersView.vue";
import SettingsView from "./components/SettingsView.vue";
import SidebarProjectTree from "./components/SidebarProjectTree.vue";
import WorkspaceView from "./components/WorkspaceView.vue";
import { cleanAssistantOutput } from "./utils/chat";
import { tauriApi, type AiProvider, type AiSession, type ChatMessage, type ProviderStatus, type TerminalSession, type ViewName, type WorkspaceProject } from "./services/tauri";

const providers = ref<AiProvider[]>([]);
const providerStatuses = ref<ProviderStatus[]>([]);
const projects = ref<WorkspaceProject[]>([]);
const aiSessions = ref<AiSession[]>([]);
const terminalSessions = ref<TerminalSession[]>([]);
const activeAiSession = ref<AiSession | null>(null);
const showArchivedSessions = ref(false);
const route = useRoute();
const router = useRouter();
const selectedProjectPath = ref("");
const selectedProviderId = ref("codex");
const selectedCreationMode = ref("auto");
const selectedTerminalSessionId = ref("");
const aiSessionTitle = ref("新的 AI CLI 会话");
const createAiResult = ref("选择项目和 AI 工具后，先新建一个真实 CLI 会话，或接管已有 tmux/screen 会话。");
const createAiError = ref(false);
const projectResult = ref("请选择一个本机项目目录。");
const projectResultError = ref(false);
const pairResult = ref("配对成功后显示 device_id 与 token 摘要。");
const pairResultError = ref(false);
const settingsServer = ref("http://127.0.0.1:8080");
const settingsResult = ref("尚未保存");
const chatMessages = ref<ChatMessage[]>([
  { role: "system", text: "创建或接管一个 AI 会话后，这里会变成聊天界面。" },
]);

const activeSessions = computed(() => aiSessions.value.filter((session) => !session.archivedAt));
const archivedSessions = computed(() => aiSessions.value.filter((session) => session.archivedAt));
const routeToView = computed<ViewName>(() => {
  const path = route.path.replace(/^\//, "");
  if (path === "workspace" || path === "projects" || path === "providers" || path === "pairing" || path === "settings") {
    return path;
  }
  return "aiSessions";
});
const activeView = computed<ViewName>(() => routeToView.value);
const isSettingsRoute = computed(() => activeView.value === "settings");

function switchView(view: ViewName) {
  const paths: Record<ViewName, string> = {
    workspace: "/workspace",
    projects: "/projects",
    aiSessions: "/chat",
    providers: "/providers",
    pairing: "/pairing",
    settings: "/settings",
  };
  if (route.path !== paths[view]) void router.push(paths[view]);
}

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
  await Promise.all([loadProviders(), loadLocalWorkspace(), detectProviders(), refreshTerminalSessions()]);
  if (!activeAiSession.value && activeSessions.value.length) {
    await setActiveAiSession(activeSessions.value[0]);
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

function selectProjectPath(path: string) {
  selectedProjectPath.value = path;
  switchView("aiSessions");
}

function resetChatControlsForNewSession(path: string) {
  activeAiSession.value = null;
  chatMessages.value = [];
  aiSessionTitle.value = "新的 AI CLI 会话";
  selectedProjectPath.value = path;
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
  aiSessionTitle.value = "接管已有 AI CLI 会话";
  switchView("aiSessions");
  await createAiSession();
}

function prepareProjectSession(path: string, action: "create" | "attach") {
  activeAiSession.value = null;
  chatMessages.value = [];
  aiSessionTitle.value = action === "attach" ? "接管已有 AI CLI 会话" : "新的 AI CLI 会话";
  selectedProjectPath.value = path;
  selectedCreationMode.value = action === "attach" ? "attach" : "auto";
  selectedTerminalSessionId.value = "";
  switchView("aiSessions");
}

async function createAiSession(): Promise<AiSession | null> {
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
      creationMode: selectedCreationMode.value,
      terminalSessionId: selectedTerminalSessionId.value || null,
    });
    aiSessions.value = [session, ...aiSessions.value.filter((item) => item.id !== session.id)];
    await setActiveAiSession(session);
    createAiResult.value = `${selectedCreationMode.value === "attach" ? "已接管已有会话" : "已新建 AI CLI 会话"}：${session.title}`;
    createAiError.value = false;
    return session;
  } catch (error) {
    createAiResult.value = `创建失败：${String(error)}`;
    createAiError.value = true;
    return null;
  }
}

async function setActiveAiSession(session: AiSession) {
  activeAiSession.value = session;
  syncChatControlsWithSession(session);
  switchView("aiSessions");
  chatMessages.value = [];
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
  const trimmed = prompt.trim();
  if (!trimmed) return;
  if (!activeAiSession.value) {
    chatMessages.value = [{ role: "error", text: "请先点击左下角的新建按钮，启动一个 Codex/Claude/Gemini/DeepSeek CLI 会话，或选择“接管已有会话”。" }];
    return;
  }
  if (activeAiSession.value.archivedAt) {
    chatMessages.value.push({ role: "error", text: "这个会话已归档。请先在“已归档”列表中恢复，再继续发送消息。" });
    return;
  }
  if (!activeAiSession.value.terminalSessionId) {
    chatMessages.value.push({ role: "error", text: "当前 AI 会话没有绑定底层 tmux/screen 会话。" });
    return;
  }
  const sessionId = activeAiSession.value.id;
  const terminalSessionId = activeAiSession.value.terminalSessionId;
  renameUntitledSession(sessionId, trimmed);
  chatMessages.value.push({ role: "user", text: trimmed });
  const assistantMessage: ChatMessage = { role: "assistant", text: "思考中", pending: true };
  chatMessages.value.push(assistantMessage);
  try {
    const output = await tauriApi.sendAiPrompt({
      aiSessionId: sessionId,
      terminalSessionId,
      prompt: trimmed,
    });
    const cleanedOutput = cleanAssistantOutput(output, trimmed);
    assistantMessage.pending = false;
    assistantMessage.role = cleanedOutput ? "assistant" : "system";
    assistantMessage.text = cleanedOutput || "消息已发送，AI 正在处理；暂时没有捕获到新的可显示回复。";
  } catch (error) {
    assistantMessage.pending = false;
    assistantMessage.role = "error";
    assistantMessage.text = `发送失败：${String(error)}`;
  }
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
  } catch (error) {
    pairResult.value = `配对失败：${String(error)}`;
    pairResultError.value = true;
  }
}

function saveSettings() {
  const server = settingsServer.value.trim();
  settingsResult.value = `已在本地预览保存。服务器地址：${server || "未设置"}；完整历史仍保存在本机 SQLite。`;
}

onMounted(() => {
  refreshWorkspace().catch((error) => {
    chatMessages.value = [{ role: "error", text: `初始化失败：${String(error)}` }];
  });
});
</script>

<template>
  <main v-if="isSettingsRoute" class="app-fullscreen">
    <SettingsView
      v-model:server="settingsServer"
      :settings-result="settingsResult"
      :pair-result="pairResult"
      :pair-result-error="pairResultError"
      @save-settings="saveSettings"
      @pair-desktop="pairDesktop"
      @switch-view="switchView"
    />
  </main>

  <main v-else class="app-shell">
    <SidebarProjectTree
      :projects="projects"
      :providers="providers"
      :terminal-sessions="terminalSessions"
      :active-sessions="activeSessions"
      :active-ai-session="activeAiSession"
      :active-view="activeView"
      @choose-project="chooseProject"
      @select-project="selectProjectPath"
      @new-chat="createAiSessionForProject"
      @create-session="createAiSessionForProject"
      @attach-session="attachAiSessionForProject"
      @select-session="setActiveAiSession"
      @archive-session="archiveAiSession"
      @switch-view="switchView"
    />

    <section class="content">
      <WorkspaceView
        v-if="activeView === 'workspace'"
        :providers="providers"
        :provider-statuses="providerStatuses"
        :projects="projects"
        :active-sessions="activeSessions"
        :archived-sessions="archivedSessions"
        :active-ai-session="activeAiSession"
        :show-archived-sessions="showArchivedSessions"
        @refresh-workspace="refreshWorkspace"
        @switch-view="switchView"
        @create-project-session="prepareProjectSession"
        @select-session="setActiveAiSession"
        @archive-session="archiveAiSession"
        @toggle-archived-sessions="showArchivedSessions = !showArchivedSessions"
      />
      <ProjectsView
        v-else-if="activeView === 'projects'"
        :projects="projects"
        :project-result="projectResult"
        :project-result-error="projectResultError"
        @choose-project="chooseProject"
        @add-project="addProject"
        @create-project-session="prepareProjectSession"
      />
      <ChatView
        v-else-if="activeView === 'aiSessions'"
        :projects="projects"
        :active-ai-session="activeAiSession"
        :chat-messages="chatMessages"
        :selected-project-path="selectedProjectPath"
        :create-ai-result="createAiResult"
        :create-ai-error="createAiError"
        @send-prompt="sendPrompt"
      />
      <ProvidersView
        v-else-if="activeView === 'providers'"
        :providers="providers"
        :provider-statuses="providerStatuses"
        @detect-providers="detectProviders"
      />
      <PairingView
        v-else-if="activeView === 'pairing'"
        v-model:server="settingsServer"
        :pair-result="pairResult"
        :pair-result-error="pairResultError"
        @pair-desktop="pairDesktop"
      />
      <SettingsView
        v-else
        v-model:server="settingsServer"
        :settings-result="settingsResult"
        :pair-result="pairResult"
        :pair-result-error="pairResultError"
        @save-settings="saveSettings"
        @pair-desktop="pairDesktop"
        @switch-view="switchView"
      />
    </section>
  </main>
</template>
