<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChatMessageRow from "./ChatMessageRow.vue";
import ApprovalSegment from "./ChatSegment.vue";
import TerminalView from "./TerminalView.vue";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi, type AiChatOptions, type AiProvider, type AiRunSettingsState, type ChatImageAttachment, type ChatMessage, type ChatSegment, type ClaudeReasoningEffort, type AcpConfigOption, type CodexApprovalMode, type CodexModelOption, type CodexReasoningEffort, type CodexRunMode, type ProjectEnvironmentInfo, type ProjectFilePreview } from "../services/desktop";

type RunPreferenceProviderId = "codex" | "claude" | "opencode" | "mimo";
type RunPreference = { model: string; reasoningEffort: string };
type RunPreferences = Partial<Record<RunPreferenceProviderId, RunPreference>>;

const runPreferencesStorageKey = "ai-workbench.aiRunPreferences.v1";

function readRunPreferences(): RunPreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(runPreferencesStorageKey) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const preferences: RunPreferences = {};
    for (const providerId of ["codex", "claude", "opencode", "mimo"] as const) {
      const value = (parsed as Record<string, unknown>)[providerId];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      preferences[providerId] = {
        model: typeof record.model === "string" ? record.model : "",
        reasoningEffort: typeof record.reasoningEffort === "string" ? record.reasoningEffort : "",
      };
    }
    return preferences;
  } catch {
    return {};
  }
}

function codexEffortPreference(value: string | undefined): CodexReasoningEffort | null {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"
    ? value
    : null;
}

function claudeEffortPreference(value: string | undefined): ClaudeReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : "high";
}

const runPreferences = readRunPreferences();

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
const splitWorkspace = ref<HTMLElement | null>(null);
const previewFile = ref<ProjectFilePreview | null>(null);
const previewLoading = ref(false);
const previewError = ref("");
const activeTab = ref<"chat" | "terminal">("chat");
const startMenuOpen = ref(false);
const approvalMenuOpen = ref(false);
const composerToolsOpen = ref(false);
const environmentPanelOpen = ref(false);
const environmentInfo = ref<ProjectEnvironmentInfo | null>(null);
const environmentLoading = ref(false);
const environmentError = ref("");
const splitPanelOpen = ref(false);
const splitPanelWidth = ref(420);
const modelMenuOpen = ref(false);
const modelSubmenuOpen = ref(false);
type ModelSubmenuKind = "model" | "reasoning";
const modelSubmenuKind = ref<ModelSubmenuKind>("model");
const codexApprovalMode = ref<CodexApprovalMode>("custom");
const codexMode = ref<CodexRunMode>("default");
const codexSelectedModel = ref(runPreferences.codex?.model ?? "");
const codexReasoningLevel = ref<CodexReasoningEffort | null>(codexEffortPreference(runPreferences.codex?.reasoningEffort));
const claudeSelectedModel = ref(runPreferences.claude?.model || "sonnet");
const claudeReasoningLevel = ref<ClaudeReasoningEffort>(claudeEffortPreference(runPreferences.claude?.reasoningEffort));
const codexGoalEnabled = ref(false);
const codexGoal = ref("");
const codexModels = ref<CodexModelOption[]>([]);
const codexModelsLoading = ref(false);
const codexModelsLoaded = ref(false);
let codexApprovalModeLoadId = 0;
let codexApprovalModeRequestedPath: string | null = null;
let codexApprovalModeLoadedPath: string | null = null;
let codexApprovalSelectionVersion = 0;
const acpSelectedModel = ref("");
const acpReasoningLevel = ref("");
const acpModels = ref<AcpConfigOption[]>([]);
const acpEfforts = ref<AcpConfigOption[]>([]);
const acpModelsLoading = ref(false);
let acpModelsLoadId = 0;
let acpModelsRequestedKey = "";
let acpModelsLoadedKey = "";
let removeAiRunSettingsUpdateListener: (() => void) | null = null;
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
  ".chat-topbar-action",
  ".chat-topbar-icon-action",
  ".environment-popover",
].join(", ");

