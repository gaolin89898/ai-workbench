export type ViewName = "workspace" | "projects" | "aiSessions" | "providers" | "resources" | "settings" | "tokenUsage";

export type TerminalSession = {
  sessionId: string;
  name: string;
  backend: "tmux" | "screen";
  tool: string;
  status: string;
  cwd?: string | null;
  recentOutput?: string | null;
};

export type AiProvider = {
  id: string;
  name: string;
  command: string;
  builtIn: boolean;
  enabled: boolean;
};

export type ProviderStatus = {
  providerId: string;
  installed: boolean;
  version?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean | null;
  versionCheckError?: string | null;
  installCommand?: string | null;
  updateCommand?: string | null;
  installUrl?: string | null;
  authStatus: string;
  lastCheckedAt: string;
};

export type ProviderActionKind = "install" | "update";

export type ProviderActionResult = {
  providerId: string;
  action: ProviderActionKind;
  command: string;
  success: boolean;
  status: number | null;
  output: string;
};

export type NpmRegistryInfo = {
  registry: string;
  options?: NpmRegistryOption[];
  probeResults?: NpmRegistryProbeResult[];
  success: boolean;
  error?: string | null;
};

export type NpmRegistryOption = {
  label: string;
  registry: string;
};

export type NpmRegistryProbeResult = {
  registry: string;
  latencyMs?: number | null;
  ok: boolean;
  error?: string | null;
};

type SafeIpcError = {
  __AI_WORKBENCH_IPC_ERROR__: true;
  name: string;
  message: string;
  stack?: string;
};

export type WorkspaceProject = {
  id: string;
  name: string;
  path: string;
  gitBranch?: string | null;
  gitDirty: boolean;
};

export type ProjectOpenTarget = "vscode" | "traeCn" | "fileManager" | "terminal" | "gitBash" | "wsl";

export type ProjectEnvironmentInfo = {
  projectPath: string;
  branch: string | null;
  dirty: boolean;
  changedFiles: number;
  additions: number;
  deletions: number;
  githubCliAvailable: boolean;
};

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
};

export type ProjectFilePreview = {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  previewKind: "text" | "image" | "binary" | "tooLarge";
  content?: string;
  dataUrl?: string;
  mimeType?: string;
  language?: string;
  truncated?: boolean;
};

export type ProjectFileViewerSource = {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  mimeType: string;
  data: Uint8Array;
};

export type AiSession = {
  id: string;
  providerId: string;
  terminalSessionId?: string | null;
  providerSessionId?: string | null;
  title: string;
  status: string;
  summary?: string | null;
  projectPath?: string | null;
  archivedAt?: string | null;
  orchestrationMode?: string | null;
  pipelineConfig?: string | null;
  updatedAt?: string;
};

// ---------- Multi-agent pipeline types ----------

export type AgentRole = {
  id: string;
  name: string;
  description: string;
  providerId: string;
  systemPrompt: string;
  chatOptions: AiChatOptions;
};

export type PipelineTemplate = {
  id: string;
  name: string;
  description: string;
  roles: AgentRole[];
};

export type PipelineStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type PipelineStepUpdateEvent = {
  aiSessionId: string;
  stepIndex: number;
  totalSteps: number;
  roleId: string;
  roleName: string;
  providerId: string;
  status: PipelineStepStatus;
  output?: string;
  error?: string;
};

export type ProviderSessionCatalogEntry = {
  key: string;
  providerId: string;
  providerSessionId: string | null;
  title: string;
  cwd: string | null;
  updatedAt: string | null;
  archived: boolean;
  source: "workbench" | "provider-api" | "provider-files";
  sourceApp?: "codehub" | "vscode" | "cli" | "desktop" | "unknown";
  linkedAiSessionId: string | null;
  capabilities: {
    read: boolean;
    resume: boolean;
    rename: boolean;
    archive: boolean;
    delete: boolean;
  };
};

export type PairResponse = {
  deviceId?: string;
  device_id?: string;
  accessToken?: string;
  access_token?: string;
};

export type SavedCloudConfig = {
  serverUrl: string;
  deviceId: string;
  paired: boolean;
  authMode?: "desktop-login" | "pairing";
  displayName?: string;
};

export type TokenUsageSummaryItem = {
  providerId: string;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turnCount: number;
};

export type TokenUsageSummary = {
  providers: TokenUsageSummaryItem[];
  totals: TokenUsageSummaryItem;
  daily?: TokenUsageDailyItem[];
  periodDays?: number;
};

export type TokenUsageDailyItem = {
  date: string;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turnCount: number;
};

export type AiActivityDay = {
  date: string;
  count: number;
  providerId?: string;
};

export type AiActivityProject = {
  id: string;
  name: string;
  path: string;
  count: number;
  providerId?: string;
  lastActiveAt?: string;
};

export type AiActivitySummary = {
  days: AiActivityDay[];
  projects: AiActivityProject[];
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  totalInteractions: number;
  rangeStart: string;
  rangeEnd: string;
};

