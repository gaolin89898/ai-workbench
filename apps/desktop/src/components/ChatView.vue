<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChatMessageRow from "./ChatMessageRow.vue";
import TerminalView from "./TerminalView.vue";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi, type AiProvider, type ChatImageAttachment, type ChatMessage } from "../services/desktop";

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
const AUTO_SCROLL_BOTTOM_THRESHOLD = 96;
const VIRTUAL_MESSAGE_ESTIMATE = 156;
const VIRTUAL_SCROLL_OVERSCAN = 900;
const USER_ANCHOR_LIMIT = 18;
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
const virtualScrollTop = ref(0);
const virtualViewportHeight = ref(0);
const virtualMessageHeights = ref<number[]>([]);
const virtualRowElements = new Map<number, Element>();
const virtualRowObservers = new Map<number, ResizeObserver>();
const hoveredUserAnchorIndex = ref<number | null>(null);
let chatScrollResizeObserver: ResizeObserver | null = null;
let pendingPromptAnchorKey: string | null = null;
let anchorScrollVersion = 0;
let userAnchorPreviewCloseTimer: ReturnType<typeof window.setTimeout> | null = null;

type UserMessageAnchor = {
  index: number;
  key: string;
  label: string;
  topPercent: number;
};

const virtualMessages = computed(() => {
  const messages = ws.chatMessages.value;
  const viewportTop = Math.max(0, virtualScrollTop.value - VIRTUAL_SCROLL_OVERSCAN);
  const viewportBottom = virtualScrollTop.value + virtualViewportHeight.value + VIRTUAL_SCROLL_OVERSCAN;
  let totalHeight = 0;
  let topPadding = 0;
  let visibleStart = 0;
  let visibleEnd = messages.length;
  let foundStart = false;

  for (let index = 0; index < messages.length; index += 1) {
    const height = virtualMessageHeight(index, messages[index]);
    const nextOffset = totalHeight + height;
    if (!foundStart && nextOffset >= viewportTop) {
      visibleStart = index;
      topPadding = totalHeight;
      foundStart = true;
    }
    if (foundStart && totalHeight > viewportBottom) {
      visibleEnd = Math.min(visibleEnd, index);
    }
    totalHeight = nextOffset;
  }

  if (!foundStart) {
    visibleStart = Math.max(0, messages.length - 1);
    topPadding = Math.max(0, totalHeight - virtualMessageHeight(visibleStart, messages[visibleStart]));
  }

  const visibleItems = messages.slice(visibleStart, visibleEnd).map((message, offset) => {
    const index = visibleStart + offset;
    return {
      index,
      key: message.clientId ?? `${message.role}-${index}`,
      message,
    };
  });

  return {
    totalHeight,
    topPadding,
    visibleItems,
  };
});

const userMessageAnchors = computed<UserMessageAnchor[]>(() => {
  const anchors = allUserMessageAnchors();
  const visibleAnchors = compactUserAnchors(anchors, activeUserAnchorIndex.value);
  const lastIndex = Math.max(1, visibleAnchors.length - 1);
  return visibleAnchors.map((anchor, index) => ({
    ...anchor,
    topPercent: visibleAnchors.length === 1 ? 50 : 8 + (index / lastIndex) * 84,
  }));
});

const activeUserAnchorIndex = computed(() => {
  const anchors = allUserMessageAnchors();
  if (!anchors.length) return -1;
  const targetTop = virtualScrollTop.value + virtualViewportHeight.value * 0.32;
  let activeIndex = anchors[0].index;
  for (const anchor of anchors) {
    if (virtualMessageTop(anchor.index) <= targetTop) activeIndex = anchor.index;
    else break;
  }
  return activeIndex;
});

const anchorPreviewItems = computed(() => {
  return allUserMessageAnchors();
});

function allUserMessageAnchors(): UserMessageAnchor[] {
  return ws.chatMessages.value.flatMap((message, index) => {
    if (message.role !== "user") return [];
    return [{
      index,
      key: message.clientId ?? `user-${index}`,
      label: userAnchorLabel(message, index),
      topPercent: 50,
    }];
  });
}

function clearUserAnchorPreviewCloseTimer() {
  if (userAnchorPreviewCloseTimer === null) return;
  window.clearTimeout(userAnchorPreviewCloseTimer);
  userAnchorPreviewCloseTimer = null;
}

function showUserAnchorPreview(index: number) {
  clearUserAnchorPreviewCloseTimer();
  hoveredUserAnchorIndex.value = index;
}

function scheduleUserAnchorPreviewClose() {
  clearUserAnchorPreviewCloseTimer();
  userAnchorPreviewCloseTimer = window.setTimeout(() => {
    hoveredUserAnchorIndex.value = null;
    userAnchorPreviewCloseTimer = null;
  }, 220);
}