const approvalModes = [
  {
    id: "suggest",
    label: "请求批准",
    triggerLabel: "请求批准",
    description: "每次编辑外部文件和使用互联网时始终询问。",
  },
  {
    id: "autoEdit",
    label: "替我审批",
    triggerLabel: "替我审批",
    description: "仅对检测到的风险操作请求批准。",
  },
  {
    id: "fullAccess",
    label: "完全访问权限",
    triggerLabel: "完全访问权限",
    description: "可不受限制地访问互联网和您电脑上的任务。",
  },
  {
    id: "custom",
    label: "自定义 (config.toml)",
    triggerLabel: "自定义",
    description: "使用 config.toml 中定义的权限。",
  },
] as const;
const AUTO_SCROLL_BOTTOM_THRESHOLD = 96;
const VIRTUAL_MESSAGE_ESTIMATE = 156;
const VIRTUAL_SCROLL_OVERSCAN = 900;
const USER_ANCHOR_MIN_VISIBLE = 4;
const USER_ANCHOR_LIMIT = 18;
const SPLIT_PANEL_MIN_WIDTH = 320;
const SPLIT_MAIN_MIN_WIDTH = 420;
let splitResizeCleanup: (() => void) | null = null;
let previewRequestId = 0;
const USER_ANCHOR_MIN_TOP_PERCENT = 8;
const USER_ANCHOR_MAX_TOP_PERCENT = 92;
const USER_ANCHOR_DOT_GAP_PX = 20;
const builtInProviders: AiProvider[] = [
  { id: "codex", name: "Codex", command: "codex", builtIn: true, enabled: true },
  { id: "claude", name: "Claude Code", command: "claude", builtIn: true, enabled: true },
  { id: "opencode", name: "OpenCode", command: "opencode", builtIn: true, enabled: true },
  { id: "mimo", name: "MiMo Code", command: "mimo", builtIn: true, enabled: true },
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
const showClaudeRunControls = computed(() => {
  const providerId = ws.activeAiSession.value?.providerId ?? selectedProvider.value?.id ?? ws.selectedProviderId.value;
  return providerId === "claude";
});
const showAcpRunControls = computed(() => {
  const providerId = ws.activeAiSession.value?.providerId ?? selectedProvider.value?.id ?? ws.selectedProviderId.value;
  return providerId === "opencode" || providerId === "mimo";
});
const acpProviderId = computed(() => ws.activeAiSession.value?.providerId ?? selectedProvider.value?.id ?? ws.selectedProviderId.value ?? "opencode");
const showModelRunControls = computed(() => showCodexRunControls.value || showClaudeRunControls.value || showAcpRunControls.value);
const codexModelOptions = computed(() => codexModels.value.filter((model) => model.model.trim().length > 0));
const chatHeaderMeta = computed(() => {
  if (!currentProject.value) return "选择项目后开始聊天";
  return `${currentProject.value.gitBranch ?? "未知分支"} · ${currentProject.value.gitDirty ? "有变更" : "Git 干净"}`;
});
const environmentBranchLabel = computed(() => (
  environmentInfo.value?.branch
  ?? currentProject.value?.gitBranch
  ?? "未知分支"
));
const environmentDirty = computed(() => environmentInfo.value?.dirty ?? currentProject.value?.gitDirty ?? false);
const environmentChangeText = computed(() => {
  const info = environmentInfo.value;
  if (!environmentDirty.value) return "干净";
  const parts = [
    info && info.additions > 0 ? `+${info.additions}` : "",
    info && info.deletions > 0 ? `-${info.deletions}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : "有变更";
});
const environmentCommitText = computed(() => {
  if (!environmentDirty.value) return "无需提交";
  if (environmentInfo.value?.githubCliAvailable) return "可提交或推送";
  return "GitHub CLI 不可用";
});
const previewFileExtension = computed(() => {
  const name = previewFile.value?.name ?? "";
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toUpperCase() : "FILE";
});
const conversationTitle = computed(() => ws.activeAiSession.value?.title ?? currentProject.value?.name ?? "新对话");
const showCreateHint = computed(() => !ws.activeAiSession.value && ws.createAiResult.value);
const pendingApprovalSegment = computed<Extract<ChatSegment, { type: "approval" }> | null>(() => {
  if (!ws.activeChatIsRunning.value) return null;
  for (let messageIndex = ws.chatMessages.value.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const segments = ws.chatMessages.value[messageIndex].segments ?? [];
    for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      const segment = segments[segmentIndex];
      if (segment.type === "approval" && segment.status === "pending") return segment;
    }
  }
  return null;
});

const approvalInputLocked = computed(() => Boolean(pendingApprovalSegment.value));
const canSend = computed(() => Boolean(ws.activeChatIsRunning.value || (!approvalInputLocked.value && (prompt.value.trim() || imageAttachments.value.length))));
const selectedApprovalMode = computed(() => approvalModes.find((mode) => mode.id === codexApprovalMode.value) ?? approvalModes[3]);
const selectedApprovalModeTriggerLabel = computed(() => selectedApprovalMode.value.triggerLabel);
type CodexReasoningOption = {
  id: CodexReasoningEffort;
  label: string;
  description: string;
};
const codexReasoningLabels: Record<CodexReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最大",
  ultra: "极致",
};
const fallbackCodexReasoningOptions: CodexReasoningOption[] = [
  { id: "low", label: codexReasoningLabels.low, description: "" },
  { id: "medium", label: codexReasoningLabels.medium, description: "" },
  { id: "high", label: codexReasoningLabels.high, description: "" },
  { id: "ultra", label: codexReasoningLabels.ultra, description: "" },
];
const claudeModelOptions = [
  { id: "sonnet", model: "sonnet", displayName: "Sonnet" },
  { id: "opus", model: "opus", displayName: "Opus" },
  { id: "fable", model: "fable", displayName: "Fable" },
  { id: "default", model: "", displayName: "默认" },
] as const;
const claudeReasoningOptions = [
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "超高" },
  { id: "max", label: "最大" },
] as const;
const selectedCodexModelOption = computed(() => codexModelOptions.value.find((model) => model.model === codexSelectedModel.value));
const codexReasoningOptions = computed<CodexReasoningOption[]>(() => {
  const supported = selectedCodexModelOption.value?.supportedReasoningEfforts ?? [];
  if (!supported.length) return fallbackCodexReasoningOptions;
  return supported.map((option) => ({
    id: option.reasoningEffort,
    label: codexReasoningLabels[option.reasoningEffort],
    description: option.description,
  }));
});
const selectedReasoningLabel = computed(() => codexReasoningOptions.value.find((option) => option.id === codexReasoningLevel.value)?.label ?? "默认");
const selectedClaudeReasoningLabel = computed(() => claudeReasoningOptions.find((option) => option.id === claudeReasoningLevel.value)?.label ?? "高");
const selectedCodexModelLabel = computed(() => {
  if (codexModelsLoading.value) return "加载中";
  if (!codexSelectedModel.value) return "默认";
  const selected = codexModelOptions.value.find((model) => model.model === codexSelectedModel.value);
  return selected?.displayName ?? codexSelectedModel.value;
});
const selectedClaudeModelLabel = computed(() => {
  if (!claudeSelectedModel.value) return "默认";
  return claudeModelOptions.find((model) => model.model === claudeSelectedModel.value)?.displayName ?? claudeSelectedModel.value;
});
const selectedCodexModelShortLabel = computed(() => {
  const label = selectedCodexModelLabel.value.trim();
  return label
    .replace(/^gpt[-_\s]*/i, "")
    .replace(/^claude[-_\s]*/i, "")
    .replace(/^codex[-_\s]*/i, "")
    .replace(/^openai[-_\s]*/i, "");
});
const selectedCodexModelButtonLabel = computed(() => `${selectedCodexModelShortLabel.value} ${selectedReasoningLabel.value}`);
const acpModelOptions = computed(() => acpModels.value.map((m) => ({ id: m.value, model: m.value, displayName: m.name })));
const acpEffortOptions = computed(() => {
  if (acpEfforts.value.length) return acpEfforts.value.map((e) => ({ id: e.value, label: e.name }));
  return [{ id: "low", label: "低" }, { id: "medium", label: "中" }, { id: "high", label: "高" }, { id: "max", label: "最大" }];
});
const selectedAcpModelLabel = computed(() => {
  if (!acpSelectedModel.value) return "默认";
  return acpModels.value.find((m) => m.value === acpSelectedModel.value)?.name ?? acpSelectedModel.value;
});
const selectedAcpReasoningLabel = computed(() => {
  if (!acpReasoningLevel.value) return "默认";
  return acpEfforts.value.find((e) => e.value === acpReasoningLevel.value)?.name ?? acpReasoningLevel.value;
});
const activeModelOptions = computed(() => {
  if (showAcpRunControls.value) return acpModelOptions.value;
  if (showClaudeRunControls.value) return claudeModelOptions;
  return codexModelOptions.value;
});
const activeReasoningOptions = computed(() => {
  if (showAcpRunControls.value) return acpEffortOptions.value;
  if (showClaudeRunControls.value) return claudeReasoningOptions;
  return codexReasoningOptions.value;
});
const selectedModelLabel = computed(() => {
  if (showAcpRunControls.value) return selectedAcpModelLabel.value;
  if (showClaudeRunControls.value) return selectedClaudeModelLabel.value;
  return selectedCodexModelLabel.value;
});
const selectedModelValue = computed(() => {
  if (showAcpRunControls.value) return acpSelectedModel.value;
  if (showClaudeRunControls.value) return claudeSelectedModel.value;
  return codexSelectedModel.value;
});
const selectedReasoningValue = computed(() => {
  if (showAcpRunControls.value) return acpReasoningLevel.value;
  if (showClaudeRunControls.value) return claudeReasoningLevel.value;
  return codexReasoningLevel.value;
});
const selectedReasoningMenuLabel = computed(() => {
  if (showAcpRunControls.value) return selectedAcpReasoningLabel.value;
  if (showClaudeRunControls.value) return selectedClaudeReasoningLabel.value;
  return selectedReasoningLabel.value;
});
const selectedModelButtonLabel = computed(() => {
  if (showAcpRunControls.value) return `${selectedAcpModelLabel.value} ${selectedAcpReasoningLabel.value}`;
  if (showClaudeRunControls.value) return `${selectedClaudeModelLabel.value} ${selectedClaudeReasoningLabel.value}`;
  return selectedCodexModelButtonLabel.value;
});
const modelPickerTitle = computed(() => {
  if (showAcpRunControls.value) return `选择 ${acpProviderId.value === "mimo" ? "MiMo" : "OpenCode"} 模型`;
  if (showClaudeRunControls.value) return "选择 Claude 模型";
  return "选择 Codex 模型";
});
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
  if (message.role === "user") return message.images?.length ? 170 : 96;
  const textLength = message.text?.length ?? 0;
  const segmentCount = message.segments?.length ?? 0;
  const imageHeight = message.images?.length ? 118 : 0;
  return Math.min(520, Math.max(112, 72 + Math.ceil(textLength / 48) * 24 + segmentCount * 38 + imageHeight));
}

function updateVirtualViewport() {
  if (splitPanelOpen.value) splitPanelWidth.value = clampSplitPanelWidth(splitPanelWidth.value);
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
  if (!startMenuOpen.value && !approvalMenuOpen.value && !composerToolsOpen.value && !modelMenuOpen.value && !modelSubmenuOpen.value && !environmentPanelOpen.value) return;
  if (isFloatingMenuTarget(event.target)) return;
  startMenuOpen.value = false;
  approvalMenuOpen.value = false;
  composerToolsOpen.value = false;
  modelMenuOpen.value = false;
  modelSubmenuOpen.value = false;
  environmentPanelOpen.value = false;
}

function toggleApprovalMenu() {
  if (!showCodexRunControls.value) return;
  approvalMenuOpen.value = !approvalMenuOpen.value;
  if (approvalMenuOpen.value) {
    startMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
    environmentPanelOpen.value = false;
  }
}

function selectApprovalMode(mode: CodexApprovalMode) {
  codexApprovalSelectionVersion += 1;
  codexApprovalMode.value = mode;
  approvalMenuOpen.value = false;
}

function toggleComposerToolsMenu() {
  if (!showModelRunControls.value) return;
  composerToolsOpen.value = !composerToolsOpen.value;
  if (composerToolsOpen.value) {
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
    environmentPanelOpen.value = false;
  }
}

async function openCurrentProjectLocation() {
  const project = currentProject.value;
  if (!project) return;
  await desktopApi.openProjectInFileManager(project.path);
}

async function refreshEnvironmentInfo() {
  const project = currentProject.value;
  if (!project) {
    environmentInfo.value = null;
    environmentError.value = "";
    return;
  }
  environmentLoading.value = true;
  environmentError.value = "";
  try {
    environmentInfo.value = await desktopApi.getProjectEnvironment(project.path);
  } catch (error) {
    environmentError.value = String(error);
  } finally {
    environmentLoading.value = false;
  }
}

function toggleEnvironmentPanel() {
  environmentPanelOpen.value = !environmentPanelOpen.value;
  if (environmentPanelOpen.value) {
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
    void refreshEnvironmentInfo();
  }
}

function clampSplitPanelWidth(width: number) {
  const workspaceWidth = splitWorkspace.value?.getBoundingClientRect().width ?? 0;
  if (!workspaceWidth) return Math.max(SPLIT_PANEL_MIN_WIDTH, width);
  const maxWidth = Math.max(SPLIT_PANEL_MIN_WIDTH, workspaceWidth - SPLIT_MAIN_MIN_WIDTH);
  return Math.min(Math.max(width, SPLIT_PANEL_MIN_WIDTH), maxWidth);
}

function openSplitPanel() {
  if (!splitPanelOpen.value) splitPanelOpen.value = true;
  startMenuOpen.value = false;
  approvalMenuOpen.value = false;
  composerToolsOpen.value = false;
  modelMenuOpen.value = false;
  modelSubmenuOpen.value = false;
  environmentPanelOpen.value = false;
  void nextTick(() => {
    splitPanelWidth.value = clampSplitPanelWidth(splitPanelWidth.value);
  });
}

function toggleSplitPanel() {
  splitPanelOpen.value = !splitPanelOpen.value;
  if (splitPanelOpen.value) {
    openSplitPanel();
  } else if (splitResizeCleanup) {
    splitResizeCleanup();
  }
}

function previewFileSizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function loadFilePreview(projectPath: string, filePath: string) {
  const requestId = ++previewRequestId;
  openSplitPanel();
  previewLoading.value = true;
  previewError.value = "";
  try {
    const result = await desktopApi.readProjectFilePreview(projectPath, filePath);
    if (requestId !== previewRequestId) return;
    previewFile.value = result;
  } catch (error) {
    if (requestId !== previewRequestId) return;
    previewError.value = String(error);
  } finally {
    if (requestId === previewRequestId) previewLoading.value = false;
  }
}

function onDesktopPreviewFile(event: Event) {
  const detail = (event as CustomEvent<{ projectPath?: string; filePath?: string }>).detail;
  if (!detail?.projectPath || !detail.filePath) return;
  void loadFilePreview(detail.projectPath, detail.filePath);
}

function stopSplitResize() {
  if (!splitResizeCleanup) return;
  splitResizeCleanup();
}

function startSplitResize(event: PointerEvent) {
  if (!splitPanelOpen.value) return;
  event.preventDefault();
  stopSplitResize();
  const startX = event.clientX;
  const startWidth = splitPanelWidth.value;
  document.body.classList.add("chat-split-resizing");

  const onPointerMove = (moveEvent: PointerEvent) => {
    splitPanelWidth.value = clampSplitPanelWidth(startWidth + startX - moveEvent.clientX);
  };
  const onPointerUp = () => {
    stopSplitResize();
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  splitResizeCleanup = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    document.body.classList.remove("chat-split-resizing");
    splitResizeCleanup = null;
  };
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
  if (!showModelRunControls.value || (showCodexRunControls.value && codexModelsLoading.value)) return;
  modelMenuOpen.value = !modelMenuOpen.value;
  modelSubmenuOpen.value = false;
  if (modelMenuOpen.value) {
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
    environmentPanelOpen.value = false;
  }
}

function toggleModelSubmenu(kind: ModelSubmenuKind) {
  if (!modelMenuOpen.value) return;
  if (modelSubmenuOpen.value && modelSubmenuKind.value === kind) {
    modelSubmenuOpen.value = false;
    return;
  }
  modelSubmenuKind.value = kind;
  modelSubmenuOpen.value = true;
}

function reconcileCodexModelSettings() {
  const supportedEfforts = codexReasoningOptions.value.map((option) => option.id);
  if (!codexReasoningLevel.value || !supportedEfforts.includes(codexReasoningLevel.value)) {
    const modelDefault = selectedCodexModelOption.value?.defaultReasoningEffort;
    codexReasoningLevel.value = modelDefault && supportedEfforts.includes(modelDefault)
      ? modelDefault
      : supportedEfforts.includes("high")
        ? "high"
        : supportedEfforts[0] ?? null;
  }
}

function selectModel(model: string) {
  if (showAcpRunControls.value) {
    acpSelectedModel.value = model;
  } else if (showClaudeRunControls.value) {
    claudeSelectedModel.value = model;
  } else {
    codexSelectedModel.value = model;
    reconcileCodexModelSettings();
  }
  persistRunPreferences();
  modelSubmenuOpen.value = false;
  modelMenuOpen.value = false;
}

function selectReasoningLevel(level: string) {
  if (showAcpRunControls.value) {
    acpReasoningLevel.value = level;
  } else if (showClaudeRunControls.value) {
    const option = claudeReasoningOptions.find((candidate) => candidate.id === level);
    if (option) claudeReasoningLevel.value = option.id;
  } else {
    const option = codexReasoningOptions.value.find((candidate) => candidate.id === level);
    if (option) codexReasoningLevel.value = option.id;
  }
  persistRunPreferences();
  modelSubmenuOpen.value = false;
  modelMenuOpen.value = false;
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
    reconcileCodexModelSettings();
    publishRunSettings();
  } catch (error) {
    console.warn("Codex model list failed", error);
  } finally {
    codexModelsLoading.value = false;
  }
}

async function loadCodexApprovalMode() {
  const projectPath = currentProject.value?.path ?? "";
  if (codexApprovalModeLoadedPath === projectPath || codexApprovalModeRequestedPath === projectPath) return;
  const loadId = ++codexApprovalModeLoadId;
  const selectionVersion = codexApprovalSelectionVersion;
  codexApprovalModeRequestedPath = projectPath;
  try {
    const mode = await desktopApi.getCodexApprovalMode(projectPath);
    if (loadId !== codexApprovalModeLoadId) return;
    codexApprovalModeLoadedPath = projectPath;
    if (selectionVersion === codexApprovalSelectionVersion) codexApprovalMode.value = mode;
  } catch (error) {
    console.warn("Codex approval config read failed", error);
  } finally {
    if (loadId === codexApprovalModeLoadId) codexApprovalModeRequestedPath = null;
  }
}

async function loadAcpModels() {
  const providerId = acpProviderId.value;
  if (providerId !== "opencode" && providerId !== "mimo") return;
  const savedPreference = runPreferences[providerId];
  const projectPath = currentProject.value?.path ?? "";
  const configKey = `${providerId}\u0000${projectPath}`;
  if (acpModelsLoadedKey === configKey || acpModelsRequestedKey === configKey) return;
  const loadId = ++acpModelsLoadId;
  acpModelsRequestedKey = configKey;
  if (acpModelsLoadedKey !== configKey) {
    acpModels.value = [];
    acpEfforts.value = [];
    acpSelectedModel.value = savedPreference?.model ?? "";
    acpReasoningLevel.value = savedPreference?.reasoningEffort ?? "";
  }
  acpModelsLoading.value = true;
  try {
    const options = providerId === "mimo"
      ? await desktopApi.listMimoConfigOptions(projectPath)
      : await desktopApi.listOpenCodeConfigOptions(projectPath);
    if (loadId !== acpModelsLoadId) return;
    acpModels.value = options.models;
    acpEfforts.value = options.efforts;
    acpModelsLoadedKey = configKey;
    const defaultModel = options.models.find((m) => m.isDefault) ?? options.models[0];
    const preferredModel = savedPreference?.model || acpSelectedModel.value;
    if (options.models.some((model) => model.value === preferredModel)) {
      acpSelectedModel.value = preferredModel;
    } else if (defaultModel) {
      acpSelectedModel.value = defaultModel.value;
    }
    const defaultEffort = options.efforts.find((effort) => effort.isDefault);
    const preferredEffort = savedPreference?.reasoningEffort || acpReasoningLevel.value;
    if (options.efforts.some((effort) => effort.value === preferredEffort)) {
      acpReasoningLevel.value = preferredEffort;
    } else {
      acpReasoningLevel.value = defaultEffort?.value ?? "";
    }
  } catch (error) {
    console.warn(`${providerId} config options failed`, error);
  } finally {
    if (loadId === acpModelsLoadId) {
      acpModelsRequestedKey = "";
      acpModelsLoading.value = false;
    }
  }
}

function persistRunPreferences() {
  runPreferences.codex = {
    model: codexSelectedModel.value,
    reasoningEffort: codexReasoningLevel.value ?? "",
  };
  runPreferences.claude = {
    model: claudeSelectedModel.value,
    reasoningEffort: claudeReasoningLevel.value,
  };
  const providerId = acpProviderId.value;
  if (providerId === "opencode" || providerId === "mimo") {
    runPreferences[providerId] = {
      model: acpSelectedModel.value,
      reasoningEffort: acpReasoningLevel.value,
    };
  }
  try {
    window.localStorage.setItem(runPreferencesStorageKey, JSON.stringify(runPreferences));
  } catch {
    // Preferences are best-effort; the current window still keeps the selection.
  }
}

function publishRunSettings() {
  const settings: Partial<AiRunSettingsState> = {
    codex: {
      providerId: "codex",
      model: codexSelectedModel.value,
      reasoningEffort: codexReasoningLevel.value ?? "",
      models: codexModels.value,
      reasoningOptions: codexReasoningOptions.value.map((option) => option.id),
      serviceTier: null,
    },
    claude: {
      providerId: "claude",
      model: claudeSelectedModel.value,
      reasoningEffort: claudeReasoningLevel.value,
      models: claudeModelOptions.map((option) => ({
        id: option.id,
        model: option.model,
        displayName: option.displayName,
      })),
      reasoningOptions: claudeReasoningOptions.map((option) => option.id),
    },
  };
  const providerId = acpProviderId.value;
  const providerSettings = {
    providerId,
    model: acpSelectedModel.value,
    reasoningEffort: acpReasoningLevel.value,
    models: acpModels.value.map((option) => ({
      id: option.value,
      model: option.value,
      displayName: option.name,
      description: option.description,
      isDefault: option.isDefault,
    })),
    reasoningOptions: acpEfforts.value.map((option) => option.value),
  };
  if (providerId === "mimo") settings.mimo = { ...providerSettings, providerId: "mimo" };
  else if (providerId === "opencode") settings.opencode = { ...providerSettings, providerId: "opencode" };
  void desktopApi.publishAiRunSettings(settings);
}

function applyRunSettingsUpdate(event: { providerId?: string; model?: string; reasoningEffort?: string; serviceTier?: string | null }) {
  if (event.providerId === "codex") {
    if (typeof event.model === "string" && event.model) codexSelectedModel.value = event.model;
    if (event.reasoningEffort === "low" || event.reasoningEffort === "medium" || event.reasoningEffort === "high" || event.reasoningEffort === "xhigh" || event.reasoningEffort === "max" || event.reasoningEffort === "ultra") {
      codexReasoningLevel.value = event.reasoningEffort;
    }
    if (codexModelsLoaded.value) reconcileCodexModelSettings();
    return;
  }
  if (event.providerId === "claude") {
    if (typeof event.model === "string") claudeSelectedModel.value = event.model;
    if (event.reasoningEffort === "low" || event.reasoningEffort === "medium" || event.reasoningEffort === "high" || event.reasoningEffort === "xhigh" || event.reasoningEffort === "max") {
      claudeReasoningLevel.value = event.reasoningEffort;
    }
    return;
  }
  if (event.providerId === acpProviderId.value) {
    if (typeof event.model === "string") acpSelectedModel.value = event.model;
    if (typeof event.reasoningEffort === "string") acpReasoningLevel.value = event.reasoningEffort;
  }
}

function setCodexMode(mode: CodexRunMode) {
  codexMode.value = mode;
}

function buildRunOptions(): AiChatOptions {
  const goal = codexGoalEnabled.value ? (codexGoal.value.trim() || prompt.value.trim()) : "";
  if (showClaudeRunControls.value) {
    return {
      claudeModel: claudeSelectedModel.value || null,
      claudeReasoningEffort: claudeReasoningLevel.value,
      claudeMode: codexMode.value,
      claudeGoal: goal || null,
    };
  }
  if (showAcpRunControls.value) {
    const mode = codexMode.value === "plan" ? "plan" : "build";
    return acpProviderId.value === "mimo"
      ? {
          mimoModel: acpSelectedModel.value || null,
          mimoVariant: acpReasoningLevel.value || null,
          mimoAgent: mode,
          codexGoal: goal || null,
        }
      : {
          opencodeModel: acpSelectedModel.value || null,
          opencodeEffort: acpReasoningLevel.value || null,
          opencodeMode: mode,
          codexGoal: goal || null,
        };
  }
  if (!showCodexRunControls.value) return {};
  return {
    approvalMode: codexApprovalMode.value,
    codexMode: codexMode.value,
    codexModel: codexSelectedModel.value || null,
    codexReasoningEffort: codexReasoningLevel.value,
    codexServiceTier: null,
    codexGoal: goal || null,
  };
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && previewImage.value) {
    event.preventDefault();
    previewImage.value = null;
    return;
  }
  if (event.key === "Escape" && (startMenuOpen.value || approvalMenuOpen.value || composerToolsOpen.value || modelMenuOpen.value || modelSubmenuOpen.value || environmentPanelOpen.value)) {
    event.preventDefault();
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
    environmentPanelOpen.value = false;
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
  () => currentProject.value?.path,
  () => {
    environmentInfo.value = null;
    environmentError.value = "";
    codexApprovalModeLoadedPath = null;
    acpModelsLoadedKey = "";
    if (showCodexRunControls.value) void loadCodexApprovalMode();
    if (showAcpRunControls.value) void loadAcpModels();
    if (environmentPanelOpen.value) void refreshEnvironmentInfo();
  },
);

watch(
  () => showCodexRunControls.value,
  (visible) => {
    if (visible) {
      void loadCodexModels();
      void loadCodexApprovalMode();
    }
    else approvalMenuOpen.value = false;
  },
  { immediate: true },
);
watch(
  [() => showAcpRunControls.value, acpProviderId],
  ([visible]) => {
    if (visible) void loadAcpModels();
  },
  { immediate: true },
);

watch(
  () => showModelRunControls.value,
  (visible) => {
    if (!visible) {
      composerToolsOpen.value = false;
      modelMenuOpen.value = false;
      modelSubmenuOpen.value = false;
    }
  },
  { immediate: true },
);

watch(
  [codexSelectedModel, codexReasoningLevel, claudeSelectedModel, claudeReasoningLevel, acpProviderId, acpSelectedModel, acpReasoningLevel, acpModels, acpEfforts],
  () => {
    persistRunPreferences();
    publishRunSettings();
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
  window.addEventListener("desktop-preview-file", onDesktopPreviewFile);
  window.addEventListener("keydown", onWindowKeydown);
  window.addEventListener("resize", updateVirtualViewport);
  observeChatScroll();
  void nextTick(updateVirtualViewport);
  void desktopApi.onAiRunSettingsUpdate(applyRunSettingsUpdate).then((remove) => {
    removeAiRunSettingsUpdateListener = remove;
  });
});

onBeforeUnmount(() => {
  stopSplitResize();
  document.removeEventListener("pointerdown", closeFloatingMenusOnOutsideClick);
  window.removeEventListener("desktop-preview-file", onDesktopPreviewFile);
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("resize", updateVirtualViewport);
  chatScrollResizeObserver?.disconnect();
  for (const observer of virtualRowObservers.values()) observer.disconnect();
  virtualRowObservers.clear();
  virtualRowElements.clear();
  removeAiRunSettingsUpdateListener?.();
  removeAiRunSettingsUpdateListener = null;
});

async function send() {
  if (ws.activeChatIsRunning.value) {
    await ws.stopActiveAiChat();
    return;
  }
  if (approvalInputLocked.value) return;
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
    await ws.sendPrompt(value, images, buildRunOptions());
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
    environmentPanelOpen.value = false;
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
          <div v-if="showModelRunControls" class="codex-composer-add-wrap codex-start-tools-wrap">
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
            <span>{{ selectedApprovalModeTriggerLabel }}</span>
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
                <svg v-else-if="mode.id === 'fullAccess'" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.9 13 3.8v3.7c0 3.05-2.05 5.35-5 6.6-2.95-1.25-5-3.55-5-6.6V3.8l5-1.9Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
                  <path d="M8 5.05v3.35" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                  <path d="M8 10.85h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
                <svg v-else viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.25" />
                  <path d="M6.7 2.1h2.6l.35 1.45c.3.12.58.29.84.49l1.43-.44 1.3 2.25-1.08 1.02c.02.17.03.34.03.51s-.01.34-.03.51l1.08 1.02-1.3 2.25-1.43-.44c-.26.2-.54.37-.84.49L9.3 13.9H6.7l-.35-1.45a5.3 5.3 0 0 1-.84-.49l-1.43.44-1.3-2.25 1.08-1.02a4.3 4.3 0 0 1 0-1.02L2.78 5.85l1.3-2.25 1.43.44c.26-.2.54-.37.84-.49L6.7 2.1Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" />
                </svg>
              </span>
              <span class="codex-approval-copy">
                <strong>{{ mode.label }}</strong>
                <small>{{ mode.description }}</small>
              </span>
              <span v-if="mode.id === codexApprovalMode" class="codex-approval-check" aria-hidden="true">✓</span>
            </button>
          </div>
          <div v-if="showModelRunControls" class="codex-run-controls start-run-controls">
            <div class="codex-run-mode" role="group" aria-label="运行模式">
              <button type="button" :class="{ active: codexMode === 'default' }" @click="setCodexMode('default')">默认</button>
              <button type="button" :class="{ active: codexMode === 'plan' }" @click="setCodexMode('plan')">计划</button>
            </div>
            <div class="codex-model-picker codex-model-picker-custom" :title="modelPickerTitle">
              <button
                class="codex-model-button"
                :class="{ open: modelMenuOpen }"
                :disabled="(showCodexRunControls && codexModelsLoading) || (showAcpRunControls && acpModelsLoading)"
                type="button"
                @click="toggleModelMenu"
                :aria-label="modelPickerTitle"
              >
                <span>{{ selectedModelButtonLabel }}</span>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <div v-if="modelMenuOpen" class="codex-model-menu codex-model-menu-compact">
                <div class="codex-model-menu-section">
                  <button
                    type="button"
                    class="codex-model-menu-row"
                    :class="{ active: modelSubmenuOpen && modelSubmenuKind === 'model' }"
                    :aria-expanded="modelSubmenuOpen && modelSubmenuKind === 'model'"
                    @click.stop="toggleModelSubmenu('model')"
                  >
                    <span class="codex-model-menu-row-label">模型</span>
                    <span class="codex-model-menu-row-value">{{ selectedModelLabel }}</span>
                    <svg class="codex-model-submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M6 4.5 9.5 8 6 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <div v-if="modelSubmenuOpen && modelSubmenuKind === 'model'" class="codex-model-submenu">
                    <div class="codex-model-menu-heading">模型</div>
                    <button
                      v-for="model in activeModelOptions"
                      :key="model.id"
                      type="button"
                      :class="{ active: model.model === selectedModelValue }"
                      @click="selectModel(model.model)"
                    >
                      <span>{{ model.displayName }}</span>
                      <span class="codex-model-menu-check" aria-hidden="true">{{ model.model === selectedModelValue ? "✓" : "" }}</span>
                    </button>
                  </div>
                </div>
                <div class="codex-model-menu-section">
                  <button
                    type="button"
                    class="codex-model-menu-row"
                    :class="{ active: modelSubmenuOpen && modelSubmenuKind === 'reasoning' }"
                    :aria-expanded="modelSubmenuOpen && modelSubmenuKind === 'reasoning'"
                    @click.stop="toggleModelSubmenu('reasoning')"
                  >
                    <span class="codex-model-menu-row-label">推理强度</span>
                    <span class="codex-model-menu-row-value">{{ selectedReasoningMenuLabel }}</span>
                    <svg class="codex-model-submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M6 4.5 9.5 8 6 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <div v-if="modelSubmenuOpen && modelSubmenuKind === 'reasoning'" class="codex-model-submenu">
                    <div class="codex-model-menu-heading">推理强度</div>
                    <button
                      v-for="option in activeReasoningOptions"
                      :key="option.id"
                      type="button"
                      :class="{ active: option.id === selectedReasoningValue }"
                      @click="selectReasoningLevel(option.id)"
                    >
                      <span>{{ option.label }}</span>
                      <span class="codex-model-menu-check" aria-hidden="true">{{ option.id === selectedReasoningValue ? "✓" : "" }}</span>
                    </button>
                  </div>
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
        <button
          type="button"
          class="chat-topbar-action location"
          :disabled="!currentProject"
          title="打开项目位置"
          @click="openCurrentProjectLocation"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 5.6 8 2l5 3.6v7.1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.6Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
            <path d="M6.2 13.7V9.2h3.6v4.5" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
          </svg>
          <span>打开位置</span>
          <svg class="chat-topbar-action-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4.5 6.5 3.5 3 3.5-3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="chat-topbar-icon-action"
          :class="{ open: environmentPanelOpen }"
          title="环境信息"
          aria-label="环境信息"
          :aria-expanded="environmentPanelOpen"
          @click="toggleEnvironmentPanel"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.2 4.5h9.6M3.2 8h9.6M3.2 11.5h9.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <circle cx="5.2" cy="4.5" r="1.15" fill="currentColor" />
            <circle cx="10.8" cy="8" r="1.15" fill="currentColor" />
            <circle cx="7.4" cy="11.5" r="1.15" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          class="chat-topbar-mini-action"
          :class="{ active: splitPanelOpen }"
          :title="splitPanelOpen ? '关闭分割面板' : '打开分割面板'"
          :aria-label="splitPanelOpen ? '关闭分割面板' : '打开分割面板'"
          :aria-pressed="splitPanelOpen"
          @click="toggleSplitPanel"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="2" stroke="currentColor" stroke-width="1.35" />
            <path d="M10.5 3v10" stroke="currentColor" stroke-width="1.35" />
          </svg>
        </button>
      </div>
      <div v-if="environmentPanelOpen" class="environment-popover">
        <header class="environment-popover-header">
          <strong>环境信息</strong>
          <button type="button" title="刷新环境信息" aria-label="刷新环境信息" @click="refreshEnvironmentInfo">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
            </svg>
          </button>
        </header>
        <div class="environment-popover-list">
          <div class="environment-row">
            <span class="environment-row-icon">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4h8v8H4z" stroke="currentColor" stroke-width="1.35" />
                <path d="M8 5.5v5M5.5 8h5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
              </svg>
            </span>
            <span>变更</span>
            <strong :class="{ clean: !environmentDirty, dirty: environmentDirty }">{{ environmentLoading ? "读取中" : environmentChangeText }}</strong>
          </div>
          <div class="environment-row">
            <span class="environment-row-icon">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 5h10v6.5A1.5 1.5 0 0 1 11.5 13h-7A1.5 1.5 0 0 1 3 11.5V5Z" stroke="currentColor" stroke-width="1.35" />
                <path d="M5 5V3.8h6V5" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
              </svg>
            </span>
            <span>本地</span>
            <small>{{ currentProject?.path ?? "暂无项目" }}</small>
          </div>
          <div class="environment-row">
            <span class="environment-row-icon">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5 3.5v5.2a2.3 2.3 0 0 0 2.3 2.3H11" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                <circle cx="5" cy="3.5" r="1.5" stroke="currentColor" stroke-width="1.35" />
                <circle cx="11" cy="11" r="1.5" stroke="currentColor" stroke-width="1.35" />
              </svg>
            </span>
            <span>{{ environmentBranchLabel }}</span>
          </div>
          <div class="environment-row">
            <span class="environment-row-icon">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3.2v8.2M4.7 6.5 8 3.2l3.3 3.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M4 12.8h8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
              </svg>
            </span>
            <span>提交或推送</span>
          </div>
          <div class="environment-row muted">
            <span class="environment-row-icon">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="5.2" stroke="currentColor" stroke-width="1.35" />
                <path d="M6.2 10.2 9.8 6.6M6.2 6.6l3.6 3.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
              </svg>
            </span>
            <span>{{ environmentError || environmentCommitText }}</span>
          </div>
        </div>
        <footer class="environment-popover-source">
          <span>来源</span>
          <strong>暂无来源</strong>
        </footer>
      </div>
    </header>
    <nav class="chat-mode-tabs" aria-label="聊天视图切换">
      <button type="button" :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">聊天</button>
      <button type="button" :class="{ active: activeTab === 'terminal' }" @click="activeTab = 'terminal'">终端</button>
    </nav>
    <section
      ref="splitWorkspace"
      class="chat-workspace"
      :class="{
        'terminal-mode': activeTab === 'terminal' && Boolean(ws.activeAiSession.value),
        'terminal-empty-mode': activeTab === 'terminal' && !ws.activeAiSession.value,
        'split-mode': splitPanelOpen,
      }"
      :style="{ '--chat-split-panel-width': `${splitPanelWidth}px` }"
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
          v-if="activeTab === 'chat' && showModelRunControls && codexGoalEnabled"
          class="codex-goal-bar"
        >
          <svg class="codex-goal-bar-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.35" />
            <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.35" />
            <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
          </svg>
          <input
            v-model="codexGoal"
            class="codex-goal-bar-input"
            type="text"
            placeholder="这轮工作的目标"
            aria-label="这轮工作的目标"
          />
          <button type="button" class="codex-goal-bar-action danger" title="关闭目标模式" @click="toggleComposerGoalMode">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </div>
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
          <textarea
            v-model="prompt"
            rows="3"
            :placeholder="approvalInputLocked ? '审批期间输入框已锁定' : '输入你的消息...'"
            :disabled="approvalInputLocked"
            @keydown="onPromptKeydown"
            @paste="onPromptPaste"
          ></textarea>
          <div class="chat-composer-divider"></div>
          <div class="chat-composer-toolbar">
            <div class="chat-composer-toolbar-left">
              <div v-if="showModelRunControls" class="codex-composer-add-wrap">
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
                v-if="showCodexRunControls"
                class="codex-approval-trigger chat-approval-trigger"
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
                <span>{{ selectedApprovalModeTriggerLabel }}</span>
              </button>
              <button
                v-if="showModelRunControls && codexMode === 'plan'"
                class="codex-mode-chip codex-plan-chip"
                title="关闭计划模式"
                type="button"
                @click="setCodexMode('default')"
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4h3.5M8.5 4H12M4 8h8M4 12h3.5M8.5 12H12" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                </svg>
                <span>计划</span>
                <small>已开启</small>
              </button>
              <button
                v-if="showModelRunControls && codexGoalEnabled"
                class="codex-mode-chip codex-goal-chip"
                title="关闭目标模式"
                type="button"
                @click="toggleComposerGoalMode"
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.35" />
                  <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.35" />
                </svg>
                <span>目标</span>
                <small>已开启</small>
              </button>
            </div>
            <div class="chat-composer-toolbar-right">
              <div v-if="showModelRunControls" class="codex-model-picker codex-model-picker-custom" :title="modelPickerTitle">
                <button
                  class="codex-model-button"
                  :class="{ open: modelMenuOpen }"
                  :disabled="(showCodexRunControls && codexModelsLoading) || (showAcpRunControls && acpModelsLoading)"
                  type="button"
                  @click="toggleModelMenu"
                  :aria-label="modelPickerTitle"
                >
                  <span>{{ selectedModelButtonLabel }}</span>
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <div v-if="modelMenuOpen" class="codex-model-menu codex-model-menu-compact">
                  <div class="codex-model-menu-section">
                    <button
                      type="button"
                      class="codex-model-menu-row"
                      :class="{ active: modelSubmenuOpen && modelSubmenuKind === 'model' }"
                      :aria-expanded="modelSubmenuOpen && modelSubmenuKind === 'model'"
                      @click.stop="toggleModelSubmenu('model')"
                    >
                      <span class="codex-model-menu-row-label">模型</span>
                      <span class="codex-model-menu-row-value">{{ selectedModelLabel }}</span>
                      <svg class="codex-model-submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M6 4.5 9.5 8 6 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <div v-if="modelSubmenuOpen && modelSubmenuKind === 'model'" class="codex-model-submenu">
                      <div class="codex-model-menu-heading">模型</div>
                      <button
                        v-for="model in activeModelOptions"
                        :key="model.id"
                        type="button"
                        :class="{ active: model.model === selectedModelValue }"
                        @click="selectModel(model.model)"
                      >
                        <span>{{ model.displayName }}</span>
                        <span class="codex-model-menu-check" aria-hidden="true">{{ model.model === selectedModelValue ? "✓" : "" }}</span>
                      </button>
                    </div>
                  </div>
                  <div class="codex-model-menu-section">
                    <button
                      type="button"
                      class="codex-model-menu-row"
                      :class="{ active: modelSubmenuOpen && modelSubmenuKind === 'reasoning' }"
                      :aria-expanded="modelSubmenuOpen && modelSubmenuKind === 'reasoning'"
                      @click.stop="toggleModelSubmenu('reasoning')"
                    >
                      <span class="codex-model-menu-row-label">推理强度</span>
                      <span class="codex-model-menu-row-value">{{ selectedReasoningMenuLabel }}</span>
                      <svg class="codex-model-submenu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M6 4.5 9.5 8 6 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <div v-if="modelSubmenuOpen && modelSubmenuKind === 'reasoning'" class="codex-model-submenu">
                      <div class="codex-model-menu-heading">推理强度</div>
                      <button
                        v-for="option in activeReasoningOptions"
                        :key="option.id"
                        type="button"
                        :class="{ active: option.id === selectedReasoningValue }"
                        @click="selectReasoningLevel(option.id)"
                      >
                        <span>{{ option.label }}</span>
                        <span class="codex-model-menu-check" aria-hidden="true">{{ option.id === selectedReasoningValue ? "✓" : "" }}</span>
                      </button>
                    </div>
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
                <svg v-else-if="mode.id === 'fullAccess'" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.9 13 3.8v3.7c0 3.05-2.05 5.35-5 6.6-2.95-1.25-5-3.55-5-6.6V3.8l5-1.9Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" />
                  <path d="M8 5.05v3.35" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
                  <path d="M8 10.85h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
                <svg v-else viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.25" />
                  <path d="M6.7 2.1h2.6l.35 1.45c.3.12.58.29.84.49l1.43-.44 1.3 2.25-1.08 1.02c.02.17.03.34.03.51s-.01.34-.03.51l1.08 1.02-1.3 2.25-1.43-.44c-.26.2-.54.37-.84.49L9.3 13.9H6.7l-.35-1.45a5.3 5.3 0 0 1-.84-.49l-1.43.44-1.3-2.25 1.08-1.02a4.3 4.3 0 0 1 0-1.02L2.78 5.85l1.3-2.25 1.43.44c.26-.2.54-.37.84-.49L6.7 2.1Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" />
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
      </article>
      <button
        v-if="splitPanelOpen"
        type="button"
        class="chat-split-resizer"
        title="拖动调整面板宽度"
        aria-label="拖动调整面板宽度"
        @pointerdown="startSplitResize"
      ></button>
      <aside v-if="splitPanelOpen" class="chat-split-panel">
        <header class="chat-split-panel-header">
          <div class="chat-split-panel-title">
            <strong>{{ previewFile?.name ?? "文件预览" }}</strong>
            <small v-if="previewFile">{{ previewFileExtension }} · {{ previewFileSizeLabel(previewFile.size) }}</small>
          </div>
          <button type="button" title="关闭分割面板" aria-label="关闭分割面板" @click="toggleSplitPanel">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" />
            </svg>
          </button>
        </header>
        <div class="chat-split-panel-body">
          <div v-if="previewLoading" class="chat-split-panel-empty">
            <strong>正在读取文件</strong>
            <span>请稍候。</span>
          </div>
          <div v-else-if="previewError" class="chat-split-panel-empty error">
            <strong>预览失败</strong>
            <span>{{ previewError }}</span>
          </div>
          <div v-else-if="!previewFile" class="chat-split-panel-empty">
            <strong>选择文件开始预览</strong>
            <span>在左侧项目文件树中点击文件。</span>
          </div>
          <div v-else class="chat-file-preview">
            <div class="chat-file-preview-path" :title="previewFile.path">{{ previewFile.path }}</div>
            <img
              v-if="previewFile.previewKind === 'image' && previewFile.dataUrl"
              class="chat-file-preview-image"
              :src="previewFile.dataUrl"
              :alt="previewFile.name"
            />
            <pre v-else-if="previewFile.previewKind === 'text'" class="chat-file-preview-code"><code>{{ previewFile.content }}</code></pre>
            <div v-else-if="previewFile.previewKind === 'tooLarge'" class="chat-split-panel-empty">
              <strong>文件过大</strong>
              <span>当前文件 {{ previewFileSizeLabel(previewFile.size) }}，暂不直接预览。</span>
            </div>
            <div v-else class="chat-split-panel-empty">
              <strong>无法预览二进制文件</strong>
              <span>可以在系统文件管理器中打开查看。</span>
            </div>
          </div>
        </div>
      </aside>
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