export type ChatSegment =
  | {
      type: "text";
      stepId?: string;
      text: string;
    }
  | {
      type: "status";
      stepId?: string;
      label: string;
      detail?: string;
      icon?: "check" | "read" | "edit" | "search" | "think" | "warn" | "compact";
      status?: "running" | "completed" | "failed" | "canceled";
      startedAt?: string | null;
      completedAt?: string | null;
      durationMs?: number;
      additions?: number;
      deletions?: number;
      rawItemType?: string | null;
    }
  | {
      type: "thought";
      stepId?: string;
      title?: string;
      text: string;
      collapsed?: boolean;
      durationMs?: number;
    }
  | {
      type: "goal";
      stepId?: string;
      objective: string;
    }
  | {
      type: "plan";
      stepId?: string;
      title: string;
      summary?: string;
      content?: string;
      steps: Array<{
        step: string;
        status: "pending" | "in_progress" | "completed";
      }>;
    }
  | {
      type: "tool";
      stepId?: string;
      toolName: string;
      command?: string;
      status: "running" | "success" | "error";
      summary?: string;
      input?: string;
      output?: string;
      diff?: string;
      durationMs?: number;
      additions?: number;
      deletions?: number;
    }
  | {
      type: "approval";
      stepId: string;
      approvalId: string;
      approvalKind: "command" | "fileChange" | "permissions";
      providerId?: string;
      status: "pending" | "approved" | "denied" | "expired" | "failed";
      title: string;
      reason?: string;
      command?: string;
      cwd?: string;
      grantRoot?: string;
      fileChanges?: string[];
      requestedPermissions?: CodexRequestedPermissions;
      permissionScope?: CodexPermissionGrantScope;
      detail?: string;
    }
  | {
      type: "error";
      stepId?: string;
      title?: string;
      message: string;
      detail?: string;
    };

export type ChatMessage = {
  clientId?: string;
  role: "user" | "assistant" | "system" | "error";
  text?: string;
  createdAt?: string;
  pending?: boolean;
  segments?: ChatSegment[];
  images?: ChatImageAttachment[];
  attachments?: ChatFileAttachment[];
  contexts?: ChatContextAttachment[];
  agentRole?: string | null;
};

export type CodexTraceItem = {
  id: string;
  type: "thinking" | "agent_message" | "command" | "tool" | "approval" | "status" | "error";
  title: string;
  status: "running" | "completed" | "failed" | "canceled";
  text: string;
  startedAt?: string | null;
  completedAt?: string | null;
  rawItemType?: string | null;
  phase?: string | null;
  toolName?: string | null;
  command?: string | null;
  input?: string | null;
  output?: string | null;
  error?: string | null;
  diff?: string | null;
  durationMs?: number | null;
  additions?: number | null;
  deletions?: number | null;
};

export type CodexTraceApproval = {
  id: string;
  kind: "command" | "fileChange" | "permissions";
  status: "pending" | "approved" | "denied" | "expired" | "failed";
  title: string;
  command?: string | null;
  cwd?: string | null;
  fileChanges?: string[];
  requestedPermissions?: CodexRequestedPermissions;
  permissionScope?: CodexPermissionGrantScope;
  detail?: string | null;
};

export type CodexTraceError = {
  message: string;
  detail?: string | null;
  at: string;
};

export type CodexTracePlan = {
  turnId?: string | null;
  explanation?: string | null;
  content?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  updatedAt: string;
};

export type CodexTraceGoal = {
  objective: string;
  status?: string | null;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  updatedAt: string;
};

export type CodexTraceSnapshot = {
  provider: string;
  status: "idle" | "running" | "completed" | "failed" | "canceled";
  threadId?: string | null;
  turnId?: string | null;
  startedAt?: string | null;
  updatedAt: string;
  completedAt?: string | null;
  items: CodexTraceItem[];
  approvals: CodexTraceApproval[];
  errors: CodexTraceError[];
  goal?: CodexTraceGoal | null;
  plan?: CodexTracePlan | null;
  finalText: string;
};

export type AiProviderTrace = {
  aiSessionId: string;
  providerId: string;
  traceKind: "codex" | string;
  status: string;
  rawEvents?: unknown[];
  snapshot: CodexTraceSnapshot | Record<string, unknown>;
  segments?: ChatSegment[];
  finalText?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type AiTraceUpdateEvent = {
  aiSessionId: string;
  trace: AiProviderTrace;
};

export type AiHistoryMessage = {
  role: "user" | "assistant" | "system" | "error";
  content: string;
  createdAt: string;
  agentRole?: string | null;
};

export type CreateAiSessionRequest = {
  providerId: string;
  projectPath?: string | null;
  title: string;
  creationMode: string;
  terminalSessionId: string | null;
};

export type ShellInputRequest = {
  aiSessionId: string;
  text: string;
  submit: boolean;
};

export type CodexApprovalDecision = "approved" | "denied";
export type CodexApprovalMode = "suggest" | "autoEdit" | "fullAccess" | "custom";
export type CodexPermissionGrantScope = "turn" | "session";
export type CodexFileSystemPermissionEntry = {
  path: string;
  access: "read" | "write" | "deny";
};
export type CodexRequestedPermissions = {
  network?: { enabled: boolean | null };
  fileSystem?: {
    read?: string[] | null;
    write?: string[] | null;
    entries?: CodexFileSystemPermissionEntry[];
  };
};
export type CodexPermissionProfile = {
  id: string;
  description: string;
  allowed: boolean;
};
export type CodexRunMode = "default" | "plan";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type CodexApprovalResponseRequest = {
  aiSessionId: string;
  approvalId: string;
  decision: CodexApprovalDecision;
  scope?: CodexPermissionGrantScope;
};

export type CodexUserInputOption = {
  label: string;
  description: string;
};

export type CodexUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: CodexUserInputOption[];
  isOther?: boolean;
  isSecret?: boolean;
};

