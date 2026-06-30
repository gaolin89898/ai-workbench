<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChatMessageRow from "./ChatMessageRow.vue";
import TerminalView from "./TerminalView.vue";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi, type AiProvider, type ChatImageAttachment } from "../services/desktop";

const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerOpencodeIcon = new URL("../assets/icons/provider-opencode.svg", import.meta.url).href;
const sendIcon = new URL("../assets/icons/send.svg", import.meta.url).href;
const imageRemoveIcon = new URL("../assets/icons/image-remove.svg", import.meta.url).href;
const ws = useWorkspace();

const prompt = ref("");
const imageAttachments = ref<ChatImageAttachment[]>([]);
const previewImage = ref<ChatImageAttachment | null>(null);
const chatScroll = ref<HTMLDivElement | null>(null);
const startPromptBox = ref<HTMLFormElement | null>(null);
const activeTab = ref<"chat" | "terminal" | "logs">("chat");
const startMenuOpen = ref(false);
const builtInProviders: AiProvider[] = [
  { id: "codex", name: "Codex", command: "codex", builtIn: true, enabled: true },
  { id: "claude", name: "Claude Code", command: "claude", builtIn: true, enabled: true },
  { id: "opencode", name: "OpenCode", command: "opencode", builtIn: true, enabled: true },
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
const activeProviderName = computed(() => {
  const providerId = ws.activeAiSession.value?.providerId ?? ws.selectedProviderId.value;
  return providerChoices.value.find((provider) => provider.id === providerId)?.name
    ?? builtInProviders.find((provider) => provider.id === providerId)?.name
    ?? "AI";
});

function logEventLevel(event: string): "info" | "success" | "error" {
  const text = event.slice(9);
  if (/失败|错误|中断|异常/.test(text)) return "error";
  if (/完成|成功|已保存|已连接|已启动|已结束/.test(text)) return "success";
  return "info";
}

function logEventMessage(event: string): string {
  return event.slice(9);
}

function logEventTime(event: string): string {
  return event.slice(0, 8);
}
const canSend = computed(() => Boolean(prompt.value.trim() || imageAttachments.value.length || ws.activeChatIsRunning.value));
const providerIcons: Record<string, string> = {
  claude: providerClaudeIcon,
  codex: providerCodexIcon,
  opencode: providerOpencodeIcon,
};

function createAttachmentId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function providerIcon(providerId: string) {
  return providerIcons[providerId] ?? providerCodexIcon;
}

function closeStartMenuOnOutsideClick(event: PointerEvent) {
  if (!startMenuOpen.value) return;
  const target = event.target;
  if (target instanceof Node && startPromptBox.value?.contains(target)) return;
  startMenuOpen.value = false;
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && previewImage.value) {
    event.preventDefault();
    previewImage.value = null;
    return;
  }
  if (event.key !== "Escape" || !ws.activeChatIsRunning.value) return;
  event.preventDefault();
  void ws.stopActiveAiChat();
}

function projectForNewSession() {
  const project = currentProject.value ?? ws.projects.value[0];
  if (project) ws.selectedProjectPath.value = project.path;
  return project;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("图片读取失败"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("图片读取失败")));
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files: File[]) {
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  const next: ChatImageAttachment[] = [];
  for (const file of images) {
    next.push({
      id: createAttachmentId(),
      name: file.name || "截图",
      mimeType: file.type || "image/png",
      dataUrl: await fileToDataUrl(file),
    });
  }
  imageAttachments.value = [...imageAttachments.value, ...next].slice(0, 6);
}

async function addClipboardImageFallback() {
  try {
    const image = await desktopApi.readClipboardImage();
    if (!image) return false;
    imageAttachments.value = [
      ...imageAttachments.value,
      { ...image, id: createAttachmentId() },
    ].slice(0, 6);
    return true;
  } catch {
    return false;
  }
}

