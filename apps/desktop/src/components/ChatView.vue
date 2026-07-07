<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChatMessageRow from "./ChatMessageRow.vue";
import ApprovalSegment from "./ChatSegment.vue";
import TerminalView from "./TerminalView.vue";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi, type AiProvider, type ChatImageAttachment, type ChatMessage, type ChatSegment, type CodexApprovalMode, type CodexChatOptions, type CodexModelOption, type CodexReasoningEffort, type CodexRunMode } from "../services/desktop";

const providerClaudeIcon = new URL("../assets/icons/provider-claude.svg", import.meta.url).href;
const providerCodexIcon = new URL("../assets/icons/provider-codex.svg", import.meta.url).href;
const providerOpencodeIcon = new URL("../assets/icons/provider-opencode.svg", import.meta.url).href;
const providerMimoIcon = new URL("../assets/icons/provider-mimo.svg", import.meta.url).href;
const sendIcon = new URL("../assets/icons/send.svg", import.meta.url).href;
const imageRemoveIcon = new URL("../assets/icons/image-remove.svg", import.meta.url).href;
const ws = useWorkspace();

const prompt = ref("");
const imageAttachments = ref<ChatImageAttachment[]>([]);
const previewImage = ref<ChatImageAttachment | null>(null);
const chatScroll = ref<HTMLDivElement | null>(null);
const startPromptBox = ref<HTMLFormElement | null>(null);
const chatComposer = ref<HTMLDivElement | null>(null);
const activeTab = ref<"chat" | "terminal">("chat");
const startMenuOpen = ref(false);
const approvalMenuOpen = ref(false);
const composerToolsOpen = ref(false);
const modelMenuOpen = ref(false);
const modelSubmenuOpen = ref(false);
const codexApprovalMode = ref<CodexApprovalMode>("autoEdit");
const codexMode = ref<CodexRunMode>("default");
const codexSelectedModel = ref("");
const codexReasoningLevel = ref<CodexReasoningEffort>("high");
const codexGoalEnabled = ref(false);
const codexGoal = ref("");
const codexModels = ref<CodexModelOption[]>([]);
const codexModelsLoading = ref(false);
const codexModelsLoaded = ref(false);
const floatingMenuTargetSelector = [
  ".codex-start-add",
  ".codex-start-menu",
  ".codex-approval-trigger",
  ".codex-approval-menu",
  ".codex-composer-add",
  ".codex-composer-add-menu",
  ".codex-model-picker",
  ".codex-model-menu",
  ".codex-model-submenu",
].join(", ");

const approvalModes = [
  {
    id: "suggest",
    label: "建议批准",
    description: "每次编辑外部文件和使用互联网时始终询问。",
  },
  {
    id: "autoEdit",
    label: "替我审批",
    description: "仅对检测到的风险操作请求批准。",
  },
  {
    id: "fullAccess",
    label: "完全访问权限",
    description: "可不受限制地访问互联网和您电脑上的任务。",
  },
] as const;
const AUTO_SCROLL_BOTTOM_THRESHOLD = 96;
const VIRTUAL_MESSAGE_ESTIMATE = 156;
const VIRTUAL_SCROLL_OVERSCAN = 900;
const USER_ANCHOR_MIN_VISIBLE = 4;
const USER_ANCHOR_LIMIT = 18;
const USER_ANCHOR_MIN_TOP_PERCENT = 8;
const USER_ANCHOR_MAX_TOP_PERCENT = 92;
const USER_ANCHOR_DOT_GAP_PX = 20;
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
const showCodexRunControls = computed(() => {
  const providerId = ws.activeAiSession.value?.providerId ?? selectedProvider.value?.id ?? ws.selectedProviderId.value;
  return providerId === "codex";
});
const codexModelOptions = computed(() => codexModels.value.filter((model) => model.model.trim().length > 0));
const chatHeaderMeta = computed(() => {
  if (!currentProject.value) return "选择项目后开始聊天";
  return `${currentProject.value.gitBranch ?? "未知分支"} · ${currentProject.value.gitDirty ? "有变更" : "Git 干净"}`;
});
const conversationTitle = computed(() => ws.activeAiSession.value?.title ?? currentProject.value?.name ?? "新对话");
const showCreateHint = computed(() => !ws.activeAiSession.value && ws.createAiResult.value);
const pendingApprovalSegment = computed<Extract<ChatSegment, { type: "approval" }> | null>(() => {
  for (let messageIndex = ws.chatMessages.value.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const segments = ws.chatMessages.value[messageIndex].segments ?? [];
    for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      const segment = segments[segmentIndex];
      if (segment.type === "approval" && segment.status === "pending") return segment;
    }
  }
  return null;
});