export type CodexUserInputRequestEvent = {
  aiSessionId: string;
  requestId: string;
  questions: CodexUserInputQuestion[];
};

export type CodexUserInputResponseRequest = {
  aiSessionId: string;
  requestId: string;
  answers: Record<string, string[]>;
};

export type CodexUserInputResolvedEvent = {
  aiSessionId: string;
  requestId: string;
};

export type CodexReasoningEffortOption = {
  reasoningEffort: CodexReasoningEffort;
  description: string;
};

export type CodexServiceTierOption = {
  id: string;
  name: string;
  description: string;
};

export type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  resolvedModel?: string | null;
  description?: string | null;
  isDefault?: boolean;
  supportsEffort?: boolean;
  defaultReasoningEffort?: CodexReasoningEffort | null;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
  defaultServiceTier?: string | null;
  serviceTiers?: CodexServiceTierOption[];
};

export type ClaudeReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AiRunProviderSettings = {
  providerId: "codex" | "claude" | "opencode" | "mimo";
  model: string;
  reasoningEffort: string;
  models: CodexModelOption[];
  reasoningOptions: string[];
  serviceTier?: string | null;
};

export type AiRunSettingsState = {
  codex: AiRunProviderSettings & { providerId: "codex" };
  claude: AiRunProviderSettings & { providerId: "claude" };
  opencode: AiRunProviderSettings & { providerId: "opencode" };
  mimo: AiRunProviderSettings & { providerId: "mimo" };
};

export type AiRunSettingsUpdateEvent = {
  providerId: "codex" | "claude" | "opencode" | "mimo";
  model: string;
  reasoningEffort: string;
  serviceTier?: string | null;
};

export type CodexChatOptions = {
  approvalMode?: CodexApprovalMode;
  codexMode?: CodexRunMode;
  codexModel?: string | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  codexServiceTier?: string | null;
  codexGoal?: string | null;
  codexGoalTokenBudget?: number | null;
  codexGoalStatus?: CodexGoalStatus | null;
};

export type AiChatOptions = CodexChatOptions & {
  claudeModel?: string | null;
  claudeReasoningEffort?: ClaudeReasoningEffort | null;
  claudeMode?: CodexRunMode;
  claudeGoal?: string | null;
  opencodeModel?: string | null;
  opencodeEffort?: string | null;
  opencodeMode?: string | null;
  mimoModel?: string | null;
  mimoVariant?: string | null;
  mimoAgent?: string | null;
};

export type RunCodexChatRequest = {
  aiSessionId: string;
  projectPath?: string | null;
  prompt: string;
  images?: ChatImageAttachment[];
  attachments?: ChatFileAttachment[];
  contexts?: ChatContextAttachment[];
} & CodexChatOptions;

export type SteerCodexChatRequest = {
  aiSessionId: string;
  prompt: string;
  images?: ChatImageAttachment[];
  attachments?: ChatFileAttachment[];
  contexts?: ChatContextAttachment[];
  clientUserMessageId?: string | null;
};

export type CodexGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type CodexThreadGoal = {
  threadId: string;
  objective: string;
  status: CodexGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type CodexThreadArchiveRequest = {
  threadId: string;
  archived: boolean;
};

export type CodexThreadGoalSetRequest = {
  threadId: string;
  objective?: string | null;
  status?: CodexGoalStatus | null;
  tokenBudget?: number | null;
};

export type CodexNativeThreadStatus = {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags: string[];
};

export type CodexNativeThreadItem = {
  id: string;
  type: string;
  title: string;
  status?: string | null;
  text?: string | null;
  detail?: string | null;
  durationMs?: number | null;
};

export type CodexNativeTurn = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress" | string;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  error?: string | null;
  items: CodexNativeThreadItem[];
};

export type CodexNativeThread = {
  id: string;
  sessionId: string;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  name?: string | null;
  preview: string;
  cwd: string;
  modelProvider: string;
  cliVersion: string;
  source: string;
  originator?: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  archived: boolean;
  status: CodexNativeThreadStatus;
  turns: CodexNativeTurn[];
};

export type CodexThreadListRequest = {
  cursor?: string | null;
  limit?: number;
  searchTerm?: string | null;
  archived?: boolean;
  cwd?: string | null;
};

export type CodexThreadListResponse = {
  data: CodexNativeThread[];
  nextCursor: string | null;
};

export type CodexThreadReadRequest = {
  threadId: string;
  archived?: boolean;
};

export type CodexThreadRenameRequest = {
  threadId: string;
  name: string;
};

export type CodexMcpTool = {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
};

export type CodexMcpResource = {
  uri: string;
  name: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
};

export type CodexMcpResourceTemplate = {
  uriTemplate: string;
  name: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
};

export type CodexMcpServer = {
  name: string;
  displayName: string;
  version?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" | string;
  startupStatus: "unknown" | "starting" | "ready" | "failed" | "cancelled";
  error?: string | null;
  failureReason?: string | null;
  tools: CodexMcpTool[];
  resources: CodexMcpResource[];
  resourceTemplates: CodexMcpResourceTemplate[];
};

