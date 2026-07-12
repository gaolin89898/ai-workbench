<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import ChatMessageRow from "./ChatMessageRow.vue";
import ChatSegmentView from "./ChatSegment.vue";
import TerminalView from "./TerminalView.vue";
import { useWorkspace, type QueuedAiMessage } from "../composables/useWorkspace";
import { desktopApi, type AiChatOptions, type AiProvider, type AiRunSettingsState, type ChatContextAttachment, type ChatFileAttachment, type ChatImageAttachment, type ChatMessage, type ChatSegment, type ClaudeReasoningEffort, type AcpConfigOption, type CodexAdminEvent, type CodexApprovalMode, type CodexGoalStatus, type CodexModelOption, type CodexReasoningEffort, type CodexRunMode, type CodexThreadGoal, type ProjectEnvironmentInfo, type ProjectFilePreview, type ProjectOpenTarget } from "../services/desktop";
import { isProjectFileViewerSupported } from "../shared/project_file_formats";

const ProjectFileViewer = defineAsyncComponent(() => import("./ProjectFileViewer.vue"));

type RunPreferenceProviderId = "codex" | "claude" | "opencode" | "mimo";
type RunPreference = { model: string; reasoningEffort: string };
type RunPreferences = Partial<Record<RunPreferenceProviderId, RunPreference>>;
type ProcessPanelSelection = {
  sessionId: string;
  messageIndex: number;
  groupIndex: number;
  itemIndex: number;
  title: string;
};

const runPreferencesStorageKey = "ai-workbench.aiRunPreferences.v1";
const CHAT_CONTEXT_MIME = "application/x-codehub-chat-context";

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
const editIcon = new URL("../assets/icons/edit.svg", import.meta.url).href;
const trashIcon = new URL("../assets/icons/trash.svg", import.meta.url).href;
const imageRemoveIcon = new URL("../assets/icons/image-remove.svg", import.meta.url).href;
const folderOpenIcon = new URL("../assets/icons/folder-open.svg", import.meta.url).href;
const terminalIcon = new URL("../assets/icons/terminal.svg", import.meta.url).href;
const vscodeIcon = new URL("../assets/icons/vscode.svg", import.meta.url).href;
const traeCnIcon = new URL("../assets/icons/trae-cn.png", import.meta.url).href;
const gitIcon = new URL("../assets/icons/git.svg", import.meta.url).href;
const linuxIcon = new URL("../assets/icons/linux.svg", import.meta.url).href;
const ws = useWorkspace();

type ProjectOpenOption = {
  id: ProjectOpenTarget;
  label: string;
  iconSrc: string;
  iconClass?: string;
};

const projectOpenTargetStorageKey = "ai-workbench.projectOpenTarget.v1";
const projectOpenOptions: ProjectOpenOption[] = [
  { id: "vscode", label: "VS Code", iconSrc: vscodeIcon, iconClass: "brand-vscode" },
  { id: "traeCn", label: "Trae CN", iconSrc: traeCnIcon, iconClass: "brand-trae-cn" },
  { id: "fileManager", label: "File Explorer", iconSrc: folderOpenIcon },
  { id: "terminal", label: "Terminal", iconSrc: terminalIcon, iconClass: "terminal" },
  { id: "gitBash", label: "Git Bash", iconSrc: gitIcon, iconClass: "brand-git" },
  { id: "wsl", label: "WSL", iconSrc: linuxIcon, iconClass: "brand-wsl" },
];

function defaultTerminalPanelHeight() {
  return Math.min(360, Math.max(220, Math.round(window.innerHeight * 0.32)));
}

function readProjectOpenTarget(): ProjectOpenTarget {
  const stored = window.localStorage.getItem(projectOpenTargetStorageKey);
  if (stored === "visualStudio") return "traeCn";
  return projectOpenOptions.some((option) => option.id === stored)
    ? stored as ProjectOpenTarget
    : "vscode";
}

const prompt = ref("");
const editingQueuedMessageId = ref<string | null>(null);
const editingQueuedMessageText = ref("");
const imageAttachments = ref<ChatImageAttachment[]>([]);
const fileAttachments = ref<ChatFileAttachment[]>([]);
const contextAttachments = ref<ChatContextAttachment[]>([]);
const previewImage = ref<ChatImageAttachment | null>(null);
const promptInput = ref<HTMLTextAreaElement | null>(null);
const composerDropActive = ref(false);
const chatScroll = ref<HTMLDivElement | null>(null);
const startPromptBox = ref<HTMLFormElement | null>(null);
const chatComposer = ref<HTMLDivElement | null>(null);
const chatComposerHeight = ref(0);
const splitWorkspace = ref<HTMLElement | null>(null);
const previewFile = ref<ProjectFilePreview | null>(null);
const previewViewerFile = shallowRef<File | null>(null);
const previewLoading = ref(false);
const previewError = ref("");
const processPanelSelection = ref<ProcessPanelSelection | null>(null);
const terminalPanelOpen = ref(false);
const terminalPanelHeight = ref(defaultTerminalPanelHeight());
const startMenuOpen = ref(false);
const approvalMenuOpen = ref(false);
const composerToolsOpen = ref(false);
const environmentPanelOpen = ref(false);
const locationMenuOpen = ref(false);
const locationMenuError = ref("");
const selectedProjectOpenTarget = ref<ProjectOpenTarget>(readProjectOpenTarget());
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
const codexGoalStatus = ref<CodexGoalStatus>("active");
const codexThreadGoal = ref<CodexThreadGoal | null>(null);
const codexGoalBusy = ref(false);
const codexGoalLoading = ref(false);
const codexCompactBusy = ref(false);
const codexCompactNotice = ref("");
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
let removeCodexAdminEventListener: (() => void) | null = null;
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
  ".chat-location-split-button",
  ".chat-location-menu",
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
const TERMINAL_PANEL_MIN_HEIGHT = 0;
const TERMINAL_PANEL_COLLAPSE_THRESHOLD = 48;
const TERMINAL_MAIN_MIN_HEIGHT = 260;
let splitResizeCleanup: (() => void) | null = null;
let terminalResizeCleanup: (() => void) | null = null;
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
const selectedProjectOpenOption = computed(() => (
  projectOpenOptions.find((option) => option.id === selectedProjectOpenTarget.value)
  ?? projectOpenOptions[0]
));
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
const processPanelMessage = computed(() => {
  const selection = processPanelSelection.value;
  if (!selection || selection.sessionId !== ws.activeAiSession.value?.id) return null;
  return ws.chatMessages.value[selection.messageIndex] ?? null;
});