async function onPromptPaste(event: ClipboardEvent) {
  const clipboardFiles = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  const files = clipboardFiles.length ? clipboardFiles : [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const seenFiles = new Set<string>();
  const imageFiles = files.filter((file) => {
    if (!file.type.startsWith("image/")) return false;
    const key = `${file.name}:${file.type}:${file.size}`;
    if (seenFiles.has(key)) return false;
    seenFiles.add(key);
    return true;
  });
  if (imageFiles.length) {
    event.preventDefault();
    await addImageFiles(imageFiles);
    return;
  }

  const hasText = Boolean(event.clipboardData?.getData("text/plain"));
  if (hasText) return;
  if (await addClipboardImageFallback()) event.preventDefault();
}

function removeImageAttachment(id: string) {
  imageAttachments.value = imageAttachments.value.filter((image) => image.id !== id);
  if (previewImage.value?.id === id) previewImage.value = null;
}

function openImagePreview(image: ChatImageAttachment) {
  previewImage.value = image;
}

function closeImagePreview() {
  previewImage.value = null;
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
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeStartMenuOnOutsideClick);
  window.removeEventListener("keydown", onWindowKeydown);
});

async function send() {
  if (ws.activeChatIsRunning.value) {
    await ws.stopActiveAiChat();
    return;
  }
  const value = prompt.value.trim();
  const images = imageAttachments.value.map((image) => ({
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    dataUrl: image.dataUrl,
  }));
  if (!value && !images.length) return;
  prompt.value = "";
  imageAttachments.value = [];
  if (!ws.activeAiSession.value) {
    const project = projectForNewSession();
    if (!project) {
      await ws.chooseProject();
      prompt.value = value;
      imageAttachments.value = images;
      return;
    }
    ws.selectedProviderId.value = selectedProvider.value?.id ?? "codex";
    const session = await ws.createAiSession();
    if (!session) {
      prompt.value = value;
      imageAttachments.value = images;
      return;
    }
  }
  await ws.sendPrompt(value, images);
}

function selectStartProvider(providerId = "codex") {
  startMenuOpen.value = false;
  ws.selectedProviderId.value = providerId;
}

function onPromptKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && event.shiftKey) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (ws.activeChatIsRunning.value) return;
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
          <div v-if="imageAttachments.length" class="chat-image-attachments start-attachments">
            <div
              v-for="image in imageAttachments"
              :key="image.id"
              class="chat-image-chip"
            >
              <button class="chat-image-preview-trigger" type="button" title="预览图片" @click="openImagePreview(image)">
                <img :src="image.dataUrl" :alt="image.name" />
              </button>
              <button class="chat-image-remove" type="button" title="移除图片" @click="removeImageAttachment(image.id)">
                <img :src="imageRemoveIcon" alt="" aria-hidden="true" />
              </button>
            </div>
          </div>
          <textarea
            v-model="prompt"
            rows="2"
            placeholder="输入你想做的事"
            @keydown="onPromptKeydown"
            @paste="onPromptPaste"
          ></textarea>
          <button
            class="codex-start-add"
            :class="{ open: startMenuOpen }"
            title="选择 AI 会话类型"
            type="button"
            @click="startMenuOpen = !startMenuOpen"
            aria-label="选择 AI 会话类型"
          >
            <img :src="providerIcon(selectedProvider?.id ?? 'codex')" alt="" aria-hidden="true" />
            <span>{{ selectedProvider?.name ?? "Codex CLI" }}</span>
            <svg class="codex-start-add-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <div v-if="startMenuOpen" class="codex-start-menu">
            <span class="codex-start-menu-label">AI 会话类型</span>
            <button
              v-for="provider in providerChoices"
              :key="provider.id"
              type="button"
              :class="{ active: provider.id === selectedProvider?.id }"
              @click="selectStartProvider(provider.id)"
            >
              <img :src="providerIcon(provider.id)" alt="" aria-hidden="true" />
              <span>{{ provider.name }}</span>
            </button>
          </div>
          <button class="codex-send-button" :disabled="!prompt.trim() && !imageAttachments.length" title="发送" type="submit" aria-label="发送">
            <img :src="sendIcon" alt="" aria-hidden="true" />
          </button>
        </form>
        <div v-if="ws.createAiError.value && showCreateHint" class="chat-toast start-toast error">{{ ws.createAiResult.value }}</div>
      </div>
    </section>
    <template v-else>
    <header class="chat-topbar">
      <div class="chat-topbar-title">
        <strong>{{ conversationTitle }}</strong>
        <span
          v-if="ws.activeChatRunState.value?.active"
          class="chat-topbar-status"
          :class="{ running: ws.activeChatIsRunning.value }"
        >
          {{ ws.activeChatRunState.value.title }}
        </span>
      </div>
      <div class="chat-topbar-meta">
        <span>{{ chatHeaderMeta }}</span>
      </div>
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
            <p>左侧选择本地项目，然后新建 AI 会话。聊天页支持 Codex / Claude Code，终端页只提供项目 shell。</p>
          </div>
          <div v-else-if="ws.activeAiSession.value && !ws.chatMessages.value.length" class="chat-welcome">
            <h2>{{ ws.activeAiSession.value.title }}</h2>
            <p>会话已连接。现在输入 prompt，AI 会在当前项目中处理。</p>
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
              <span>{{ ws.activeChatIsRunning.value ? `${activeProviderName} 正在执行` : "最近一次运行记录" }}</span>
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
            <li
              v-for="event in ws.chatDebugEvents.value"
              :key="event"
              :class="logEventLevel(event)"
            >
              <span class="chat-log-time">{{ logEventTime(event) }}</span>
              <div class="chat-log-entry">
                <span class="chat-log-level">{{ logEventLevel(event) }}</span>
                <p>{{ logEventMessage(event) }}</p>
              </div>
            </li>
          </ol>
          <div v-else class="chat-log-empty">
            <strong>暂无执行日志</strong>
            <p>发送一条消息后，这里会显示保存、启动、连接、执行和完成状态。</p>
          </div>
        </div>
        <div v-if="showCreateHint" class="chat-toast" :class="{ error: ws.createAiError.value }">{{ ws.createAiResult.value }}</div>
        <div v-if="activeTab === 'chat'" class="chat-composer">
          <div v-if="imageAttachments.length" class="chat-image-attachments">
            <div
              v-for="image in imageAttachments"
              :key="image.id"
              class="chat-image-chip"
            >
              <button class="chat-image-preview-trigger" type="button" title="预览图片" @click="openImagePreview(image)">
                <img :src="image.dataUrl" :alt="image.name" />
              </button>
              <button class="chat-image-remove" type="button" title="移除图片" @click="removeImageAttachment(image.id)">
                <img :src="imageRemoveIcon" alt="" aria-hidden="true" />
              </button>
            </div>
          </div>
          <textarea v-model="prompt" rows="3" placeholder="输入你想做的事" @keydown="onPromptKeydown" @paste="onPromptPaste"></textarea>
          <button
            class="codex-send-button chat-send-button"
            :class="{ stopping: ws.activeChatIsRunning.value }"
            :disabled="!canSend"
            :title="ws.activeChatIsRunning.value ? '中断' : '发送'"
            type="button"
            @click="send"
            :aria-label="ws.activeChatIsRunning.value ? '中断' : '发送'"
          >
            <span v-if="ws.activeChatIsRunning.value" class="chat-stop-icon" aria-hidden="true"></span>
            <img v-else :src="sendIcon" alt="" aria-hidden="true" />
          </button>
        </div>
      </article>
    </section>
    </template>
    <div v-if="previewImage" class="chat-image-preview-overlay" role="dialog" aria-modal="true" @click="closeImagePreview">
      <figure class="chat-image-preview-dialog" @click.stop>
        <button class="chat-image-preview-close" type="button" title="关闭预览" @click="closeImagePreview">
          <img :src="imageRemoveIcon" alt="" aria-hidden="true" />
        </button>
        <img :src="previewImage.dataUrl" :alt="previewImage.name" />
        <figcaption>{{ previewImage.name }}</figcaption>
      </figure>
    </div>
  </section>
</template>