const canSend = computed(() => Boolean(prompt.value.trim() || imageAttachments.value.length || ws.activeChatIsRunning.value));
const selectedApprovalMode = computed(() => approvalModes.find((mode) => mode.id === codexApprovalMode.value) ?? approvalModes[1]);
const reasoningOptions = [
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "ultra", label: "超高" },
] as const;
const selectedReasoningLabel = computed(() => reasoningOptions.find((option) => option.id === codexReasoningLevel.value)?.label ?? "高");
const selectedCodexModelLabel = computed(() => {
  if (codexModelsLoading.value) return "加载中";
  if (!codexSelectedModel.value) return "默认";
  const selected = codexModelOptions.value.find((model) => model.model === codexSelectedModel.value);
  return selected?.displayName ?? codexSelectedModel.value;
});
const selectedCodexModelShortLabel = computed(() => {
  const label = selectedCodexModelLabel.value.trim();
  return label
    .replace(/^gpt[-_\s]*/i, "")
    .replace(/^claude[-_\s]*/i, "")
    .replace(/^codex[-_\s]*/i, "")
    .replace(/^openai[-_\s]*/i, "");
});
const selectedCodexModelButtonLabel = computed(() => `${selectedCodexModelShortLabel.value} · ${selectedReasoningLabel.value}`);
const providerIcons: Record<string, string> = {
  claude: providerClaudeIcon,
  codex: providerCodexIcon,
  opencode: providerOpencodeIcon,
  mimo: providerMimoIcon,
};
const virtualScrollTop = ref(0);
const virtualViewportHeight = ref(0);
const virtualMessageHeights = ref<number[]>([]);
const virtualRowElements = new Map<number, Element>();
const virtualRowObservers = new Map<number, ResizeObserver>();
let chatScrollResizeObserver: ResizeObserver | null = null;
let pendingPromptAnchorKey: string | null = null;
let anchorScrollVersion = 0;

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
  return positionUserAnchors(visibleAnchors);
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

function positionUserAnchors(anchors: UserMessageAnchor[]) {
  if (!anchors.length) return [];
  if (anchors.length === 1) return [{ ...anchors[0], topPercent: 50 }];

  const viewportHeight = Math.max(1, virtualViewportHeight.value);
  const maxRange = USER_ANCHOR_MAX_TOP_PERCENT - USER_ANCHOR_MIN_TOP_PERCENT;
  const preferredGap = (USER_ANCHOR_DOT_GAP_PX / viewportHeight) * 100;
  const gap = Math.min(preferredGap, maxRange / (anchors.length - 1));
  const centerOffset = (anchors.length - 1) / 2;

  return anchors.map((anchor, index) => ({
    ...anchor,
    topPercent: clampUserAnchorTop(50 + (index - centerOffset) * gap),
  }));
}

function clampUserAnchorTop(percent: number) {
  return Math.min(USER_ANCHOR_MAX_TOP_PERCENT, Math.max(USER_ANCHOR_MIN_TOP_PERCENT, percent));
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

function isFloatingMenuTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(floatingMenuTargetSelector));
}

function closeFloatingMenusOnOutsideClick(event: PointerEvent) {
  if (!startMenuOpen.value && !approvalMenuOpen.value && !composerToolsOpen.value && !modelMenuOpen.value && !modelSubmenuOpen.value) return;
  if (isFloatingMenuTarget(event.target)) return;
  startMenuOpen.value = false;
  approvalMenuOpen.value = false;
  composerToolsOpen.value = false;
  modelMenuOpen.value = false;
  modelSubmenuOpen.value = false;
}