function turnStartedAt(messageIndex: number) {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = ws.chatMessages.value[index];
    if (message?.role === "user") return message.createdAt;
  }
  return undefined;
}
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
const canSend = computed(() => Boolean(!approvalInputLocked.value && (prompt.value.trim() || imageAttachments.value.length || fileAttachments.value.length || contextAttachments.value.length)));

const activeCodexThreadId = computed(() => {
  const session = ws.activeAiSession.value;
  if (!session || session.providerId !== "codex" || !session.providerSessionId) return "";
  return session.providerSessionId.startsWith("app-server:")
    ? session.providerSessionId.slice("app-server:".length)
    : session.providerSessionId;
});
const composerPlaceholder = computed(() => {
  if (approvalInputLocked.value) return "审批期间输入框已锁定";
  if (!ws.activeChatIsRunning.value) return "输入你的消息...";
  return "输入下一轮消息...";
});
const sendButtonTitle = computed(() => {
  return ws.activeChatIsRunning.value ? "停止当前轮" : "发送";
});
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
type OpenCodeModelOption = {
  id: string;
  model: string;
  displayName: string;
  free: boolean;
  providerId: string;
  providerName: string;
};
type OpenCodeModelGroup = {
  id: string;
  name: string;
  models: OpenCodeModelOption[];
};

function splitModelPath(value: string): [string, string] | null {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1) return null;
  return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
}

function openCodeModelOption(option: AcpConfigOption): OpenCodeModelOption {
  const valueParts = splitModelPath(option.value);
  const nameParts = splitModelPath(option.name);
  const displayName = nameParts?.[1] || valueParts?.[1] || option.name;
  return {
    id: option.value,
    model: option.value,
    providerId: valueParts?.[0] || nameParts?.[0] || "opencode",
    providerName: nameParts?.[0] || valueParts?.[0] || "OpenCode",
    displayName: displayName.replace(/\s+Free$/i, ""),
    free: /\s+Free$/i.test(displayName),
  };
}

const showOpenCodeModelGrouping = computed(() => showAcpRunControls.value && acpProviderId.value === "opencode");
const openCodeModelGroups = computed<OpenCodeModelGroup[]>(() => {
  const groups = new Map<string, OpenCodeModelGroup>();
  for (const option of acpModels.value) {
    const model = openCodeModelOption(option);
    const group = groups.get(model.providerId) ?? { id: model.providerId, name: model.providerName, models: [] };
    group.models.push(model);
    groups.set(model.providerId, group);
  }
  return [...groups.values()];
});
const selectedOpenCodeModel = computed(() => {
  const option = acpModels.value.find((model) => model.value === acpSelectedModel.value);
  return option ? openCodeModelOption(option) : null;
});
const selectedOpenCodeModelLabel = computed(() => selectedOpenCodeModel.value?.displayName ?? "默认");
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
  if (showOpenCodeModelGrouping.value) return selectedOpenCodeModelLabel.value;
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
  if (showOpenCodeModelGrouping.value) return selectedOpenCodeModelLabel.value;
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
let chatComposerResizeObserver: ResizeObserver | null = null;
let pendingPromptAnchorKey: string | null = null;
let anchorScrollVersion = 0;
let sessionBottomScrollVersion = 0;

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
  if (message.role === "user") return message.images?.length ? 170 : message.attachments?.length || message.contexts?.length ? 132 : 96;
  const textLength = message.text?.length ?? 0;
  const segmentCount = message.segments?.length ?? 0;
  const attachmentHeight = message.images?.length ? 118 : message.attachments?.length || message.contexts?.length ? 54 : 0;
  return Math.min(520, Math.max(112, 72 + Math.ceil(textLength / 48) * 24 + segmentCount * 38 + attachmentHeight));
}

function updateVirtualViewport() {
  if (splitPanelOpen.value) splitPanelWidth.value = clampSplitPanelWidth(splitPanelWidth.value);
  if (terminalPanelOpen.value) terminalPanelHeight.value = clampTerminalPanelHeight(terminalPanelHeight.value);
  const el = chatScroll.value;
  if (!el) return;
  virtualScrollTop.value = el.scrollTop;
  virtualViewportHeight.value = Math.max(0, el.clientHeight - chatComposerHeight.value - 32);
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

watch(
  chatComposer,
  (element) => {
    chatComposerResizeObserver?.disconnect();
    chatComposerResizeObserver = null;
    if (!element) {
      chatComposerHeight.value = 0;
      return;
    }
    const updateComposerHeight = () => {
      chatComposerHeight.value = Math.ceil(element.getBoundingClientRect().height);
      updateVirtualViewport();
    };
    chatComposerResizeObserver = new ResizeObserver(updateComposerHeight);
    chatComposerResizeObserver.observe(element);
    updateComposerHeight();
  },
  { flush: "post" },
);

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

function contextAttachmentKey(context: ChatContextAttachment) {
  if (context.kind === "file" || context.kind === "folder") return `${context.kind}:${context.path.toLocaleLowerCase()}`;
  if (context.kind === "code") return `${context.kind}:${context.path.toLocaleLowerCase()}:${context.startLine ?? 0}:${context.endLine ?? 0}:${context.content}`;
  return `${context.kind}:${context.terminalId ?? context.name}:${context.content}`;
}

function focusPromptInput() {
  void nextTick(() => promptInput.value?.focus());
}

function addContextAttachment(context: ChatContextAttachment) {
  const key = contextAttachmentKey(context);
  if (!contextAttachments.value.some((item) => contextAttachmentKey(item) === key)) {
    contextAttachments.value = [...contextAttachments.value, context].slice(-12);
  }
  focusPromptInput();
}

function removeContextAttachment(id: string) {
  contextAttachments.value = contextAttachments.value.filter((context) => context.id !== id);
}

function contextAttachmentDetail(context: ChatContextAttachment) {
  if (context.kind === "file") return "文件路径";
  if (context.kind === "folder") return "文件夹路径";
  if (context.kind === "terminal") return `${context.content.split(/\r?\n/).length} 行终端内容`;
  if (!context.startLine) return "代码选区";
  return context.endLine && context.endLine !== context.startLine
    ? `第 ${context.startLine}-${context.endLine} 行`
    : `第 ${context.startLine} 行`;
}

function pathContextFrom(value: unknown): ChatContextAttachment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if ((record.kind !== "file" && record.kind !== "folder") || typeof record.path !== "string" || !record.path.trim()) return null;
  const path = record.path.trim();
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : path.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? path;
  return record.kind === "file"
    ? { id: `path-context-${createAttachmentId()}`, kind: "file", name, path }
    : { id: `path-context-${createAttachmentId()}`, kind: "folder", name, path };
}

