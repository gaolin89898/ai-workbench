<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { formatChatMessageText, statusText } from "../utils/chat";
import type { AiSession, ChatMessage, WorkspaceProject } from "../services/tauri";

const props = defineProps<{
  projects: WorkspaceProject[];
  activeAiSession: AiSession | null;
  chatMessages: ChatMessage[];
  selectedProjectPath: string;
  createAiResult: string;
  createAiError: boolean;
}>();

const emit = defineEmits<{
  sendPrompt: [prompt: string];
}>();

const prompt = ref("");
const chatScroll = ref<HTMLDivElement | null>(null);

const currentProject = computed(() => props.projects.find((project) => project.path === props.selectedProjectPath));
const chatHeaderMeta = computed(() => {
  if (!currentProject.value) return "选择项目后开始聊天";
  return `${currentProject.value.gitBranch ?? "未知分支"} · ${currentProject.value.gitDirty ? "有变更" : "Git 干净"}`;
});
const conversationTitle = computed(() => props.activeAiSession?.title ?? currentProject.value?.name ?? "新对话");
const showCreateHint = computed(() => !props.activeAiSession && props.createAiResult);

watch(
  () => props.chatMessages,
  async () => {
    await nextTick();
    if (chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight;
  },
  { deep: true },
);

function send() {
  const value = prompt.value.trim();
  if (!value) return;
  emit("sendPrompt", value);
  prompt.value = "";
}

function onPromptKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <section class="view active" data-view-panel="aiSessions">
    <header class="chat-topbar">
      <div>
        <strong>{{ conversationTitle }}</strong>
        <span>{{ chatHeaderMeta }}</span>
      </div>
      <span class="chat-topbar-status" :class="{ active: Boolean(activeAiSession) }">
        {{ activeAiSession ? statusText(activeAiSession.status) : "未创建" }}
      </span>
    </header>
    <section class="chat-workspace">
      <article class="chat-main-panel">
        <div ref="chatScroll" class="terminal-preview">
          <div v-if="!activeAiSession && chatMessages.length === 1 && chatMessages[0]?.role === 'system'" class="chat-welcome">
            <h2>从一个项目启动 AI CLI</h2>
            <p>左侧选择本地项目，然后点击“新建 CLI 会话”直接启动 Codex/Claude/Gemini/DeepSeek CLI。</p>
          </div>
          <div v-else-if="activeAiSession && !chatMessages.length" class="chat-welcome">
            <h2>{{ activeAiSession.title }}</h2>
            <p>AI CLI 会话已连接。现在输入 prompt，会发送到底层 tmux/screen 中的真实 CLI 进程。</p>
          </div>
          <template v-else>
            <div v-for="(message, index) in chatMessages" :key="`${message.role}-${index}`" class="chat-preview-row" :class="[message.role, { pending: message.pending }]">
              <span>{{ message.role === "user" ? "你" : message.role === "assistant" ? "AI" : message.role === "error" ? "!" : "i" }}</span>
              <p v-if="message.pending" aria-live="polite">
                {{ formatChatMessageText(message.text) }}
                <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
              </p>
              <p v-else>{{ formatChatMessageText(message.text) }}</p>
            </div>
          </template>
        </div>
        <div v-if="showCreateHint" class="chat-toast" :class="{ error: createAiError }">{{ createAiResult }}</div>
        <div class="chat-composer">
          <textarea v-model="prompt" rows="3" placeholder="先新建或接管一个 AI CLI 会话，然后在这里输入 prompt" @keydown="onPromptKeydown"></textarea>
          <button class="button primary" type="button" @click="send">发送</button>
        </div>
      </article>
    </section>
  </section>
</template>