export type CodexMcpResourceReadRequest = {
  server: string;
  uri: string;
  threadId?: string | null;
};

export type CodexMcpResourceContent = {
  uri: string;
  mimeType?: string | null;
  text?: string | null;
  blob?: string | null;
};

export type CodexMcpOauthRequest = {
  name: string;
  threadId?: string | null;
  scopes?: string[] | null;
};

export type CodexMcpOauthResponse = {
  authorizationUrl: string;
};

export type CodexConfigOrigin = {
  type: string;
  label: string;
  version: string;
  path?: string | null;
};

export type CodexConfigLayer = CodexConfigOrigin & {
  disabledReason?: string | null;
  config: unknown;
};

export type CodexConfigSnapshot = {
  config: Record<string, unknown>;
  origins: Record<string, CodexConfigOrigin>;
  layers: CodexConfigLayer[];
  userConfigPath?: string | null;
  userConfigVersion?: string | null;
};

export type CodexConfigEdit = {
  keyPath: string;
  value: unknown;
  mergeStrategy?: "replace" | "upsert";
};

export type CodexConfigWriteRequest = CodexConfigEdit & {
  filePath?: string | null;
  expectedVersion?: string | null;
};

export type CodexConfigBatchWriteRequest = {
  edits: CodexConfigEdit[];
  filePath?: string | null;
  expectedVersion?: string | null;
};

export type CodexConfigWriteResult = {
  status: "ok" | "okOverridden" | string;
  version: string;
  filePath: string;
  overriddenMessage?: string | null;
  effectiveValue?: unknown;
};

export type CodexFeature = {
  name: string;
  stage: "beta" | "underDevelopment" | "stable" | "deprecated" | "removed" | string;
  displayName?: string | null;
  description?: string | null;
  announcement?: string | null;
  enabled: boolean;
  defaultEnabled: boolean;
};

export type CodexFeatureSetRequest = {
  name: string;
  enabled: boolean;
  persist?: boolean;
};

export type CodexSkillScope = "user" | "repo" | "system" | "admin" | string;

export type CodexSkillDependency = {
  type: string;
  value: string;
  command?: string | null;
  description?: string | null;
  transport?: string | null;
  url?: string | null;
};

export type CodexSkill = {
  name: string;
  description: string;
  path: string;
  scope: CodexSkillScope;
  enabled: boolean;
  shortDescription?: string | null;
  interface?: {
    brandColor?: string | null;
    defaultPrompt?: string | null;
    displayName?: string | null;
    iconLarge?: string | null;
    iconSmall?: string | null;
    shortDescription?: string | null;
  } | null;
  dependencies?: CodexSkillDependency[] | null;
};

export type CodexSkillError = {
  path: string;
  message: string;
};

export type CodexSkillsListEntry = {
  cwd: string;
  skills: CodexSkill[];
  errors: CodexSkillError[];
};

export type CodexSkillsListRequest = {
  cwds?: string[];
  forceReload?: boolean;
};

export type CodexSkillsSnapshot = {
  entries: CodexSkillsListEntry[];
  extraRoots: string[];
};

export type CodexSkillEnabledRequest = {
  path: string;
  name?: string | null;
  enabled: boolean;
};

export type CodexAdminEvent =
  | { type: "thread-status"; threadId: string; status: CodexNativeThreadStatus }
  | { type: "thread-name"; threadId: string; name: string | null }
  | { type: "thread-archived"; threadId: string; archived: boolean }
  | { type: "thread-deleted"; threadId: string }
  | { type: "thread-goal"; threadId: string; goal: CodexThreadGoal | null }
  | { type: "thread-compacted"; threadId: string }
  | { type: "mcp-status"; name: string; startupStatus: CodexMcpServer["startupStatus"]; error?: string | null; failureReason?: string | null }
  | { type: "mcp-oauth"; name: string; success: boolean; error?: string | null }
  | { type: "skills-changed" };

export type RunAiChatRequest = {
  aiSessionId: string;
  projectPath?: string | null;
  prompt: string;
  images?: ChatImageAttachment[];
  attachments?: ChatFileAttachment[];
  contexts?: ChatContextAttachment[];
} & AiChatOptions;

export type RunPipelineChatRequest = {
  aiSessionId: string;
  projectPath?: string | null;
  prompt: string;
  images?: ChatImageAttachment[];
  attachments?: ChatFileAttachment[];
  contexts?: ChatContextAttachment[];
  pipeline: PipelineTemplate;
};

export type AcpConfigOption = {
  value: string;
  name: string;
  isDefault?: boolean;
};

export type AcpConfigOptions = {
  models: AcpConfigOption[];
  efforts: AcpConfigOption[];
  modes: AcpConfigOption[];
};

export type ChatImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type ChatFileAttachment = {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
};

export type ChatContextAttachment =
  | {
      id: string;
      kind: "file";
      name: string;
      path: string;
    }
  | {
      id: string;
      kind: "folder";
      name: string;
      path: string;
    }
  | {
      id: string;
      kind: "code";
      name: string;
      path: string;
      content: string;
      startLine?: number;
      endLine?: number;
      language?: string;
    }
  | {
      id: string;
      kind: "terminal";
      name: string;
      content: string;
      terminalId?: string;
    };

