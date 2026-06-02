<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChatMessageRow from "./ChatMessageRow.vue";
import TerminalView from "./TerminalView.vue";
import { statusText } from "../utils/chat";
import { useWorkspace } from "../composables/useWorkspace";
import type { AiProvider } from "../services/tauri";

const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerDeepseekIcon = new URL("../assets/icons/provider-deepseek.svg", import.meta.url).href;
const providerGeminiIcon = new URL("../assets/icons/provider-gemini.svg", import.meta.url).href;
const ws = useWorkspace();

const prompt = ref("");
const chatScroll = ref<HTMLDivElement | null>(null);
const startPromptBox = ref<HTMLFormElement | null>(null);
const activeTab = ref<"chat" | "terminal" | "logs">("chat");
const startMenuOpen = ref(false);
const builtInProviders: AiProvider[] = [
  { id: "codex", name: "Codex", command: "codex", builtIn: true, enabled: true },
  { id: "claude", name: "Claude Code", command: "claude", builtIn: true, enabled: true },
  { id: "gemini", name: "Gemini", command: "gemini", builtIn: true, enabled: true },
  { id: "deepseek", name: "DeepSeek TUI", command: "deepseek", builtIn: true, enabled: true },
];
const providerOrder = new Map(builtInProviders.map((provider, index) => [provider.id, index]));

const currentProject = computed(() => {
  return ws.projects.value.find((project) => project.path === ws.selectedProjectPath.value)
    ?? ws.projects.value.find((project) => project.path === ws.activeAiSession.value?.summary)
    ?? ws.projects.value[0];
});
const providerChoices = computed(() => {
  const providerMap = new Map<string, AiProvider>();
  for (const provider of builtInProviders) providerMap.set(provider.id, provider);
  for (const provider of ws.providers.value) providerMap.set(provider.id, provider);
  return [...providerMap.values()]
    .filter((provider) => provider.enabled)
    .sort((left, right) => (providerOrder.get(left.id) ?? 99) - (providerOrder.get(right.id) ?? 99));
});
const selectedProvider = computed(() => {
  return providerChoices.value.find((provider) => provider.id === ws.selectedProviderId.value)
    ?? providerChoices.value.find((provider) => provider.id === "codex")
    ?? providerChoices.value[0];
});
const chatHeaderMeta = computed(() => {
  if (!currentProject.value) return "选择项目后开始聊天";
  return `${currentProject.value.gitBranch ?? "未知分支"} · ${currentProject.value.gitDirty ? "有变更" : "Git 干净"}`;
});
const conversationTitle = computed(() => ws.activeAiSession.value?.title ?? currentProject.value?.name ?? "新对话");
const startTitle = computed(() => `我们该在 ${currentProject.value?.name ?? "项目"} 中做什么?`);
const showCreateHint = computed(() => !ws.activeAiSession.value && ws.createAiResult.value);
const providerIcons: Record<string, string> = {
  claude: providerClaudeIcon,
  codex: providerCodexIcon,
  deepseek: providerDeepseekIcon,
  gemini: providerGeminiIcon,
};

function providerIcon(providerId: string) {
  return providerIcons[providerId] ?? providerCodexIcon;
}

function closeStartMenuOnOutsideClick(event: PointerEvent) {
  if (!startMenuOpen.value) return;
  const target = event.target;
  if (target instanceof Node && startPromptBox.value?.contains(target)) return;
  startMenuOpen.value = false;
}

function projectForNewSession() {
  const project = currentProject.value ?? ws.projects.value[0];
  if (project) ws.selectedProjectPath.value = project.path;
  return project;
}

watch(
  () => ws.chatMessages.value,
  async () => {
    await nextTick();
    if (chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight;
  },
  { deep: true },
);

onMounted(() => {
  document.addEventListener("pointerdown", closeStartMenuOnOutsideClick);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeStartMenuOnOutsideClick);
});

async function send() {
  const value = prompt.value.trim();
  if (!value) return;
  prompt.value = "";
  if (!ws.activeAiSession.value) {
    const project = projectForNewSession();
    if (!project) {
      await ws.chooseProject();
      prompt.value = value;
      return;
    }
    ws.selectedProviderId.value = selectedProvider.value?.id ?? "codex";
    const session = await ws.createAiSession();
    if (!session) {
      prompt.value = value;
      return;
    }
  }
  await ws.sendPrompt(value);
}

async function createStartSession(providerId = "codex") {
  startMenuOpen.value = false;
  const project = projectForNewSession();
  if (!project) {
    await ws.chooseProject();
    return;
  }
  await ws.createAiSessionForProject(project.path, providerId);
}

function onPromptKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}
</script>