function onDesktopAddChatContext(event: Event) {
  const context = pathContextFrom((event as CustomEvent<unknown>).detail);
  if (context) addContextAttachment(context);
}

function hasContextDrag(event: DragEvent) {
  return [...(event.dataTransfer?.types ?? [])].includes(CHAT_CONTEXT_MIME);
}

function onContextDragOver(event: DragEvent) {
  if (!hasContextDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  composerDropActive.value = true;
}

function onContextDragLeave(event: DragEvent) {
  const current = event.currentTarget;
  if (current instanceof Node && event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return;
  composerDropActive.value = false;
}

function onContextDrop(event: DragEvent) {
  composerDropActive.value = false;
  const raw = event.dataTransfer?.getData(CHAT_CONTEXT_MIME);
  if (!raw) return;
  event.preventDefault();
  try {
    const context = pathContextFrom(JSON.parse(raw));
    if (context) addContextAttachment(context);
  } catch {
    // Ignore malformed drag data from sources outside the project tree.
  }
}

function addPreviewSelectionToContext() {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  const preview = document.querySelector(".chat-file-preview");
  const content = selection?.toString() ?? "";
  const file = previewFile.value;
  if (!selection || !anchor || !preview?.contains(anchor) || !content.trim() || file?.previewKind !== "text") return false;
  const source = file.content ?? "";
  const sourceIndex = source.indexOf(content);
  const startLine = sourceIndex >= 0 ? source.slice(0, sourceIndex).split(/\r?\n/).length : undefined;
  const endLine = startLine ? startLine + content.split(/\r?\n/).length - 1 : undefined;
  addContextAttachment({
    id: `code-context-${createAttachmentId()}`,
    kind: "code",
    name: file.name,
    path: file.path,
    content: content.slice(0, 50_000),
    startLine,
    endLine,
    language: file.language,
  });
  selection.removeAllRanges();
  return true;
}

function providerIcon(providerId: string) {
  return providerIcons[providerId] ?? providerCodexIcon;
}

function isFloatingMenuTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(floatingMenuTargetSelector));
}

function closeFloatingMenusOnOutsideClick(event: PointerEvent) {
  if (!startMenuOpen.value && !approvalMenuOpen.value && !composerToolsOpen.value && !modelMenuOpen.value && !modelSubmenuOpen.value && !environmentPanelOpen.value && !locationMenuOpen.value) return;
  if (isFloatingMenuTarget(event.target)) return;
  startMenuOpen.value = false;
  approvalMenuOpen.value = false;
  composerToolsOpen.value = false;
  modelMenuOpen.value = false;
  modelSubmenuOpen.value = false;
  environmentPanelOpen.value = false;
  locationMenuOpen.value = false;
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
    locationMenuOpen.value = false;
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
    locationMenuOpen.value = false;
  }
}

function toggleLocationMenu() {
  if (!currentProject.value) return;
  locationMenuOpen.value = !locationMenuOpen.value;
  locationMenuError.value = "";
  if (locationMenuOpen.value) {
    environmentPanelOpen.value = false;
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
  }
}

async function openCurrentProjectWith(target: ProjectOpenTarget) {
  const project = currentProject.value;
  if (!project) return;
  locationMenuError.value = "";
  try {
    await desktopApi.openProjectWith(project.path, target);
    locationMenuOpen.value = false;
  } catch (error) {
    locationMenuError.value = error instanceof Error ? error.message : "打开失败";
  }
}