export type ClipboardImage = Omit<ChatImageAttachment, "id">;

export type ResizeShellRequest = {
  aiSessionId: string;
  cols: number;
  rows: number;
};

export type StartShellPtyRequest = {
  aiSessionId: string;
  cwd: string;
};

export type ShellTerminalEvent = {
  aiSessionId: string;
  chunk: string;
};

export type ShellSessionStatusEvent = {
  aiSessionId: string;
  status: "running" | "exited" | "failed";
  message?: string | null;
};

export type AiChatOutputEvent = {
  aiSessionId: string;
  kind: "status" | "step-start" | "step-update" | "delta" | "done" | "error";
  text?: string;
  phase?: "process" | "final";
  stepId?: string | null;
  segment?: ChatSegment | null;
  segments?: ChatSegment[];
};

export type AiHistoryChangedEvent = {
  aiSessionId: string;
};

export type AppUpdateInfo = {
  available: boolean;
  version?: string;
  currentVersion?: string;
  date?: string | null;
  body?: string | null;
  installable?: boolean;
  required?: boolean;
  force?: boolean;
  downloadUrl?: string | null;
  windowsDownloadUrl?: string | null;
  linuxDownloadUrl?: string | null;
  downloadSize?: number | null;
  releaseUrl?: string | null;
  source?: string;
};

export type AppUpdateDownloadProgress = {
  total?: number;
  delta?: number;
  transferred?: number;
  percent?: number;
  bytesPerSecond?: number;
};

export type AppUpdateDownloadedInfo = {
  version?: string;
};

export type AppUpdateError = {
  message?: string;
};

export type DesktopRuntimeInfo = {
  platform: NodeJS.Platform;
  arch: string;
};

function requireDesktopApi() {
  if (!window.desktop?.invoke) {
    throw new Error("当前不是 Electron 桌面端窗口，无法打开本地文件夹选择器。请使用 pnpm dev 启动桌面端，不要只在浏览器里打开 Vite 页面。");
  }
  return window.desktop;
}

function isSafeIpcError(value: unknown): value is SafeIpcError {
  return Boolean(value)
    && typeof value === "object"
    && (value as SafeIpcError).__AI_WORKBENCH_IPC_ERROR__ === true;
}

async function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await requireDesktopApi().invoke(channel, ...args);
  if (isSafeIpcError(result)) {
    const error = new Error(result.message);
    error.name = result.name || "Error";
    if (result.stack) error.stack = result.stack;
    throw error;
  }
  return result as T;
}

function on(channel: string, handler: (...args: unknown[]) => void): () => void {
  return requireDesktopApi().on(channel, handler as (...args: unknown[]) => void);
}