function compactUserAnchors(anchors: UserMessageAnchor[], activeIndex: number) {
  if (anchors.length <= USER_ANCHOR_LIMIT) return anchors;
  const keep = new Map<number, UserMessageAnchor>();
  const lastAnchorIndex = anchors.length - 1;
  keep.set(0, anchors[0]);
  keep.set(lastAnchorIndex, anchors[lastAnchorIndex]);

  const activeAnchorIndex = Math.max(0, anchors.findIndex((anchor) => anchor.index === activeIndex));
  for (let offset = -2; offset <= 2; offset += 1) {
    const index = activeAnchorIndex + offset;
    if (index >= 0 && index <= lastAnchorIndex) keep.set(index, anchors[index]);
  }

  const remainingSlots = Math.max(0, USER_ANCHOR_LIMIT - keep.size);
  for (let slot = 1; slot <= remainingSlots; slot += 1) {
    const index = Math.round((slot / (remainingSlots + 1)) * lastAnchorIndex);
    keep.set(index, anchors[index]);
  }

  return [...keep.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);
}

function virtualMessageHeight(index: number, message?: ChatMessage) {
  return virtualMessageHeights.value[index] ?? estimateMessageHeight(message);
}

function virtualMessageTop(index: number) {
  const messages = ws.chatMessages.value;
  let top = 0;
  for (let currentIndex = 0; currentIndex < index; currentIndex += 1) {
    top += virtualMessageHeight(currentIndex, messages[currentIndex]);
  }
  return top;
}

function userAnchorLabel(message: ChatMessage, index: number) {
  const text = userAnchorText(message.text);
  const fallback = `第 ${index + 1} 条用户消息`;
  if (!text) return fallback;
  return text.length > 54 ? `${text.slice(0, 54)}...` : text;
}