function toggleApprovalMenu() {
  if (!showCodexRunControls.value) return;
  approvalMenuOpen.value = !approvalMenuOpen.value;
  if (approvalMenuOpen.value) {
    startMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
  }
}

function selectApprovalMode(mode: CodexApprovalMode) {
  codexApprovalMode.value = mode;
  approvalMenuOpen.value = false;
}

function toggleComposerToolsMenu() {
  if (!showCodexRunControls.value) return;
  composerToolsOpen.value = !composerToolsOpen.value;
  if (composerToolsOpen.value) {
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
  }
}

function openComposerApprovalMenu() {
  composerToolsOpen.value = false;
  approvalMenuOpen.value = true;
}

function toggleComposerPlanMode() {
  codexMode.value = codexMode.value === "plan" ? "default" : "plan";
  composerToolsOpen.value = false;
}

function toggleComposerGoalMode() {
  codexGoalEnabled.value = !codexGoalEnabled.value;
  composerToolsOpen.value = false;
}

function toggleModelMenu() {
  if (!showCodexRunControls.value || codexModelsLoading.value) return;
  modelMenuOpen.value = !modelMenuOpen.value;
  modelSubmenuOpen.value = false;
  if (modelMenuOpen.value) {
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
  }
}

function toggleModelSubmenu() {
  if (!modelMenuOpen.value) return;
  modelSubmenuOpen.value = !modelSubmenuOpen.value;
}

function selectCodexModel(model: string) {
  codexSelectedModel.value = model;
  modelSubmenuOpen.value = false;
  modelMenuOpen.value = false;
}

function selectReasoningLevel(level: typeof reasoningOptions[number]["id"]) {
  codexReasoningLevel.value = level;
  modelSubmenuOpen.value = false;
}

async function loadCodexModels() {
  if (codexModelsLoaded.value || codexModelsLoading.value) return;
  codexModelsLoading.value = true;
  try {
    const models = await desktopApi.listCodexModels();
    codexModels.value = models;
    codexModelsLoaded.value = true;
    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
    if (!codexSelectedModel.value && defaultModel) codexSelectedModel.value = defaultModel.model;
  } catch (error) {
    console.warn("Codex model list failed", error);
  } finally {
    codexModelsLoading.value = false;
  }
}

function setCodexMode(mode: CodexRunMode) {
  codexMode.value = mode;
}

function buildCodexOptions(): CodexChatOptions {
  if (!showCodexRunControls.value) return {};
  const goal = codexGoalEnabled.value ? codexGoal.value.trim() : "";
  return {
    approvalMode: codexApprovalMode.value,
    codexMode: codexMode.value,
    codexModel: codexSelectedModel.value || null,
    codexReasoningEffort: codexReasoningLevel.value,
    codexGoal: goal || null,
  };
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && previewImage.value) {
    event.preventDefault();
    previewImage.value = null;
    return;
  }
  if (event.key === "Escape" && (startMenuOpen.value || approvalMenuOpen.value || composerToolsOpen.value || modelMenuOpen.value || modelSubmenuOpen.value)) {
    event.preventDefault();
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
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
  const rowCenter = virtualMessageTop(index) + virtualMessageHeight(index) / 2;
  el.scrollTop = Math.max(0, rowCenter - virtualViewportHeight.value / 2);
  updateVirtualViewport();
  await nextTick();
  if (version !== anchorScrollVersion || !chatScroll.value) return;
  const row = virtualRowElements.get(index);
  if (!(row instanceof HTMLElement)) return;
  const containerRect = chatScroll.value.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const delta = rowRect.top + rowRect.height / 2 - (containerRect.top + containerRect.height / 2);
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
  () => showCodexRunControls.value,
  (visible) => {
    if (visible) void loadCodexModels();
    else {
      approvalMenuOpen.value = false;
      composerToolsOpen.value = false;
      modelMenuOpen.value = false;
      modelSubmenuOpen.value = false;
    }
  },
  { immediate: true },
);

watch(
  () => activeTab.value,
  async () => {
    await nextTick();
    observeChatScroll();
  },
);

