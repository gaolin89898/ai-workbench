export type ViewName = "workspace" | "projects" | "aiSessions" | "providers" | "settings" | "tokenUsage";

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

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
};

export type AiSession = {
  id: string;
  providerId: string;
  terminalSessionId?: string | null;
  providerSessionId?: string | null;
  title: string;
  status: string;
  summary?: string | null;
  archivedAt?: string | null;
  updatedAt?: string;
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
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turnCount: number;
};

export type TokenUsageSummary = {
  providers: TokenUsageSummaryItem[];
  totals: TokenUsageSummaryItem;
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
      approvalKind: "command" | "fileChange";
      status: "pending" | "approved" | "denied" | "expired" | "failed";
      title: string;
      reason?: string;
      command?: string;
      cwd?: string;
      grantRoot?: string;
      fileChanges?: string[];
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
  pending?: boolean;
  segments?: ChatSegment[];
  images?: ChatImageAttachment[];
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
  command?: string | null;
  output?: string | null;
  diff?: string | null;
  additions?: number | null;
  deletions?: number | null;
};

export type CodexTraceApproval = {
  id: string;
  kind: "command" | "fileChange";
  status: "pending" | "approved" | "denied" | "expired" | "failed";
  title: string;
  command?: string | null;
  cwd?: string | null;
  fileChanges?: string[];
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
  steps: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  updatedAt: string;
};

export type CodexTraceGoal = {
  objective: string;
  status?: string | null;
  updatedAt: string;
};

export type CodexTraceSnapshot = {
  provider: "codex";
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
};

export type CreateAiSessionRequest = {
  providerId: string;
  projectPath: string;
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
export type CodexApprovalMode = "suggest" | "autoEdit" | "fullAccess";
export type CodexRunMode = "default" | "plan";

export type CodexApprovalResponseRequest = {
  aiSessionId: string;
  approvalId: string;
  decision: CodexApprovalDecision;
};

export type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  description?: string | null;
  isDefault?: boolean;
};

export type CodexReasoningEffort = "low" | "medium" | "high" | "ultra";

export type CodexChatOptions = {
  approvalMode?: CodexApprovalMode;
  codexMode?: CodexRunMode;
  codexModel?: string | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  codexGoal?: string | null;
  codexGoalTokenBudget?: number | null;
};

export type RunCodexChatRequest = {
  aiSessionId: string;
  projectPath: string;
  prompt: string;
  images?: ChatImageAttachment[];
} & CodexChatOptions;

export type RunAiChatRequest = {
  aiSessionId: string;
  projectPath: string;
  prompt: string;
  images?: ChatImageAttachment[];
};

export type ChatImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
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
  getTokenUsageSummary: (): Promise<TokenUsageSummary | null> =>
    ipc<TokenUsageSummary | null>("get_token_usage_summary"),
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
  listProjectFiles: (path: string, directoryPath?: string | null): Promise<WorkspaceFileEntry[]> =>
    ipc<WorkspaceFileEntry[]>("list_project_files", path, directoryPath ?? null),
  createAiSession: (req: CreateAiSessionRequest): Promise<AiSession> =>
    ipc<AiSession>("create_ai_session", req),
  restartAiSession: (aiSessionId: string): Promise<AiSession> =>
    ipc<AiSession>("restart_ai_session", aiSessionId),
  appendLocalAiMessage: (aiSessionId: string, role: ChatMessage["role"], content: string): Promise<void> =>
    ipc<void>("append_local_ai_message", aiSessionId, role, content),
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
  listCodexModels: (): Promise<CodexModelOption[]> =>
    ipc<CodexModelOption[]>("list_codex_models"),
  stopAiChat: (aiSessionId: string): Promise<boolean> =>
    ipc<boolean>("stop_ai_chat", aiSessionId),
  respondCodexApproval: (req: CodexApprovalResponseRequest): Promise<boolean> =>
    ipc<boolean>("respond_codex_approval", req),
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
  archiveLocalAiSession: (aiSessionId: string, archived: boolean): Promise<AiSession> =>
    ipc<AiSession>("archive_local_ai_session", aiSessionId, archived),
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
  onWorkspaceChanged: (handler: () => void): Promise<() => void> =>
    Promise.resolve(on("workspace-changed", handler as (...args: unknown[]) => void)),
  onAiHistoryChanged: (handler: (event: AiHistoryChangedEvent) => void): Promise<() => void> =>
    Promise.resolve(on("ai-history-changed", handler as (event: unknown) => void)),
};
