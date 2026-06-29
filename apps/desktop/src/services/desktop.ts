export type ViewName = "workspace" | "projects" | "aiSessions" | "providers" | "settings";

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
  authStatus: string;
  lastCheckedAt: string;
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

export type DesktopPairingRequest = {
  code: string;
  expiresAt: string;
};

export type DesktopPairingStatus = {
  status: "pending" | "approved" | "expired" | string;
  expiresAt: string;
  deviceId?: string | null;
  accessToken?: string | null;
};

export type OAuthStartResponse = {
  authUrl: string;
  state: string;
};

export type OAuthPollStatus = "pending" | "success" | "error" | "expired";

export type OAuthPollResponse = {
  status: OAuthPollStatus;
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
  displayName?: string;
  provider?: string;
  error?: string;
};

export type SavedCloudConfig = {
  serverUrl: string;
  deviceId: string;
  paired: boolean;
  authMode?: "desktop-login" | "pairing";
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
      icon?: "check" | "read" | "edit" | "search" | "think" | "warn";
      additions?: number;
      deletions?: number;
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

export type RunCodexChatRequest = {
  aiSessionId: string;
  projectPath: string;
  prompt: string;
  images?: ChatImageAttachment[];
};

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
  stepId?: string | null;
  segment?: ChatSegment | null;
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
};

function requireDesktopApi() {
  if (!window.desktop?.invoke) {
    throw new Error("当前不是 Electron 桌面端窗口，无法打开本地文件夹选择器。请使用 pnpm dev 启动桌面端，不要只在浏览器里打开 Vite 页面。");
  }
  return window.desktop;
}

function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return requireDesktopApi().invoke(channel, ...args) as Promise<T>;
}

function on(channel: string, handler: (...args: unknown[]) => void): () => void {
  return requireDesktopApi().on(channel, handler as (...args: unknown[]) => void);
}

// OAuth HTTP helpers — these call the relay server directly (no IPC) since
// they're just plain HTTP. The desktop renderer can call them when the user
// picks "钉钉登录".
async function oauthHttp<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const text = await resp.text();
      if (text) detail = text;
    } catch {
      /* ignore body read error */
    }
    throw new Error(`HTTP ${resp.status}: ${detail}`);
  }
  return resp.json() as Promise<T>;
}

export const oauthApi = {
  dingTalkStart: (serverUrl: string): Promise<OAuthStartResponse> =>
    oauthHttp<OAuthStartResponse>(`${serverUrl}/oauth/dingtalk/start`, { method: "GET", credentials: "include" }),
  dingTalkPoll: (serverUrl: string, state: string): Promise<OAuthPollResponse> =>
    oauthHttp<OAuthPollResponse>(`${serverUrl}/oauth/dingtalk/poll?state=${encodeURIComponent(state)}`, { method: "GET" }),
};

export const desktopApi = {
  listSessions: (): Promise<TerminalSession[]> =>
    ipc<TerminalSession[]>("list_sessions"),
  loginDesktop: (server: string, email: string, password: string): Promise<PairResponse> =>
    ipc<PairResponse>("login_desktop", server, email, password),
  logoutDesktop: (): Promise<void> =>
    ipc<void>("logout_desktop"),
  saveOAuthLogin: (serverUrl: string, accessToken: string, userId: string, displayName: string): Promise<void> =>
    ipc<void>("save_oauth_login", serverUrl, accessToken, userId, displayName),
  openExternalUrl: (url: string): Promise<void> =>
    ipc<void>("open_external_url", url),
  pairDesktop: (server: string, code: string): Promise<PairResponse> =>
    ipc<PairResponse>("pair_desktop", server, code),
  createDesktopPairingRequest: (server: string): Promise<DesktopPairingRequest> =>
    ipc<DesktopPairingRequest>("create_desktop_pairing_request", server),
  getDesktopPairingStatus: (server: string, code: string): Promise<DesktopPairingStatus> =>
    ipc<DesktopPairingStatus>("get_desktop_pairing_status", server, code),
  buildDesktopPairingQrPayload: (server: string, code: string): Promise<string> =>
    ipc<string>("build_desktop_pairing_qr_payload", server, code),
  getCloudConfig: (): Promise<SavedCloudConfig | null> =>
    ipc<SavedCloudConfig | null>("get_cloud_config"),
  readClipboardImage: (): Promise<ClipboardImage | null> =>
    ipc<ClipboardImage | null>("read_clipboard_image"),
  listAiProviders: (): Promise<AiProvider[]> =>
    ipc<AiProvider[]>("list_ai_providers"),
  detectAiProviders: (): Promise<ProviderStatus[]> =>
    ipc<ProviderStatus[]>("detect_ai_providers"),
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
  stopAiChat: (aiSessionId: string): Promise<boolean> =>
    ipc<boolean>("stop_ai_chat", aiSessionId),
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
  checkAppUpdate: (): Promise<AppUpdateInfo> =>
    ipc<AppUpdateInfo>("check_app_update"),
  installAppUpdate: (): Promise<boolean> =>
    ipc<boolean>("install_app_update"),
  onShellTerminalOutput: (handler: (event: ShellTerminalEvent) => void): Promise<() => void> =>
    Promise.resolve(on("shell-terminal-output", handler as (event: unknown) => void)),
  onShellSessionStatus: (handler: (event: ShellSessionStatusEvent) => void): Promise<() => void> =>
    Promise.resolve(on("shell-session-status", handler as (event: unknown) => void)),
  onAiChatOutput: (handler: (event: AiChatOutputEvent) => void): Promise<() => void> =>
    Promise.resolve(on("ai-chat-output", handler as (event: unknown) => void)),
  onWorkspaceChanged: (handler: () => void): Promise<() => void> =>
    Promise.resolve(on("workspace-changed", handler as (...args: unknown[]) => void)),
  onAiHistoryChanged: (handler: (event: AiHistoryChangedEvent) => void): Promise<() => void> =>
    Promise.resolve(on("ai-history-changed", handler as (event: unknown) => void)),
};