function selectProjectOpenTarget(target: ProjectOpenTarget) {
  selectedProjectOpenTarget.value = target;
  window.localStorage.setItem(projectOpenTargetStorageKey, target);
  void openCurrentProjectWith(target);
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
    locationMenuOpen.value = false;
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
  locationMenuOpen.value = false;
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

function fileFromViewerSource(data: Uint8Array, name: string, mimeType: string) {
  const bytes = new Uint8Array(data);
  return new File([bytes.buffer], name, { type: mimeType });
}

async function loadFilePreview(projectPath: string, filePath: string) {
  const requestId = ++previewRequestId;
  processPanelSelection.value = null;
  openSplitPanel();
  previewLoading.value = true;
  previewError.value = "";
  previewFile.value = null;
  previewViewerFile.value = null;
  try {
    if (isProjectFileViewerSupported(filePath)) {
      const result = await desktopApi.readProjectFileForViewer(projectPath, filePath);
      if (requestId !== previewRequestId) return;
      previewFile.value = {
        name: result.name,
        path: result.path,
        size: result.size,
        modifiedAt: result.modifiedAt,
        previewKind: "binary",
        mimeType: result.mimeType,
      };
      previewViewerFile.value = fileFromViewerSource(result.data, result.name, result.mimeType);
    } else {
      const result = await desktopApi.readProjectFilePreview(projectPath, filePath);
      if (requestId !== previewRequestId) return;
      previewFile.value = result;
    }
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

function openProcessPanel(payload: Omit<ProcessPanelSelection, "sessionId">) {
  const sessionId = ws.activeAiSession.value?.id;
  if (!sessionId) return;
  previewRequestId += 1;
  previewLoading.value = false;
  previewError.value = "";
  previewFile.value = null;
  previewViewerFile.value = null;
  processPanelSelection.value = { ...payload, sessionId };
  openSplitPanel();
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

function clampTerminalPanelHeight(height: number) {
  const workspaceHeight = splitWorkspace.value?.getBoundingClientRect().height ?? 0;
  if (!workspaceHeight) return Math.max(TERMINAL_PANEL_MIN_HEIGHT, height);
  const maxHeight = Math.max(TERMINAL_PANEL_MIN_HEIGHT, workspaceHeight - TERMINAL_MAIN_MIN_HEIGHT);
  return Math.min(Math.max(height, TERMINAL_PANEL_MIN_HEIGHT), maxHeight);
}

function stopTerminalResize() {
  if (!terminalResizeCleanup) return;
  terminalResizeCleanup();
}

function startTerminalResize(event: PointerEvent) {
  if (!terminalPanelOpen.value) return;
  event.preventDefault();
  stopTerminalResize();
  const startY = event.clientY;
  const startHeight = terminalPanelHeight.value;
  document.body.classList.add("chat-terminal-resizing");

  const onPointerMove = (moveEvent: PointerEvent) => {
    terminalPanelHeight.value = clampTerminalPanelHeight(startHeight + startY - moveEvent.clientY);
  };
  const onPointerUp = () => {
    if (terminalPanelHeight.value <= TERMINAL_PANEL_COLLAPSE_THRESHOLD) {
      terminalPanelOpen.value = false;
      terminalPanelHeight.value = defaultTerminalPanelHeight();
    }
    stopTerminalResize();
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  terminalResizeCleanup = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    document.body.classList.remove("chat-terminal-resizing");
    terminalResizeCleanup = null;
  };
}

function toggleTerminalPanel() {
  terminalPanelOpen.value = !terminalPanelOpen.value;
  if (!terminalPanelOpen.value) stopTerminalResize();
  else void nextTick(() => {
    terminalPanelHeight.value = clampTerminalPanelHeight(terminalPanelHeight.value);
  });
}

function closeTerminalPanel() {
  terminalPanelOpen.value = false;
  stopTerminalResize();
}

function toggleComposerPlanMode() {
  codexMode.value = codexMode.value === "plan" ? "default" : "plan";
  composerToolsOpen.value = false;
}

async function toggleComposerGoalMode() {
  if (codexGoalEnabled.value) {
    await clearCodexGoal();
    return;
  }
  codexGoalEnabled.value = true;
  codexGoalStatus.value = "active";
  composerToolsOpen.value = false;
  if (activeCodexThreadId.value) await loadCodexGoal(true);
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
    locationMenuOpen.value = false;
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
    codexGoalStatus: goal ? codexGoalStatus.value : null,
  };
}

function onWindowKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "l" && addPreviewSelectionToContext()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key === "Escape" && previewImage.value) {
    event.preventDefault();
    previewImage.value = null;
    return;
  }
  if (event.key === "Escape" && (startMenuOpen.value || approvalMenuOpen.value || composerToolsOpen.value || modelMenuOpen.value || modelSubmenuOpen.value || environmentPanelOpen.value || locationMenuOpen.value)) {
    event.preventDefault();
    startMenuOpen.value = false;
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
    environmentPanelOpen.value = false;
    locationMenuOpen.value = false;
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

function fileAttachmentSizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function chooseFileAttachments() {
  composerToolsOpen.value = false;
  try {
    const selected = await desktopApi.chooseChatFileAttachments();
    const merged = [...fileAttachments.value];
    for (const attachment of selected) {
      if (!merged.some((item) => item.path.toLocaleLowerCase() === attachment.path.toLocaleLowerCase())) merged.push(attachment);
    }
    fileAttachments.value = merged.slice(0, 10);
  } catch (error) {
    ws.createAiResult.value = `选择附件失败：${String(error)}`;
    ws.createAiError.value = true;
  }
}

function removeFileAttachment(id: string) {
  fileAttachments.value = fileAttachments.value.filter((attachment) => attachment.id !== id);
}

function goalStatusLabel(status: CodexGoalStatus) {
  if (status === "paused") return "已暂停";
  if (status === "blocked") return "受阻";
  if (status === "usageLimited") return "用量受限";
  if (status === "budgetLimited") return "预算受限";
  if (status === "complete") return "已完成";
  return "进行中";
}

async function loadCodexGoal(preserveEnabled = false) {
  const threadId = activeCodexThreadId.value;
  if (!threadId) {
    codexThreadGoal.value = null;
    codexGoalStatus.value = "active";
    if (!preserveEnabled) codexGoalEnabled.value = false;
    return;
  }
  codexGoalLoading.value = true;
  try {
    const goal = await desktopApi.getCodexThreadGoal(threadId);
    if (threadId !== activeCodexThreadId.value) return;
    codexThreadGoal.value = goal;
    if (goal) {
      codexGoalEnabled.value = true;
      codexGoal.value = goal.objective;
      codexGoalStatus.value = goal.status;
    } else {
      codexGoalStatus.value = "active";
      if (!preserveEnabled) {
        codexGoalEnabled.value = false;
        codexGoal.value = "";
      }
    }
  } catch (error) {
    codexCompactNotice.value = `目标读取失败：${String(error)}`;
  } finally {
    if (threadId === activeCodexThreadId.value) codexGoalLoading.value = false;
  }
}

async function saveCodexGoal() {
  const threadId = activeCodexThreadId.value;
  const objective = codexGoal.value.trim();
  if (!threadId || !objective || codexGoalBusy.value) return;
  codexGoalBusy.value = true;
  try {
    const goal = await desktopApi.setCodexThreadGoal({
      threadId,
      objective,
      status: codexGoalStatus.value,
      tokenBudget: codexThreadGoal.value?.tokenBudget ?? null,
    });
    codexThreadGoal.value = goal;
    codexGoalStatus.value = goal.status;
  } catch (error) {
    codexCompactNotice.value = `目标更新失败：${String(error)}`;
  } finally {
    codexGoalBusy.value = false;
  }
}

async function toggleCodexGoalPaused() {
  const threadId = activeCodexThreadId.value;
  if (!threadId || !codexThreadGoal.value || codexGoalBusy.value) return;
  const status: CodexGoalStatus = codexGoalStatus.value === "paused" ? "active" : "paused";
  codexGoalBusy.value = true;
  try {
    const goal = await desktopApi.setCodexThreadGoal({ threadId, status });
    codexThreadGoal.value = goal;
    codexGoalStatus.value = goal.status;
  } catch (error) {
    codexCompactNotice.value = `目标状态更新失败：${String(error)}`;
  } finally {
    codexGoalBusy.value = false;
  }
}

async function clearCodexGoal() {
  const threadId = activeCodexThreadId.value;
  if (threadId && !codexGoalBusy.value) {
    codexGoalBusy.value = true;
    try {
      await desktopApi.clearCodexThreadGoal(threadId);
    } catch (error) {
      codexCompactNotice.value = `清除目标失败：${String(error)}`;
      codexGoalBusy.value = false;
      return;
    }
    codexGoalBusy.value = false;
  }
  codexGoalEnabled.value = false;
  codexGoal.value = "";
  codexGoalStatus.value = "active";
  codexThreadGoal.value = null;
  composerToolsOpen.value = false;
}

async function compactCurrentCodexThread() {
  const threadId = activeCodexThreadId.value;
  composerToolsOpen.value = false;
  if (!threadId || codexCompactBusy.value || ws.activeChatIsRunning.value) return;
  codexCompactBusy.value = true;
  codexCompactNotice.value = "正在压缩上下文...";
  try {
    await desktopApi.compactCodexThread(threadId);
    codexCompactNotice.value = "上下文压缩已启动";
    codexCompactBusy.value = false;
  } catch (error) {
    codexCompactNotice.value = `压缩失败：${String(error)}`;
    codexCompactBusy.value = false;
  }
}

function handleCodexAdminEvent(event: CodexAdminEvent) {
  if (!("threadId" in event) || event.threadId !== activeCodexThreadId.value) return;
  if (event.type === "thread-goal") {
    codexThreadGoal.value = event.goal;
    if (event.goal) {
      codexGoalEnabled.value = true;
      codexGoal.value = event.goal.objective;
      codexGoalStatus.value = event.goal.status;
    } else {
      codexGoalEnabled.value = false;
      codexGoal.value = "";
      codexGoalStatus.value = "active";
    }
  } else if (event.type === "thread-compacted") {
    codexCompactBusy.value = false;
    codexCompactNotice.value = "上下文已压缩";
  }
}

function queuedMessageLabel(item: QueuedAiMessage) {
  return item.text || (item.contexts?.length
    ? `查看 ${item.contexts.length} 个上下文`
    : item.attachments?.length
      ? `查看 ${item.attachments.length} 个附件`
      : `查看这 ${item.images.length} 张图片`);
}

function startQueuedMessageEdit(item: QueuedAiMessage) {
  editingQueuedMessageId.value = item.id;
  editingQueuedMessageText.value = item.text;
}

function cancelQueuedMessageEdit() {
  editingQueuedMessageId.value = null;
  editingQueuedMessageText.value = "";
}

function saveQueuedMessageEdit(item: QueuedAiMessage) {
  if (!ws.updateQueuedPrompt(item.id, editingQueuedMessageText.value)) return;
  cancelQueuedMessageEdit();
}

function removeQueuedMessage(itemId: string) {
  ws.removeQueuedPrompt(itemId);
  if (editingQueuedMessageId.value === itemId) cancelQueuedMessageEdit();
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

async function scrollSessionToBottomStable(version: number) {
  for (let pass = 0; pass < 3; pass += 1) {
    await nextTick();
    if (version !== sessionBottomScrollVersion || !chatScroll.value) return;
    scrollChatToBottom();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
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
  (sessionId, previousSessionId) => {
    resetVirtualMeasurements();
    anchorScrollVersion += 1;
    const version = ++sessionBottomScrollVersion;
    if (!sessionId || sessionId === previousSessionId) return;
    pendingPromptAnchorKey = null;
    void scrollSessionToBottomStable(version);
  },
);

watch(
  activeCodexThreadId,
  () => {
    codexCompactBusy.value = false;
    codexCompactNotice.value = "";
    void loadCodexGoal();
  },
  { immediate: true },
);

watch(
  () => ws.activeChatIsRunning.value,
  (running, previous) => {
    if (!running && previous && activeCodexThreadId.value) void loadCodexGoal(true);
  },
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

onMounted(() => {
  document.addEventListener("pointerdown", closeFloatingMenusOnOutsideClick);
  window.addEventListener("desktop-preview-file", onDesktopPreviewFile);
  window.addEventListener("desktop-add-chat-context", onDesktopAddChatContext);
  window.addEventListener("keydown", onWindowKeydown);
  window.addEventListener("resize", updateVirtualViewport);
  observeChatScroll();
  void nextTick(updateVirtualViewport);
  void desktopApi.onAiRunSettingsUpdate(applyRunSettingsUpdate).then((remove) => {
    removeAiRunSettingsUpdateListener = remove;
  });
  void desktopApi.onCodexAdminEvent(handleCodexAdminEvent).then((remove) => {
    removeCodexAdminEventListener = remove;
  });
});

onBeforeUnmount(() => {
  stopSplitResize();
  stopTerminalResize();
  document.removeEventListener("pointerdown", closeFloatingMenusOnOutsideClick);
  window.removeEventListener("desktop-preview-file", onDesktopPreviewFile);
  window.removeEventListener("desktop-add-chat-context", onDesktopAddChatContext);
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("resize", updateVirtualViewport);
  chatScrollResizeObserver?.disconnect();
  chatComposerResizeObserver?.disconnect();
  for (const observer of virtualRowObservers.values()) observer.disconnect();
  virtualRowObservers.clear();
  virtualRowElements.clear();
  removeAiRunSettingsUpdateListener?.();
  removeAiRunSettingsUpdateListener = null;
  removeCodexAdminEventListener?.();
  removeCodexAdminEventListener = null;
});

async function send() {
  if (approvalInputLocked.value) return;
  const value = prompt.value.trim();
  const images = imageAttachments.value.map((image) => ({
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    dataUrl: image.dataUrl,
  }));
  const attachments = fileAttachments.value.map((attachment) => ({ ...attachment }));
  const contexts = contextAttachments.value.map((context) => ({ ...context }));
  if (!value && !images.length && !attachments.length && !contexts.length) return;
  const runOptions = buildRunOptions();
  if (ws.activeChatIsRunning.value) {
    const accepted = Boolean(ws.queuePrompt(value, images, attachments, contexts, runOptions));
    if (accepted) {
      prompt.value = "";
      imageAttachments.value = [];
      fileAttachments.value = [];
      contextAttachments.value = [];
    }
    return;
  }
  if (!ws.activeAiSession.value) {
    const project = projectForNewSession();
    if (!project) {
      await ws.chooseProject();
      prompt.value = value;
      imageAttachments.value = images;
      fileAttachments.value = attachments;
      contextAttachments.value = contexts;
      return;
    }
    ws.selectedProviderId.value = selectedProvider.value?.id ?? "codex";
    const session = await ws.createAiSession();
    if (!session) {
      prompt.value = value;
      imageAttachments.value = images;
      fileAttachments.value = attachments;
      contextAttachments.value = contexts;
      return;
    }
  }
  prompt.value = "";
  imageAttachments.value = [];
  fileAttachments.value = [];
  contextAttachments.value = [];
  pendingPromptAnchorKey = latestUserAnchor()?.key ?? "__empty__";
  try {
    const sent = await ws.sendPrompt(value, images, attachments, contexts, runOptions);
    if (!sent) {
      prompt.value = value;
      imageAttachments.value = images;
      fileAttachments.value = attachments;
      contextAttachments.value = contexts;
    }
  } finally {
    if (pendingPromptAnchorKey === (latestUserAnchor()?.key ?? "__empty__")) {
      pendingPromptAnchorKey = null;
    }
  }
}

function handleComposerPrimaryAction() {
  if (ws.activeChatIsRunning.value) {
    void ws.stopActiveAiChat();
    return;
  }
  void send();
}

function toggleStartMenu() {
  startMenuOpen.value = !startMenuOpen.value;
  if (startMenuOpen.value) {
    approvalMenuOpen.value = false;
    composerToolsOpen.value = false;
    modelMenuOpen.value = false;
    modelSubmenuOpen.value = false;
    environmentPanelOpen.value = false;
    locationMenuOpen.value = false;
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
        <form
          ref="startPromptBox"
          class="codex-prompt-box"
          :class="{ 'context-drop-active': composerDropActive }"
          @submit.prevent="send"
          @dragover="onContextDragOver"
          @dragleave="onContextDragLeave"
          @drop="onContextDrop"
        >
          <div v-if="contextAttachments.length" class="chat-context-attachments start-attachments">
            <div v-for="context in contextAttachments" :key="context.id" class="chat-context-attachment-chip" :title="'path' in context ? context.path : context.name">
              <svg v-if="context.kind === 'folder'" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h4l1.25 1.5h5.75v7H2.5V4Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
              <svg v-else-if="context.kind === 'terminal'" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 5 2.5 2.5L3.5 10M7.5 10h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.75h5l3 3V14.25H4V1.75Z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.75v3h3" stroke="currentColor" stroke-width="1.2"/></svg>
              <span><strong>{{ context.name }}</strong><small>{{ contextAttachmentDetail(context) }}</small></span>
              <button type="button" title="移除上下文" aria-label="移除上下文" @click="removeContextAttachment(context.id)">×</button>
            </div>
          </div>
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
          <div v-if="fileAttachments.length" class="chat-file-attachments start-attachments">
            <div v-for="attachment in fileAttachments" :key="attachment.id" class="chat-file-attachment-chip" :title="attachment.path">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.75h5l3 3V14.25H4V1.75Z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.75v3h3" stroke="currentColor" stroke-width="1.2"/></svg>
              <span><strong>{{ attachment.name }}</strong><small>{{ fileAttachmentSizeLabel(attachment.size) }}</small></span>
              <button type="button" title="移除附件" aria-label="移除附件" @click="removeFileAttachment(attachment.id)">×</button>
            </div>
          </div>
          <textarea
            ref="promptInput"
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
              <button v-if="showCodexRunControls" type="button" @click="chooseFileAttachments">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.25 8.75 9.7 4.3a2.1 2.1 0 0 1 3 3l-5.4 5.4a3.25 3.25 0 0 1-4.6-4.6l5.05-5.05" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
                <span>添加文件</span>
                <small>PDF、文档、代码</small>
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
              <button v-if="activeCodexThreadId" type="button" :disabled="codexCompactBusy || ws.activeChatIsRunning.value" @click="compactCurrentCodexThread">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 5h10M5 8h6M7 11h2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
                <span>压缩上下文</span>
                <small>{{ codexCompactBusy ? "压缩中" : "释放上下文空间" }}</small>
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
                    <template v-if="showOpenCodeModelGrouping">
                      <template v-for="group in openCodeModelGroups" :key="group.id">
                        <div class="codex-model-menu-heading opencode-provider-heading">{{ group.name }}</div>
                        <button
                          v-for="model in group.models"
                          :key="model.id"
                          type="button"
                          :class="{ active: model.model === selectedModelValue }"
                          @click="selectModel(model.model)"
                        >
                          <span class="opencode-model-option-label">
                            <span>{{ model.displayName }}</span>
                            <small v-if="model.free">免费</small>
                          </span>
                          <span class="codex-model-menu-check" aria-hidden="true">{{ model.model === selectedModelValue ? "✓" : "" }}</span>
                        </button>
                      </template>
                    </template>
                    <template v-else>
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
                    </template>
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
          <button class="codex-send-button" :disabled="!prompt.trim() && !imageAttachments.length && !fileAttachments.length && !contextAttachments.length" title="发送" type="submit" aria-label="发送">
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
        <div class="chat-location-menu-wrap">
          <div class="chat-location-split-button" :class="{ open: locationMenuOpen }">
            <button
              type="button"
              class="chat-topbar-action location-primary"
              :disabled="!currentProject"
              :title="`使用 ${selectedProjectOpenOption.label} 打开项目`"
              :aria-label="`使用 ${selectedProjectOpenOption.label} 打开项目`"
              @click="openCurrentProjectWith(selectedProjectOpenTarget)"
            >
              <span
                class="chat-location-app-icon chat-location-trigger-icon"
                :class="selectedProjectOpenOption.iconClass"
                aria-hidden="true"
              >
                <img :src="selectedProjectOpenOption.iconSrc" alt="" />
              </span>
            </button>
            <button
              type="button"
              class="chat-location-menu-toggle"
              :disabled="!currentProject"
              title="选择打开方式"
              aria-label="选择打开方式"
              aria-haspopup="menu"
              :aria-expanded="locationMenuOpen"
              @click="toggleLocationMenu"
            >
              <svg class="chat-topbar-action-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m4.5 6.5 3.5 3 3.5-3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
          <div v-if="locationMenuOpen" class="chat-location-menu" role="menu">
            <button
              v-for="option in projectOpenOptions"
              :key="option.id"
              type="button"
              role="menuitemradio"
              :class="{ active: option.id === selectedProjectOpenTarget }"
              :aria-checked="option.id === selectedProjectOpenTarget"
              @click="selectProjectOpenTarget(option.id)"
            >
              <span class="chat-location-app-icon" :class="option.iconClass" aria-hidden="true">
                <img :src="option.iconSrc" alt="" />
              </span>
              <span>{{ option.label }}</span>
            </button>
            <p v-if="locationMenuError" class="chat-location-menu-error">{{ locationMenuError }}</p>
          </div>
        </div>
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
          :class="{ active: terminalPanelOpen }"
          :title="terminalPanelOpen ? '关闭终端' : '打开终端'"
          :aria-label="terminalPanelOpen ? '关闭终端' : '打开终端'"
          :aria-pressed="terminalPanelOpen"
          @click="toggleTerminalPanel"
        >
          <img :src="terminalIcon" alt="" aria-hidden="true" />
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
    <section
      ref="splitWorkspace"
      class="chat-workspace"
      :class="{
        'split-mode': splitPanelOpen,
      }"
      :style="{ '--chat-split-panel-width': `${splitPanelWidth}px` }"
    >
      <div class="chat-workspace-main">
        <article
          class="chat-main-panel"
          :class="{ 'terminal-open': terminalPanelOpen }"
          :style="{ '--chat-composer-height': `${chatComposerHeight}px` }"
        >
          <div class="chat-conversation-view">
            <div ref="chatScroll" class="terminal-preview" @scroll.passive="handleChatScroll">
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
                :message-index="item.index"
                :turn-started-at="turnStartedAt(item.index)"
                @open-process="openProcessPanel"
              />
            </div>
          </div>
            </div>
            <div
              v-if="userMessageAnchors.length >= USER_ANCHOR_MIN_VISIBLE"
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
          </div>
        <div v-if="showCreateHint" class="chat-toast" :class="{ error: ws.createAiError.value }">{{ ws.createAiResult.value }}</div>
        <div
          v-if="showModelRunControls && codexGoalEnabled"
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
            :disabled="codexGoalLoading || codexGoalBusy"
            @change="saveCodexGoal"
          />
          <span
            class="codex-goal-status"
            :class="codexGoalStatus"
            :title="codexThreadGoal ? `已用 ${codexThreadGoal.tokensUsed} tokens${codexThreadGoal.tokenBudget ? ` / ${codexThreadGoal.tokenBudget}` : ''}，${Math.round(codexThreadGoal.timeUsedSeconds)} 秒` : '发送后创建原生目标'"
          >{{ goalStatusLabel(codexGoalStatus) }}</span>
          <button v-if="activeCodexThreadId && codexGoal.trim()" type="button" class="codex-goal-bar-action" title="保存目标" :disabled="codexGoalBusy" @click="saveCodexGoal">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.2 2.8 2.7 6.2-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <button v-if="codexThreadGoal" type="button" class="codex-goal-bar-action" :title="codexGoalStatus === 'paused' ? '恢复目标' : '暂停目标'" :disabled="codexGoalBusy" @click="toggleCodexGoalPaused">
            <svg v-if="codexGoalStatus === 'paused'" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 5 4-5 4V4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>
            <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 4v8M10.5 4v8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          </button>
          <button type="button" class="codex-goal-bar-action danger" title="清除目标" :disabled="codexGoalBusy" @click="clearCodexGoal">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <div v-if="codexCompactNotice" class="chat-operation-notice">{{ codexCompactNotice }}</div>
        <div
          ref="chatComposer"
          class="chat-composer"
          :class="{ 'has-approval-cover': pendingApprovalSegment, 'context-drop-active': composerDropActive }"
          @dragover="onContextDragOver"
          @dragleave="onContextDragLeave"
          @drop="onContextDrop"
        >
          <div v-if="pendingApprovalSegment" class="chat-composer-approval-cover">
            <ChatSegmentView
              :segment="pendingApprovalSegment"
              :ai-session-id="ws.activeAiSession.value?.id"
            />
          </div>
          <section v-if="ws.activeQueuedAiMessages.value.length" class="chat-followup-queue" aria-label="下一轮消息队列">
            <header class="chat-followup-queue-header">
              <div>
                <strong>下一轮</strong>
                <span>{{ ws.activeQueuedAiMessages.value.length }}</span>
              </div>
              <button
                v-if="!ws.activeChatIsRunning.value"
                type="button"
                class="chat-followup-queue-send"
                title="发送下一条"
                aria-label="发送下一条"
                @click="ws.sendNextQueuedPrompt()"
              >
                <img :src="sendIcon" alt="" aria-hidden="true" />
              </button>
            </header>
            <div class="chat-followup-queue-list">
              <div
                v-for="(item, index) in ws.activeQueuedAiMessages.value"
                :key="item.id"
                class="chat-followup-queue-row"
                :class="{ editing: editingQueuedMessageId === item.id }"
              >
                <span class="chat-followup-queue-order">{{ index + 1 }}</span>
                <template v-if="editingQueuedMessageId === item.id">
                  <input
                    v-model="editingQueuedMessageText"
                    class="chat-followup-queue-input"
                    type="text"
                    aria-label="编辑队列消息"
                    @keydown.enter.prevent="saveQueuedMessageEdit(item)"
                    @keydown.escape.prevent="cancelQueuedMessageEdit"
                  />
                  <div class="chat-followup-queue-actions">
                    <button type="button" title="保存" aria-label="保存" @click="saveQueuedMessageEdit(item)">
                      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="m3.5 8.2 2.7 2.7 6.3-6.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <button type="button" title="取消" aria-label="取消" @click="cancelQueuedMessageEdit">
                      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                      </svg>
                    </button>
                  </div>
                </template>
                <template v-else>
                  <div class="chat-followup-queue-copy" :title="queuedMessageLabel(item)">
                    <span>{{ queuedMessageLabel(item) }}</span>
                    <small v-if="item.images.length">{{ item.images.length }} 张图片</small>
                    <small v-if="item.attachments?.length">{{ item.attachments.length }} 个文件</small>
                    <small v-if="item.contexts?.length">{{ item.contexts.length }} 个上下文</small>
                  </div>
                  <div v-if="item.images.length" class="chat-followup-queue-images" aria-hidden="true">
                    <img v-for="image in item.images.slice(0, 3)" :key="image.id" :src="image.dataUrl" alt="" />
                  </div>
                  <div class="chat-followup-queue-actions">
                    <button type="button" title="编辑" aria-label="编辑" @click="startQueuedMessageEdit(item)">
                      <img :src="editIcon" alt="" aria-hidden="true" />
                    </button>
                    <button type="button" title="上移" aria-label="上移" :disabled="index === 0" @click="ws.moveQueuedPrompt(item.id, -1)">
                      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="m4.5 9.5 3.5-3 3.5 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <button type="button" title="下移" aria-label="下移" :disabled="index === ws.activeQueuedAiMessages.value.length - 1" @click="ws.moveQueuedPrompt(item.id, 1)">
                      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="m4.5 6.5 3.5 3 3.5-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <button type="button" title="删除" aria-label="删除" @click="removeQueuedMessage(item.id)">
                      <img :src="trashIcon" alt="" aria-hidden="true" />
                    </button>
                  </div>
                </template>
              </div>
            </div>
          </section>
          <div v-if="contextAttachments.length" class="chat-context-attachments">
            <div v-for="context in contextAttachments" :key="context.id" class="chat-context-attachment-chip" :title="'path' in context ? context.path : context.name">
              <svg v-if="context.kind === 'folder'" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h4l1.25 1.5h5.75v7H2.5V4Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
              <svg v-else-if="context.kind === 'terminal'" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 5 2.5 2.5L3.5 10M7.5 10h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.75h5l3 3V14.25H4V1.75Z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.75v3h3" stroke="currentColor" stroke-width="1.2"/></svg>
              <span><strong>{{ context.name }}</strong><small>{{ contextAttachmentDetail(context) }}</small></span>
              <button type="button" title="移除上下文" aria-label="移除上下文" @click="removeContextAttachment(context.id)">×</button>
            </div>
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
          <div v-if="fileAttachments.length" class="chat-file-attachments">
            <div v-for="attachment in fileAttachments" :key="attachment.id" class="chat-file-attachment-chip" :title="attachment.path">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.75h5l3 3V14.25H4V1.75Z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.75v3h3" stroke="currentColor" stroke-width="1.2"/></svg>
              <span><strong>{{ attachment.name }}</strong><small>{{ fileAttachmentSizeLabel(attachment.size) }}</small></span>
              <button type="button" title="移除附件" aria-label="移除附件" @click="removeFileAttachment(attachment.id)">×</button>
            </div>
          </div>
          <textarea
            ref="promptInput"
            v-model="prompt"
            rows="3"
            :placeholder="composerPlaceholder"
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
                  <button v-if="showCodexRunControls" type="button" @click="chooseFileAttachments">
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.25 8.75 9.7 4.3a2.1 2.1 0 0 1 3 3l-5.4 5.4a3.25 3.25 0 0 1-4.6-4.6l5.05-5.05" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
                    <span>添加文件</span>
                    <small>PDF、文档、代码</small>
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
                  <button v-if="activeCodexThreadId" type="button" :disabled="codexCompactBusy || ws.activeChatIsRunning.value" @click="compactCurrentCodexThread">
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 5h10M5 8h6M7 11h2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
                    <span>压缩上下文</span>
                    <small>{{ codexCompactBusy ? "压缩中" : "释放上下文空间" }}</small>
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
                      <template v-if="showOpenCodeModelGrouping">
                        <template v-for="group in openCodeModelGroups" :key="group.id">
                          <div class="codex-model-menu-heading opencode-provider-heading">{{ group.name }}</div>
                          <button
                            v-for="model in group.models"
                            :key="model.id"
                            type="button"
                            :class="{ active: model.model === selectedModelValue }"
                            @click="selectModel(model.model)"
                          >
                            <span class="opencode-model-option-label">
                              <span>{{ model.displayName }}</span>
                              <small v-if="model.free">免费</small>
                            </span>
                            <span class="codex-model-menu-check" aria-hidden="true">{{ model.model === selectedModelValue ? "✓" : "" }}</span>
                          </button>
                        </template>
                      </template>
                      <template v-else>
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
                      </template>
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
                :disabled="!ws.activeChatIsRunning.value && !canSend"
                :title="sendButtonTitle"
                type="button"
                @click="handleComposerPrimaryAction"
                :aria-label="sendButtonTitle"
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
        type="button"
        class="chat-split-resizer"
        :class="{ open: splitPanelOpen }"
        title="拖动调整面板宽度"
        aria-label="拖动调整面板宽度"
        :aria-hidden="!splitPanelOpen"
        :tabindex="splitPanelOpen ? 0 : -1"
        @pointerdown="startSplitResize"
      ></button>
      <aside
        class="chat-split-panel"
        :class="{ open: splitPanelOpen }"
        :aria-hidden="!splitPanelOpen"
        :inert="!splitPanelOpen"
      >
        <header class="chat-split-panel-header">
          <div class="chat-split-panel-title">
            <strong>{{ processPanelSelection ? "执行详情" : previewFile?.name ?? "文件预览" }}</strong>
            <small v-if="processPanelSelection">{{ processPanelSelection.title }}</small>
            <small v-else-if="previewFile">{{ previewFileExtension }} · {{ previewFileSizeLabel(previewFile.size) }}</small>
          </div>
          <button type="button" title="关闭分割面板" aria-label="关闭分割面板" @click="toggleSplitPanel">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" />
            </svg>
          </button>
        </header>
        <div class="chat-split-panel-body" :class="{ 'viewer-active': previewViewerFile }">
          <div v-if="processPanelSelection" class="chat-process-side-panel">
            <ChatMessageRow
              v-if="processPanelMessage"
              :message="processPanelMessage"
              :ai-session-id="ws.activeAiSession.value?.id"
              :process-panel-group-index="processPanelSelection.groupIndex"
              :process-panel-item-index="processPanelSelection.itemIndex"
            />
            <div v-else class="chat-split-panel-empty">
              <strong>执行详情不可用</strong>
              <span>该消息可能已被移除或会话已经切换。</span>
            </div>
          </div>
          <div v-else-if="previewLoading" class="chat-split-panel-empty">
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
          <div v-else class="chat-file-preview" :class="{ 'viewer-active': previewViewerFile }">
            <div class="chat-file-preview-path" :title="previewFile.path">{{ previewFile.path }}</div>
            <ProjectFileViewer
              v-if="previewViewerFile"
              :key="`${previewFile.path}:${previewFile.modifiedAt}`"
              class="chat-file-preview-viewer"
              :file="previewViewerFile"
            />
            <ChatSegmentView
              v-else-if="previewFile.previewKind === 'text' && previewFile.language === 'markdown'"
              class="chat-file-preview-markdown"
              :segment="{ type: 'text', text: previewFile.content ?? '' }"
            />
            <pre v-else-if="previewFile.previewKind === 'text'" class="chat-file-preview-code"><code>{{ previewFile.content }}</code></pre>
            <img
              v-else-if="previewFile.previewKind === 'image' && previewFile.dataUrl"
              class="chat-file-preview-image"
              :src="previewFile.dataUrl"
              :alt="previewFile.name"
            />
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
      </div>
      <section
        class="chat-bottom-terminal"
        :class="{ open: terminalPanelOpen }"
        aria-label="项目终端"
        :aria-hidden="!terminalPanelOpen"
        :style="{ height: terminalPanelOpen ? `${terminalPanelHeight}px` : '0px' }"
      >
        <template v-if="terminalPanelOpen">
          <button
            type="button"
            class="chat-bottom-terminal-resizer"
            title="拖动调整终端高度"
            aria-label="拖动调整终端高度"
            @pointerdown="startTerminalResize"
          ></button>
          <div class="terminal-shell">
            <TerminalView @close="closeTerminalPanel" @add-context="addContextAttachment" />
          </div>
        </template>
      </section>
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