export const desktopApi = {
  listSessions: (): Promise<TerminalSession[]> =>
    ipc<TerminalSession[]>("list_sessions"),
  loginDesktop: (server: string, email: string, password: string): Promise<PairResponse> =>
    ipc<PairResponse>("login_desktop", server, email, password),
  githubLoginStart: (server: string, desktop = true): Promise<{ authorizeUrl: string; state: string }> =>
    ipc<{ authorizeUrl: string; state: string }>("github_login_start", server, desktop),
  githubLoginPoll: (server: string, state: string): Promise<{ status: string; accessToken?: string; deviceId?: string; error?: string }> =>
    ipc<{ status: string; accessToken?: string; deviceId?: string; error?: string }>("github_login_poll", server, state),
  googleLoginStart: (server: string, desktop = true): Promise<{ authorizeUrl: string; state: string }> =>
    ipc<{ authorizeUrl: string; state: string }>("google_login_start", server, desktop),
  googleLoginPoll: (server: string, state: string): Promise<{ status: string; accessToken?: string; deviceId?: string; error?: string }> =>
    ipc<{ status: string; accessToken?: string; deviceId?: string; error?: string }>("google_login_poll", server, state),
  logoutDesktop: (): Promise<void> =>
    ipc<void>("logout_desktop"),
  saveCredentials: (email: string, password: string): Promise<void> =>
    ipc<void>("save_credentials", email, password),
  loadCredentials: (): Promise<{ email: string; password: string } | null> =>
    ipc<{ email: string; password: string } | null>("load_credentials"),
  clearCredentials: (): Promise<void> =>
    ipc<void>("clear_credentials"),
  openExternalUrl: (url: string): Promise<void> =>
    ipc<void>("open_external_url", url),
  getCloudConfig: (): Promise<SavedCloudConfig | null> =>
    ipc<SavedCloudConfig | null>("get_cloud_config"),
  getTokenUsageSummary: (days = 30): Promise<TokenUsageSummary | null> =>
    ipc<TokenUsageSummary | null>("get_token_usage_summary", days),
  getAiActivitySummary: (): Promise<AiActivitySummary> =>
    ipc<AiActivitySummary>("get_ai_activity_summary"),
  exportTextFile: (defaultName: string, content: string): Promise<boolean> =>
    ipc<boolean>("export_text_file", defaultName, content),
  readClipboardImage: (): Promise<ClipboardImage | null> =>
    ipc<ClipboardImage | null>("read_clipboard_image"),
  listAiProviders: (): Promise<AiProvider[]> =>
    ipc<AiProvider[]>("list_ai_providers"),
  detectAiProviders: (): Promise<ProviderStatus[]> =>
    ipc<ProviderStatus[]>("detect_ai_providers"),
  runProviderAction: (providerId: string, action: ProviderActionKind): Promise<ProviderActionResult> =>
    ipc<ProviderActionResult>("run_provider_action", providerId, action),
  getNpmRegistry: (): Promise<NpmRegistryInfo> =>
    ipc<NpmRegistryInfo>("get_npm_registry"),
  setNpmRegistry: (registry: string): Promise<NpmRegistryInfo> =>
    ipc<NpmRegistryInfo>("set_npm_registry", registry),
  probeNpmRegistries: (): Promise<NpmRegistryInfo> =>
    ipc<NpmRegistryInfo>("probe_npm_registries"),
  addWorkspaceProject: (path: string): Promise<WorkspaceProject> =>
    ipc<WorkspaceProject>("add_workspace_project", path),
  chooseWorkspaceProject: (): Promise<WorkspaceProject | null> =>
    ipc<WorkspaceProject | null>("choose_workspace_project"),
  listWorkspaceProjects: (): Promise<WorkspaceProject[]> =>
    ipc<WorkspaceProject[]>("list_workspace_projects"),
  renameWorkspaceProject: (id: string, name: string): Promise<WorkspaceProject> =>
    ipc<WorkspaceProject>("rename_workspace_project", id, name),
  removeWorkspaceProject: (id: string): Promise<void> =>
    ipc<void>("remove_workspace_project", id),
  openProjectInFileManager: (path: string): Promise<void> =>
    ipc<void>("open_project_in_file_manager", path),
  openProjectWith: (path: string, target: ProjectOpenTarget): Promise<void> =>
    ipc<void>("open_project_with", path, target),
  getProjectEnvironment: (path: string): Promise<ProjectEnvironmentInfo> =>
    ipc<ProjectEnvironmentInfo>("get_project_environment", path),
  listProjectFiles: (path: string, directoryPath?: string | null): Promise<WorkspaceFileEntry[]> =>
    ipc<WorkspaceFileEntry[]>("list_project_files", path, directoryPath ?? null),
  chooseChatFileAttachments: (): Promise<ChatFileAttachment[]> =>
    ipc<ChatFileAttachment[]>("choose_chat_file_attachments"),
  readProjectFilePreview: (projectPath: string, filePath: string): Promise<ProjectFilePreview> =>
    ipc<ProjectFilePreview>("read_project_file_preview", projectPath, filePath),
  readProjectFileForViewer: (projectPath: string, filePath: string): Promise<ProjectFileViewerSource> =>
    ipc<ProjectFileViewerSource>("read_project_file_for_viewer", projectPath, filePath),
  openProjectHtmlInBrowser: (projectPath: string, filePath: string): Promise<void> =>
    ipc<void>("open_project_html_in_browser", projectPath, filePath),
  createAiSession: (req: CreateAiSessionRequest): Promise<AiSession> =>
    ipc<AiSession>("create_ai_session", req),
  restartAiSession: (aiSessionId: string): Promise<AiSession> =>
    ipc<AiSession>("restart_ai_session", aiSessionId),
  appendLocalAiMessage: (aiSessionId: string, role: ChatMessage["role"], content: string, agentRole?: string | null): Promise<void> =>
    ipc<void>("append_local_ai_message", aiSessionId, role, content, agentRole ?? null),
  startShellPty: (req: StartShellPtyRequest): Promise<void> =>
    ipc<void>("start_shell_pty", req),
  sendShellInput: (req: ShellInputRequest): Promise<void> =>
    ipc<void>("send_shell_input", req),
  resizeShell: (req: ResizeShellRequest): Promise<void> =>
    ipc<void>("resize_shell", req),
  getShellBuffer: (aiSessionId: string): Promise<string> =>
    ipc<string>("get_shell_buffer", aiSessionId),
  runAiChat: (req: RunAiChatRequest): Promise<string> =>
    ipc<string>("run_ai_chat", req),
  runCodexChat: (req: RunCodexChatRequest): Promise<string> =>
    ipc<string>("run_codex_chat", req),
  runPipelineChat: (req: RunPipelineChatRequest): Promise<void> =>
    ipc<void>("run_pipeline_chat", req),
  listPipelineTemplates: (): Promise<PipelineTemplate[]> =>
    ipc<PipelineTemplate[]>("list_pipeline_templates"),
  steerCodexChat: (req: SteerCodexChatRequest): Promise<boolean> =>
    ipc<boolean>("steer_codex_chat", req),
  listCodexThreads: (req: CodexThreadListRequest): Promise<CodexThreadListResponse> =>
    ipc<CodexThreadListResponse>("list_codex_threads", req),
  readCodexThread: (req: CodexThreadReadRequest): Promise<CodexNativeThread> =>
    ipc<CodexNativeThread>("read_codex_thread", req),
  renameCodexThread: (req: CodexThreadRenameRequest): Promise<boolean> =>
    ipc<boolean>("rename_codex_thread", req),
  archiveCodexThread: (req: CodexThreadArchiveRequest): Promise<boolean> =>
    ipc<boolean>("archive_codex_thread", req),
  deleteCodexThread: (threadId: string): Promise<boolean> =>
    ipc<boolean>("delete_codex_thread", threadId),
  getCodexThreadGoal: (threadId: string): Promise<CodexThreadGoal | null> =>
    ipc<CodexThreadGoal | null>("get_codex_thread_goal", threadId),
  setCodexThreadGoal: (req: CodexThreadGoalSetRequest): Promise<CodexThreadGoal> =>
    ipc<CodexThreadGoal>("set_codex_thread_goal", req),
  clearCodexThreadGoal: (threadId: string): Promise<boolean> =>
    ipc<boolean>("clear_codex_thread_goal", threadId),
  compactCodexThread: (threadId: string): Promise<boolean> =>
    ipc<boolean>("compact_codex_thread", threadId),
  listCodexMcpServers: (): Promise<CodexMcpServer[]> =>
    ipc<CodexMcpServer[]>("list_codex_mcp_servers"),
  readCodexMcpResource: (req: CodexMcpResourceReadRequest): Promise<CodexMcpResourceContent[]> =>
    ipc<CodexMcpResourceContent[]>("read_codex_mcp_resource", req),
  startCodexMcpOauth: (req: CodexMcpOauthRequest): Promise<CodexMcpOauthResponse> =>
    ipc<CodexMcpOauthResponse>("start_codex_mcp_oauth", req),
  reloadCodexMcpServers: (): Promise<CodexMcpServer[]> =>
    ipc<CodexMcpServer[]>("reload_codex_mcp_servers"),
  readCodexConfig: (cwd?: string | null): Promise<CodexConfigSnapshot> =>
    ipc<CodexConfigSnapshot>("read_codex_config", cwd ?? null),
  writeCodexConfigValue: (req: CodexConfigWriteRequest): Promise<CodexConfigWriteResult> =>
    ipc<CodexConfigWriteResult>("write_codex_config_value", req),
  batchWriteCodexConfig: (req: CodexConfigBatchWriteRequest): Promise<CodexConfigWriteResult> =>
    ipc<CodexConfigWriteResult>("batch_write_codex_config", req),
  listCodexFeatures: (): Promise<CodexFeature[]> =>
    ipc<CodexFeature[]>("list_codex_features"),
  setCodexFeature: (req: CodexFeatureSetRequest): Promise<boolean> =>
    ipc<boolean>("set_codex_feature", req),
  listCodexSkills: (req?: CodexSkillsListRequest): Promise<CodexSkillsSnapshot> =>
    ipc<CodexSkillsSnapshot>("list_codex_skills", req ?? {}),
  setCodexSkillEnabled: (req: CodexSkillEnabledRequest): Promise<boolean> =>
    ipc<boolean>("set_codex_skill_enabled", req),
  setCodexSkillsExtraRoots: (extraRoots: string[]): Promise<CodexSkillsSnapshot> =>
    ipc<CodexSkillsSnapshot>("set_codex_skills_extra_roots", extraRoots),
  listCodexModels: (): Promise<CodexModelOption[]> =>
    ipc<CodexModelOption[]>("list_codex_models"),
  listClaudeModels: (): Promise<CodexModelOption[]> =>
    ipc<CodexModelOption[]>("list_claude_models"),
  getCodexApprovalMode: (cwd: string): Promise<CodexApprovalMode> =>
    ipc<CodexApprovalMode>("get_codex_approval_mode", cwd),
  listCodexPermissionProfiles: (cwd: string): Promise<CodexPermissionProfile[]> =>
    ipc<CodexPermissionProfile[]>("list_codex_permission_profiles", cwd),
  listOpenCodeConfigOptions: (cwd: string): Promise<AcpConfigOptions> =>
    ipc<AcpConfigOptions>("list_opencode_config_options", cwd),
  listMimoConfigOptions: (cwd: string): Promise<AcpConfigOptions> =>
    ipc<AcpConfigOptions>("list_mimo_config_options", cwd),
  publishAiRunSettings: (settings: Partial<AiRunSettingsState>): Promise<void> =>
    ipc<void>("publish_ai_run_settings", settings),
  stopAiChat: (aiSessionId: string): Promise<boolean> =>
    ipc<boolean>("stop_ai_chat", aiSessionId),
  hasLiveAiChat: (): Promise<boolean> =>
    ipc<boolean>("has_live_ai_chat"),
  respondCodexApproval: (req: CodexApprovalResponseRequest): Promise<boolean> =>
    ipc<boolean>("respond_codex_approval", req),
  respondAiApproval: (req: CodexApprovalResponseRequest): Promise<boolean> =>
    ipc<boolean>("respond_ai_approval", req),
  respondCodexUserInput: (req: CodexUserInputResponseRequest): Promise<boolean> =>
    ipc<boolean>("respond_codex_user_input", req),
  warmupAiSession: (aiSessionId: string): Promise<AiSession> =>
    ipc<AiSession>("warmup_ai_session", aiSessionId),
  warmupCodexSession: (aiSessionId: string): Promise<AiSession> =>
    ipc<AiSession>("warmup_codex_session", aiSessionId),
  stopShellPty: (aiSessionId: string): Promise<void> =>
    ipc<void>("stop_shell_pty", aiSessionId),
  isShellLive: (aiSessionId: string): Promise<boolean> =>
    ipc<boolean>("is_shell_live", aiSessionId),
  listLocalAiHistory: (aiSessionId: string): Promise<AiHistoryMessage[]> =>
    ipc<AiHistoryMessage[]>("list_local_ai_history", aiSessionId),
  getLocalAiTrace: (aiSessionId: string, traceKind = "codex"): Promise<AiProviderTrace | null> =>
    ipc<AiProviderTrace | null>("get_local_ai_trace", aiSessionId, traceKind),
  listLocalAiSessions: (): Promise<AiSession[]> =>
    ipc<AiSession[]>("list_local_ai_sessions"),
  listProviderSessions: (): Promise<ProviderSessionCatalogEntry[]> =>
    ipc<ProviderSessionCatalogEntry[]>("list_provider_sessions"),
  attachProviderSession: (entry: ProviderSessionCatalogEntry): Promise<AiSession> =>
    ipc<AiSession>("attach_provider_session", entry),
  archiveLocalAiSession: (aiSessionId: string, archived: boolean): Promise<AiSession> =>
    ipc<AiSession>("archive_local_ai_session", aiSessionId, archived),
  deleteLocalAiSession: (aiSessionId: string): Promise<boolean> =>
    ipc<boolean>("delete_local_ai_session", aiSessionId),
  renameLocalAiSession: (aiSessionId: string, title: string): Promise<AiSession> =>
    ipc<AiSession>("rename_local_ai_session", aiSessionId, title),
  renameAiSession: (aiSessionId: string, title: string): Promise<void> =>
    ipc<void>("rename_ai_session", aiSessionId, title),
  openSessionInNewWindow: (aiSessionId: string): Promise<void> =>
    ipc<void>("open_session_in_new_window", aiSessionId),
  getDesktopRuntimeInfo: (): Promise<DesktopRuntimeInfo> =>
    ipc<DesktopRuntimeInfo>("get_desktop_runtime_info"),
  getAppVersion: (): Promise<string> =>
    ipc<string>("get_app_version"),
  checkServerAppUpdate: (): Promise<AppUpdateInfo | null> =>
    ipc<AppUpdateInfo | null>("check_server_app_update"),
  getUpdateDownloadSize: (url: string): Promise<number | null> =>
    ipc<number | null>("get_update_download_size", url),
  checkAppUpdate: (): Promise<AppUpdateInfo> =>
    ipc<AppUpdateInfo>("check_app_update"),
  installAppUpdate: (): Promise<boolean> =>
    ipc<boolean>("install_app_update"),
  onAppUpdateDownloadProgress: (handler: (event: AppUpdateDownloadProgress) => void): Promise<() => void> =>
    Promise.resolve(on("download-progress", handler as (event: unknown) => void)),
  onAppUpdateDownloaded: (handler: (event: AppUpdateDownloadedInfo) => void): Promise<() => void> =>
    Promise.resolve(on("update-downloaded", handler as (event: unknown) => void)),
  onAppUpdateError: (handler: (event: AppUpdateError) => void): Promise<() => void> =>
    Promise.resolve(on("update-error", handler as (event: unknown) => void)),
  onAppUpdateAvailableNotice: (handler: (event: AppUpdateInfo) => void): Promise<() => void> =>
    Promise.resolve(on("app-update-available", handler as (event: unknown) => void)),
  onShellTerminalOutput: (handler: (event: ShellTerminalEvent) => void): Promise<() => void> =>
    Promise.resolve(on("shell-terminal-output", handler as (event: unknown) => void)),
  onShellSessionStatus: (handler: (event: ShellSessionStatusEvent) => void): Promise<() => void> =>
    Promise.resolve(on("shell-session-status", handler as (event: unknown) => void)),
  onAiChatOutput: (handler: (event: AiChatOutputEvent) => void): Promise<() => void> =>
    Promise.resolve(on("ai-chat-output", handler as (event: unknown) => void)),
  onAiTraceUpdate: (handler: (event: AiTraceUpdateEvent) => void): Promise<() => void> =>
    Promise.resolve(on("ai-trace-update", handler as (event: unknown) => void)),
  onPipelineStepUpdate: (handler: (event: PipelineStepUpdateEvent) => void): Promise<() => void> =>
    Promise.resolve(on("pipeline-step-update", handler as (event: unknown) => void)),
  onCodexUserInputRequest: (handler: (event: CodexUserInputRequestEvent) => void): Promise<() => void> =>
    Promise.resolve(on("codex-user-input-request", handler as (event: unknown) => void)),
  onCodexUserInputResolved: (handler: (event: CodexUserInputResolvedEvent) => void): Promise<() => void> =>
    Promise.resolve(on("codex-user-input-resolved", handler as (event: unknown) => void)),
  onWorkspaceChanged: (handler: () => void): Promise<() => void> =>
    Promise.resolve(on("workspace-changed", handler as (...args: unknown[]) => void)),
  onAiHistoryChanged: (handler: (event: AiHistoryChangedEvent) => void): Promise<() => void> =>
    Promise.resolve(on("ai-history-changed", handler as (event: unknown) => void)),
  onAiRunSettingsUpdate: (handler: (event: AiRunSettingsUpdateEvent) => void): Promise<() => void> =>
    Promise.resolve(on("ai-run-settings-update", handler as (event: unknown) => void)),
  onCodexAdminEvent: (handler: (event: CodexAdminEvent) => void): Promise<() => void> =>
    Promise.resolve(on("codex-admin-event", handler as (event: unknown) => void)),
};