onMounted(() => {
  document.addEventListener("pointerdown", closeFloatingMenusOnOutsideClick);
  window.addEventListener("keydown", onWindowKeydown);
  window.addEventListener("resize", updateVirtualViewport);
  observeChatScroll();
  void nextTick(updateVirtualViewport);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeFloatingMenusOnOutsideClick);
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("resize", updateVirtualViewport);
  chatScrollResizeObserver?.disconnect();
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
    await ws.sendPrompt(value, images, buildCodexOptions());
  } finally {
    if (pendingPromptAnchorKey === (latestUserAnchor()?.key ?? "__empty__")) {
      pendingPromptAnchorKey = null;
    }
  }
}

function toggleStartMenu() {
  startMenuOpen.value = !startMenuOpen.value;
  if (startMenuOpen.value) {
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
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
        <h1>
          我们该在
          <span class="codex-start-project">{{ currentProject?.name ?? "项目" }}</span>
          中做什么?
        </h1>
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
          <div class="codex-start-toolbar">
          <div v-if="showCodexRunControls" class="codex-composer-add-wrap codex-start-tools-wrap">
            <button
              class="codex-composer-add"
              :class="{ open: composerToolsOpen }"
              title="添加工具"
              type="button"
              @click="toggleComposerToolsMenu"
              aria-label="添加工具"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </button>
            <div v-if="composerToolsOpen" class="codex-composer-add-menu">
              <button type="button" @click="openComposerApprovalMenu">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2.25 13 4.1v3.7c0 3-2.05 5.05-5 5.95-2.95-.9-5-2.95-5-5.95V4.1l5-1.85Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
                  <path d="M5.75 7.95 7.25 9.4l3.05-3.05" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>审批方式</span>
                <small>{{ selectedApprovalMode.label }}</small>
              </button>
              <button type="button" :class="{ active: codexMode === 'plan' }" @click="toggleComposerPlanMode">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4h3.5M8.5 4H12M4 8h8M4 12h3.5M8.5 12H12" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                  <path d="M7.5 2.75v2.5M7.5 10.75v2.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                </svg>
                <span>计划模式</span>
                <small>{{ codexMode === "plan" ? "已开启" : "未开启" }}</small>
              </button>
              <button type="button" :class="{ active: codexGoalEnabled }" @click="toggleComposerGoalMode">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.35" />
                  <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.35" />
                  <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                </svg>
                <span>目标</span>
                <small>{{ codexGoalEnabled ? "已开启" : "未开启" }}</small>
              </button>
            </div>
          </div>
          <button
            class="codex-start-add"
            :class="{ open: startMenuOpen }"
            title="选择 AI 会话类型"
            type="button"
            @click="toggleStartMenu"
            aria-label="选择 AI 会话类型"
          >
            <img :src="providerIcon(selectedProvider?.id ?? 'codex')" alt="" aria-hidden="true" />
            <span>{{ selectedProvider?.name ?? "Codex CLI" }}</span>
            <svg class="codex-start-add-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            class="codex-approval-trigger start-approval-trigger"
            v-if="showCodexRunControls"
            :class="{ open: approvalMenuOpen }"
            title="选择 Codex 操作批准方式"
            type="button"
            @click="toggleApprovalMenu"
            aria-label="选择 Codex 操作批准方式"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2.25 13 4.1v3.7c0 3-2.05 5.05-5 5.95-2.95-.9-5-2.95-5-5.95V4.1l5-1.85Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              <path d="M5.75 7.95 7.25 9.4l3.05-3.05" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>{{ selectedApprovalMode.label }}</span>
          </button>
          <div v-if="showCodexRunControls && approvalMenuOpen" class="codex-approval-menu">
            <div class="codex-approval-menu-head">
              <span>应如何批准 Codex 操作?</span>
              <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">了解更多</a>
            </div>
            <button
              v-for="mode in approvalModes"
              :key="mode.id"
              type="button"
              :class="{ active: mode.id === codexApprovalMode }"
              @click="selectApprovalMode(mode.id)"
            >
              <span class="codex-approval-icon" aria-hidden="true">
                <svg v-if="mode.id === 'suggest'" viewBox="0 0 16 16" fill="none">
                  <path d="M6.2 13.5c-1.55-.75-2.65-2.35-2.65-4.25v-2.3c0-.65.55-1.15 1.18-1.08.43.05.78.34.93.73V3.1c0-.61.5-1.1 1.1-1.1.61 0 1.1.49 1.1 1.1v2.65-3c0-.6.5-1.1 1.1-1.1.61 0 1.1.5 1.1 1.1v3.15-2.2c0-.6.5-1.1 1.1-1.1.61 0 1.1.5 1.1 1.1v4.45c0 2.95-1.7 5.35-4.4 5.35h-1.66Z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else-if="mode.id === 'autoEdit'" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2.2 13 4v3.55c0 2.85-2.05 5.15-5 6.25-2.95-1.1-5-3.4-5-6.25V4l5-1.8Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
                  <path d="M6 8.1 7.35 9.45 10.4 6.4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.9 13 3.8v3.7c0 3.05-2.05 5.35-5 6.6-2.95-1.25-5-3.55-5-6.6V3.8l5-1.9Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
                  <path d="M8 5.05v3.35" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                  <path d="M8 10.85h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </span>
              <span class="codex-approval-copy">
                <strong>{{ mode.label }}</strong>
                <small>{{ mode.description }}</small>
              </span>
              <span v-if="mode.id === codexApprovalMode" class="codex-approval-check" aria-hidden="true">✓</span>
            </button>
          </div>
          <div v-if="showCodexRunControls" class="codex-run-controls start-run-controls">
            <div class="codex-run-mode" role="group" aria-label="Codex 运行模式">
              <button type="button" :class="{ active: codexMode === 'default' }" @click="setCodexMode('default')">默认</button>
              <button type="button" :class="{ active: codexMode === 'plan' }" @click="setCodexMode('plan')">计划</button>
            </div>
            <div class="codex-model-picker codex-model-picker-custom" title="选择 Codex 模型">
              <button
                class="codex-model-button"
                :class="{ open: modelMenuOpen }"
                :disabled="codexModelsLoading"
                type="button"
                @click="toggleModelMenu"
                aria-label="选择 Codex 模型"
              >
                <span>{{ selectedCodexModelButtonLabel }}</span>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <div v-if="modelMenuOpen" class="codex-model-menu codex-model-menu-dual">
                <div class="codex-model-menu-column models">
                  <button
                    type="button"
                    class="codex-model-submenu-trigger"
                    :class="{ open: modelSubmenuOpen }"
                    @click.stop="toggleModelSubmenu"
                  >
                    <span>{{ selectedCodexModelLabel }}</span>
                    <svg class="codex-model-submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M6 4.5 9.5 8 6 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <div v-if="modelSubmenuOpen" class="codex-model-submenu">
                    <div class="codex-model-menu-heading">模型</div>
                    <button
                      v-for="model in codexModelOptions"
                      :key="model.id"
                      type="button"
                      :class="{ active: model.model === codexSelectedModel }"
                      @click="selectCodexModel(model.model)"
                    >
                      <span>{{ model.displayName }}</span>
                      <span class="codex-model-menu-check" aria-hidden="true">{{ model.model === codexSelectedModel ? "✓" : "" }}</span>
                    </button>
                  </div>
                </div>
                <div class="codex-model-menu-column reasoning">
                  <div class="codex-model-menu-heading">推理</div>
                  <button
                    v-for="option in reasoningOptions"
                    :key="option.id"
                    type="button"
                    :class="{ active: option.id === codexReasoningLevel }"
                    @click="selectReasoningLevel(option.id)"
                  >
                    <span>{{ option.label }}</span>
                    <span class="codex-model-menu-check" aria-hidden="true">{{ option.id === codexReasoningLevel ? "✓" : "" }}</span>
                  </button>
                </div>
              </div>
            </div>
            <label class="codex-goal-toggle" title="开启目标模式">
              <input v-model="codexGoalEnabled" type="checkbox" />
              <span>目标</span>
            </label>
            <input
              v-if="codexGoalEnabled"
              v-model="codexGoal"
              class="codex-goal-input"
              type="text"
              placeholder="这轮工作的目标"
            />
          </div>
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
          </div>
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
          v-if="activeTab === 'chat' && userMessageAnchors.length >= USER_ANCHOR_MIN_VISIBLE"
          class="chat-user-anchor-rail"
          aria-label="用户消息快速跳转"
        >
          <button
            v-for="anchor in userMessageAnchors"
            :key="anchor.key"
            class="chat-user-anchor"
            :class="{ active: anchor.index === activeUserAnchorIndex }"
            :style="{ top: `${anchor.topPercent}%` }"
            type="button"
            :aria-label="`跳转到${anchor.label}`"
            @click="scrollToUserMessage(anchor.index)"
          >
            <span class="chat-user-anchor-dot" aria-hidden="true"></span>
            <span class="chat-user-anchor-tooltip">{{ anchor.label }}</span>
          </button>
        </div>
        <div v-if="activeTab === 'terminal'" class="terminal-shell">
          <TerminalView />
        </div>
        <div v-if="showCreateHint" class="chat-toast" :class="{ error: ws.createAiError.value }">{{ ws.createAiResult.value }}</div>
        <div
          v-if="activeTab === 'chat'"
          ref="chatComposer"
          class="chat-composer"
          :class="{ 'has-approval-cover': pendingApprovalSegment }"
        >
          <div v-if="pendingApprovalSegment" class="chat-composer-approval-cover">
            <ApprovalSegment
              :segment="pendingApprovalSegment"
              :ai-session-id="ws.activeAiSession.value?.id"
            />
          </div>
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
          <textarea v-model="prompt" rows="3" placeholder="输入你的消息..." @keydown="onPromptKeydown" @paste="onPromptPaste"></textarea>
          <div class="chat-composer-divider"></div>
          <div class="chat-composer-toolbar">
            <div class="chat-composer-toolbar-left">
              <div v-if="showCodexRunControls" class="codex-composer-add-wrap">
                <button
                  class="codex-composer-add"
                  :class="{ open: composerToolsOpen }"
                  title="添加工具"
                  type="button"
                  @click="toggleComposerToolsMenu"
                  aria-label="添加工具"
                >
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
                <div v-if="composerToolsOpen" class="codex-composer-add-menu">
                  <button type="button" @click="openComposerApprovalMenu">
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 2.25 13 4.1v3.7c0 3-2.05 5.05-5 5.95-2.95-.9-5-2.95-5-5.95V4.1l5-1.85Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
                      <path d="M5.75 7.95 7.25 9.4l3.05-3.05" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <span>审批方式</span>
                    <small>{{ selectedApprovalMode.label }}</small>
                  </button>
                  <button type="button" :class="{ active: codexMode === 'plan' }" @click="toggleComposerPlanMode">
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4 4h3.5M8.5 4H12M4 8h8M4 12h3.5M8.5 12H12" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                      <path d="M7.5 2.75v2.5M7.5 10.75v2.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                    </svg>
                    <span>计划模式</span>
                    <small>{{ codexMode === "plan" ? "已开启" : "未开启" }}</small>
                  </button>
                  <button type="button" :class="{ active: codexGoalEnabled }" @click="toggleComposerGoalMode">
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.35" />
                      <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.35" />
                      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                    </svg>
                    <span>目标</span>
                    <small>{{ codexGoalEnabled ? "已开启" : "未开启" }}</small>
                  </button>
                </div>
              </div>
              <button
                v-if="showCodexRunControls && codexMode === 'plan'"
                class="codex-mode-chip"
                title="关闭计划模式"
                type="button"
                @click="setCodexMode('default')"
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4h3.5M8.5 4H12M4 8h8M4 12h3.5M8.5 12H12" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                </svg>
                <span>计划</span>
              </button>
              <button
                v-if="showCodexRunControls && codexGoalEnabled"
                class="codex-mode-chip"
                title="关闭目标模式"
                type="button"
                @click="toggleComposerGoalMode"
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.35" />
                  <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.35" />
                </svg>
                <span>目标</span>
              </button>
              <input
                v-if="showCodexRunControls && codexGoalEnabled"
                v-model="codexGoal"
                class="codex-goal-input"
                type="text"
                placeholder="这轮工作的目标"
              />
            </div>
            <div class="chat-composer-toolbar-right">
              <div v-if="showCodexRunControls" class="codex-model-picker codex-model-picker-custom" title="选择 Codex 模型">
                <button
                  class="codex-model-button"
                  :class="{ open: modelMenuOpen }"
                  :disabled="codexModelsLoading"
                  type="button"
                  @click="toggleModelMenu"
                  aria-label="选择 Codex 模型"
                >
                  <span>{{ selectedCodexModelButtonLabel }}</span>
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <div v-if="modelMenuOpen" class="codex-model-menu codex-model-menu-dual">
                  <div class="codex-model-menu-column models">
                    <button
                      type="button"
                      class="codex-model-submenu-trigger"
                      :class="{ open: modelSubmenuOpen }"
                      @click.stop="toggleModelSubmenu"
                    >
                      <span>{{ selectedCodexModelLabel }}</span>
                      <svg class="codex-model-submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M6 4.5 9.5 8 6 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <div v-if="modelSubmenuOpen" class="codex-model-submenu">
                      <div class="codex-model-menu-heading">模型</div>
                      <button
                        v-for="model in codexModelOptions"
                        :key="model.id"
                        type="button"
                        :class="{ active: model.model === codexSelectedModel }"
                        @click="selectCodexModel(model.model)"
                      >
                        <span>{{ model.displayName }}</span>
                        <span class="codex-model-menu-check" aria-hidden="true">{{ model.model === codexSelectedModel ? "✓" : "" }}</span>
                      </button>
                    </div>
                  </div>
                  <div class="codex-model-menu-column reasoning">
                    <div class="codex-model-menu-heading">推理</div>
                    <button
                      v-for="option in reasoningOptions"
                      :key="option.id"
                      type="button"
                      :class="{ active: option.id === codexReasoningLevel }"
                      @click="selectReasoningLevel(option.id)"
                    >
                      <span>{{ option.label }}</span>
                      <span class="codex-model-menu-check" aria-hidden="true">{{ option.id === codexReasoningLevel ? "✓" : "" }}</span>
                    </button>
                  </div>
                </div>
              </div>
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
          </div>
          <div v-if="showCodexRunControls && approvalMenuOpen" class="codex-approval-menu chat-approval-menu">
            <div class="codex-approval-menu-head">
              <span>应如何批准 Codex 操作?</span>
              <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">了解更多</a>
            </div>
            <button
              v-for="mode in approvalModes"
              :key="mode.id"
              type="button"
              :class="{ active: mode.id === codexApprovalMode }"
              @click="selectApprovalMode(mode.id)"
            >
              <span class="codex-approval-icon" aria-hidden="true">
                <svg v-if="mode.id === 'suggest'" viewBox="0 0 16 16" fill="none">
                  <path d="M6.2 13.5c-1.55-.75-2.65-2.35-2.65-4.25v-2.3c0-.65.55-1.15 1.18-1.08.43.05.78.34.93.73V3.1c0-.61.5-1.1 1.1-1.1.61 0 1.1.49 1.1 1.1v2.65-3c0-.6.5-1.1 1.1-1.1.61 0 1.1.5 1.1 1.1v3.15-2.2c0-.6.5-1.1 1.1-1.1.61 0 1.1.5 1.1 1.1v4.45c0 2.95-1.7 5.35-4.4 5.35h-1.66Z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else-if="mode.id === 'autoEdit'" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2.2 13 4v3.55c0 2.85-2.05 5.15-5 6.25-2.95-1.1-5-3.4-5-6.25V4l5-1.8Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
                  <path d="M6 8.1 7.35 9.45 10.4 6.4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.9 13 3.8v3.7c0 3.05-2.05 5.35-5 6.6-2.95-1.25-5-3.55-5-6.6V3.8l5-1.9Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
                  <path d="M8 5.05v3.35" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                  <path d="M8 10.85h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </span>
              <span class="codex-approval-copy">
                <strong>{{ mode.label }}</strong>
                <small>{{ mode.description }}</small>
              </span>
              <span v-if="mode.id === codexApprovalMode" class="codex-approval-check" aria-hidden="true">✓</span>
            </button>
          </div>
        </div>
        <div class="chat-composer-hint">回车发送 · Shift+回车换行</div>
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