function userAnchorText(text?: string) {
  return (text ?? "")
    .replace(/<image\b[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function estimateMessageHeight(message?: ChatMessage) {
  if (!message) return VIRTUAL_MESSAGE_ESTIMATE;
  if (message.role === "user") return message.images?.length ? 150 : 76;
  const textLength = message.text?.length ?? 0;
  const segmentCount = message.segments?.length ?? 0;
  const imageHeight = message.images?.length ? 118 : 0;
  return Math.min(520, Math.max(112, 72 + Math.ceil(textLength / 48) * 24 + segmentCount * 38 + imageHeight));
}

function updateVirtualViewport() {
  const el = chatScroll.value;
  if (!el) return;
  virtualScrollTop.value = el.scrollTop;
  virtualViewportHeight.value = el.clientHeight;
}

function observeChatScroll() {
  chatScrollResizeObserver?.disconnect();
  chatScrollResizeObserver = null;
  if (!chatScroll.value) return;
  chatScrollResizeObserver = new ResizeObserver(updateVirtualViewport);
  chatScrollResizeObserver.observe(chatScroll.value);
  updateVirtualViewport();
}

function handleChatScroll() {
  updateVirtualViewport();
}

function setVirtualMessageRef(index: number, el: Element | null) {
  const current = virtualRowElements.get(index);
  if (current && current !== el) {
    virtualRowObservers.get(index)?.disconnect();
    virtualRowObservers.delete(index);
    virtualRowElements.delete(index);
  }
  if (!el || current === el) return;

  virtualRowElements.set(index, el);
  const observer = new ResizeObserver((entries) => {
    const target = entries[0]?.target;
    const height = target instanceof HTMLElement ? Math.ceil(target.getBoundingClientRect().height) : 0;
    if (!height || virtualMessageHeights.value[index] === height) return;
    const next = [...virtualMessageHeights.value];
    next[index] = height;
    virtualMessageHeights.value = next;
  });
  observer.observe(el);
  virtualRowObservers.set(index, observer);
}

function resetVirtualMeasurements() {
  for (const observer of virtualRowObservers.values()) observer.disconnect();
  virtualRowObservers.clear();
  virtualRowElements.clear();
  virtualMessageHeights.value = [];
  virtualScrollTop.value = 0;
  void nextTick(updateVirtualViewport);
}

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

function isChatScrolledNearBottom() {
  const el = chatScroll.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_SCROLL_BOTTOM_THRESHOLD;
}

function scrollChatToBottom() {
  const el = chatScroll.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  updateVirtualViewport();
}

function scrollToUserMessage(index: number) {
  const el = chatScroll.value;
  if (!el) return;
  const top = Math.max(0, virtualMessageTop(index) - 24);
  el.scrollTo({ top, behavior: "smooth" });
}

function latestUserAnchor() {
  const anchors = userMessageAnchors.value;
  return anchors.length ? anchors[anchors.length - 1] : null;
}

async function scrollToUserMessageStable(index: number) {
  const el = chatScroll.value;
  if (!el) return;
  const version = ++anchorScrollVersion;
  el.scrollTop = Math.max(0, virtualMessageTop(index) - 24);
  updateVirtualViewport();
  await nextTick();
  if (version !== anchorScrollVersion || !chatScroll.value) return;
  const row = virtualRowElements.get(index);
  if (!(row instanceof HTMLElement)) return;
  const containerRect = chatScroll.value.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const delta = rowRect.top - containerRect.top - 24;
  if (Math.abs(delta) <= 1) return;
  chatScroll.value.scrollTop += delta;
  updateVirtualViewport();
}

watch(
  () => ws.chatMessages.value,
  async () => {
    const shouldStickToBottom = isChatScrolledNearBottom();
    const latestAnchor = latestUserAnchor();
    const shouldAnchorPrompt = Boolean(
      pendingPromptAnchorKey
      && latestAnchor
      && latestAnchor.key !== pendingPromptAnchorKey,
    );
    await nextTick();
    updateVirtualViewport();
    if (shouldAnchorPrompt && latestAnchor) {
      pendingPromptAnchorKey = null;
      await scrollToUserMessageStable(latestAnchor.index);
      return;
    }
    if (shouldStickToBottom) scrollChatToBottom();
  },
  { deep: true },
);

watch(
  () => ws.chatMessages.value.length,
  (length) => {
    if (virtualMessageHeights.value.length > length) {
      virtualMessageHeights.value = virtualMessageHeights.value.slice(0, length);
    }
  },
);

watch(
  () => ws.activeAiSession.value?.id,
  resetVirtualMeasurements,
);

watch(
  () => activeTab.value,
  async () => {
    await nextTick();
    observeChatScroll();
  },
);

onMounted(() => {
  document.addEventListener("pointerdown", closeStartMenuOnOutsideClick);
  window.addEventListener("keydown", onWindowKeydown);
  window.addEventListener("resize", updateVirtualViewport);
  observeChatScroll();
  void nextTick(updateVirtualViewport);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeStartMenuOnOutsideClick);
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("resize", updateVirtualViewport);
  chatScrollResizeObserver?.disconnect();
  clearUserAnchorPreviewCloseTimer();
  for (const observer of virtualRowObservers.values()) observer.disconnect();
  virtualRowObservers.clear();
  virtualRowElements.clear();
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
  pendingPromptAnchorKey = latestUserAnchor()?.key ?? "__empty__";
  try {
    await ws.sendPrompt(value, images);
  } finally {
    if (pendingPromptAnchorKey === (latestUserAnchor()?.key ?? "__empty__")) {
      pendingPromptAnchorKey = null;
    }
  }
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
        <div v-if="activeTab === 'chat'" ref="chatScroll" class="terminal-preview" @scroll.passive="handleChatScroll">
          <div v-if="!ws.activeAiSession.value && ws.chatMessages.value.length === 1 && ws.chatMessages.value[0]?.role === 'system'" class="chat-welcome">
            <h2>从一个项目开始聊天</h2>
            <p>左侧选择本地项目，然后新建 AI 会话。聊天页支持 Codex / Claude Code，终端页只提供项目 shell。</p>
          </div>
          <div v-else-if="ws.activeAiSession.value && !ws.chatMessages.value.length" class="chat-welcome">
            <h2>{{ ws.activeAiSession.value.title }}</h2>
            <p>会话已连接。现在输入 prompt，AI 会在当前项目中处理。</p>
          </div>
          <div v-else class="chat-virtual-list" :style="{ minHeight: `${virtualMessages.totalHeight}px` }">
            <div class="chat-virtual-spacer" :style="{ height: `${virtualMessages.topPadding}px` }"></div>
            <div
              v-for="item in virtualMessages.visibleItems"
              :key="item.key"
              :ref="(el) => setVirtualMessageRef(item.index, el as Element | null)"
              class="chat-virtual-row"
            >
              <ChatMessageRow
                :message="item.message"
                :ai-session-id="ws.activeAiSession.value?.id"
              />
            </div>
          </div>
        </div>
        <div
          v-if="activeTab === 'chat' && userMessageAnchors.length > 1"
          class="chat-user-anchor-rail"
          aria-label="用户消息快速跳转"
          @mouseenter="clearUserAnchorPreviewCloseTimer"
          @mouseleave="scheduleUserAnchorPreviewClose"
        >
          <button
            v-for="anchor in userMessageAnchors"
            :key="anchor.key"
            class="chat-user-anchor"
            :class="{ active: anchor.index === activeUserAnchorIndex }"
            :style="{ top: `${anchor.topPercent}%` }"
            type="button"
            :title="anchor.label"
            :aria-label="`跳转到${anchor.label}`"
            @mouseenter="showUserAnchorPreview(anchor.index)"
            @focus="showUserAnchorPreview(anchor.index)"
            @click="scrollToUserMessage(anchor.index)"
          ></button>
          <div
            v-if="hoveredUserAnchorIndex !== null && anchorPreviewItems.length"
            class="chat-user-anchor-preview"
            @mouseenter="clearUserAnchorPreviewCloseTimer"
            @mouseleave="scheduleUserAnchorPreviewClose"
          >
            <button
              v-for="item in anchorPreviewItems"
              :key="`preview-${item.key}`"
              type="button"
              :class="{ active: item.index === (hoveredUserAnchorIndex ?? activeUserAnchorIndex) }"
              :title="item.label"
              @click="scrollToUserMessage(item.index)"
            >
              <span>{{ item.label }}</span>
              <i aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div v-if="activeTab === 'terminal'" class="terminal-shell">
          <TerminalView />
        </div>
        <div v-if="activeTab === 'logs'" class="chat-logs-panel">
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