<template>
  <section class="view active" data-view-panel="aiSessions">
    <section v-if="!ws.activeAiSession.value" class="codex-start">
      <div class="codex-start-inner">
        <h1>{{ startTitle }}</h1>
        <form ref="startPromptBox" class="codex-prompt-box" @submit.prevent="send">
          <textarea
            v-model="prompt"
            rows="2"
            placeholder="输入你想做的事"
            @keydown="onPromptKeydown"
          ></textarea>
          <button class="codex-start-add" title="新建 AI 会话" type="button" @click="startMenuOpen = !startMenuOpen" aria-label="新建 AI 会话"></button>
          <div v-if="startMenuOpen" class="codex-start-menu">
            <span class="codex-start-menu-label">新建 AI 会话</span>
            <button v-for="provider in providerChoices" :key="provider.id" type="button" @click="createStartSession(provider.id)">
              <img :src="providerIcon(provider.id)" alt="" aria-hidden="true" />
              <span>新建 {{ provider.name }} 会话</span>
            </button>
          </div>
          <button class="codex-send-button" :disabled="!prompt.trim() || ws.activeChatIsRunning.value" title="发送" type="submit">↑</button>
        </form>
        <div v-if="ws.createAiError.value && showCreateHint" class="chat-toast start-toast error">{{ ws.createAiResult.value }}</div>
      </div>
    </section>
    <template v-else>
    <header class="chat-topbar">
      <div>
        <strong>{{ conversationTitle }}</strong>
        <span>{{ chatHeaderMeta }}</span>
      </div>
      <span
        class="chat-topbar-status"
        :class="{ active: Boolean(ws.activeAiSession.value), running: ws.activeChatIsRunning.value }"
      >
        {{ ws.activeChatRunState.value?.active ? ws.activeChatRunState.value.title : (ws.activeAiSession.value ? statusText(ws.activeAiSession.value.status) : "未创建") }}
      </span>
    </header>
    <nav class="chat-mode-tabs" aria-label="聊天视图切换">
      <button type="button" :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">聊天</button>
      <button type="button" :class="{ active: activeTab === 'terminal' }" @click="activeTab = 'terminal'">终端</button>
      <button type="button" :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'">
        日志
        <span v-if="ws.activeChatIsRunning.value" class="chat-tab-dot" aria-hidden="true"></span>
      </button>
    </nav>
    <section
      class="chat-workspace"
      :class="{
        'terminal-mode': activeTab === 'terminal' && Boolean(ws.activeAiSession.value),
        'terminal-empty-mode': activeTab === 'terminal' && !ws.activeAiSession.value,
      }"
    >
      <article class="chat-main-panel">
        <div v-if="activeTab === 'chat'" ref="chatScroll" class="terminal-preview">
          <div v-if="!ws.activeAiSession.value && ws.chatMessages.value.length === 1 && ws.chatMessages.value[0]?.role === 'system'" class="chat-welcome">
            <h2>从一个项目开始聊天</h2>
            <p>左侧选择本地项目，然后新建 AI 会话。聊天页使用 Codex，终端页只提供项目 shell。</p>
          </div>
          <div v-else-if="ws.activeAiSession.value && !ws.chatMessages.value.length" class="chat-welcome">
            <h2>{{ ws.activeAiSession.value.title }}</h2>
            <p>会话已连接。现在输入 prompt，会通过 Codex exec 在当前项目中处理。</p>
          </div>
          <template v-else>
            <ChatMessageRow
              v-for="(message, index) in ws.chatMessages.value"
              :key="`${message.role}-${index}`"
              :message="message"
            />
          </template>
        </div>
        <div v-else-if="activeTab === 'terminal'" class="terminal-shell">
          <TerminalView />
        </div>
        <div v-else class="chat-logs-panel">
          <header>
            <div>
              <strong>执行日志</strong>
              <span>{{ ws.activeChatIsRunning.value ? "Codex 正在执行" : "最近一次运行记录" }}</span>
            </div>
            <small>{{ ws.chatDebugEvents.value.length }} 条</small>
          </header>
          <div v-if="ws.activeChatRunState.value" class="chat-log-current" :class="[ws.activeChatRunState.value.phase, { active: ws.activeChatRunState.value.active }]">
            <span class="chat-run-pulse" aria-hidden="true"></span>
            <div>
              <strong>{{ ws.activeChatRunState.value.title }}</strong>
              <p>{{ ws.activeChatRunState.value.detail }}</p>
            </div>
          </div>
          <ol v-if="ws.chatDebugEvents.value.length" class="chat-log-list">
            <li v-for="event in ws.chatDebugEvents.value" :key="event">
              <span>{{ event.slice(0, 8) }}</span>
              <p>{{ event.slice(9) }}</p>
            </li>
          </ol>
          <div v-else class="chat-log-empty">
            <strong>暂无执行日志</strong>
            <p>发送一条消息后，这里会显示保存、启动、连接、执行和完成状态。</p>
          </div>
        </div>
        <div v-if="showCreateHint" class="chat-toast" :class="{ error: ws.createAiError.value }">{{ ws.createAiResult.value }}</div>
        <div v-if="activeTab !== 'logs' && ws.activeChatRunState.value" class="chat-run-panel" :class="[ws.activeChatRunState.value.phase, { active: ws.activeChatRunState.value.active }]">
          <span class="chat-run-pulse" aria-hidden="true"></span>
          <div>
            <strong>{{ ws.activeChatRunState.value.title }}</strong>
            <p>{{ ws.activeChatRunState.value.detail }}</p>
          </div>
        </div>
        <div v-if="activeTab === 'chat'" class="chat-composer">
          <textarea v-model="prompt" rows="3" placeholder="输入你想做的事" @keydown="onPromptKeydown"></textarea>
          <button class="codex-send-button chat-send-button" :disabled="!prompt.trim() || ws.activeChatIsRunning.value" title="发送" type="button" @click="send" aria-label="发送">
            <span v-if="ws.activeChatIsRunning.value" class="chat-send-spinner" aria-hidden="true"></span>
            <span v-else aria-hidden="true">↑</span>
          </button>
        </div>
      </article>
    </section>
    </template>
  </section>
</template>
