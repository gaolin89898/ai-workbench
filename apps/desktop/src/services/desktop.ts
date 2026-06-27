export type ViewName = "workspace" | "projects" | "aiSessions" | "providers" | "pairing" | "settings";

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

export type SavedCloudConfig = {
  serverUrl: string;
  deviceId: string;
  paired: boolean;
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
};

export type RunAiChatRequest = {
  aiSessionId: string;
  projectPath: string;
  prompt: string;
};

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
};

export const desktopApi = {
  listSessions: (): Promise<TerminalSession[]> =>
    window.desktop.ipc.list_sessions() as Promise<TerminalSession[]>,
  pairDesktop: (server: string, code: string): Promise<PairResponse> =>
    window.desktop.ipc.pair_desktop(server, code) as Promise<PairResponse>,
  createDesktopPairingRequest: (server: string): Promise<DesktopPairingRequest> =>
    window.desktop.ipc.create_desktop_pairing_request(server) as Promise<DesktopPairingRequest>,
  getDesktopPairingStatus: (server: string, code: string): Promise<DesktopPairingStatus> =>
    window.desktop.ipc.get_desktop_pairing_status(server, code) as Promise<DesktopPairingStatus>,
  buildDesktopPairingQrPayload: (server: string, code: string): Promise<string> =>
    window.desktop.ipc.build_desktop_pairing_qr_payload(server, code) as Promise<string>,
  getCloudConfig: (): Promise<SavedCloudConfig | null> =>
    window.desktop.ipc.get_cloud_config() as Promise<SavedCloudConfig | null>,
  listAiProviders: (): Promise<AiProvider[]> =>
    window.desktop.ipc.list_ai_providers() as Promise<AiProvider[]>,
  detectAiProviders: (): Promise<ProviderStatus[]> =>
    window.desktop.ipc.detect_ai_providers() as Promise<ProviderStatus[]>,
  addWorkspaceProject: (path: string): Promise<WorkspaceProject> =>
    window.desktop.ipc.add_workspace_project(path) as Promise<WorkspaceProject>,
  chooseWorkspaceProject: (): Promise<WorkspaceProject | null> =>
    window.desktop.ipc.choose_workspace_project() as Promise<WorkspaceProject | null>,
  listWorkspaceProjects: (): Promise<WorkspaceProject[]> =>
    window.desktop.ipc.list_workspace_projects() as Promise<WorkspaceProject[]>,
  renameWorkspaceProject: (id: string, name: string): Promise<WorkspaceProject> =>
    window.desktop.ipc.rename_workspace_project(id, name) as Promise<WorkspaceProject>,
  removeWorkspaceProject: (id: string): Promise<void> =>
    window.desktop.ipc.remove_workspace_project(id) as Promise<void>,
  openProjectInFileManager: (path: string): Promise<void> =>
    window.desktop.ipc.open_project_in_file_manager(path) as Promise<void>,
  createAiSession: (req: CreateAiSessionRequest): Promise<AiSession> =>
    window.desktop.ipc.create_ai_session(req) as Promise<AiSession>,
  restartAiSession: (aiSessionId: string): Promise<AiSession> =>
    window.desktop.ipc.restart_ai_session(aiSessionId) as Promise<AiSession>,
  appendLocalAiMessage: (aiSessionId: string, role: ChatMessage["role"], content: string): Promise<void> =>
    window.desktop.ipc.append_local_ai_message(aiSessionId, role, content) as Promise<void>,
  startShellPty: (req: StartShellPtyRequest): Promise<void> =>
    window.desktop.ipc.start_shell_pty(req) as Promise<void>,
  sendShellInput: (req: ShellInputRequest): Promise<void> =>
    window.desktop.ipc.send_shell_input(req) as Promise<void>,
  resizeShell: (req: ResizeShellRequest): Promise<void> =>
    window.desktop.ipc.resize_shell(req) as Promise<void>,
  getShellBuffer: (aiSessionId: string): Promise<string> =>
    window.desktop.ipc.get_shell_buffer(aiSessionId) as Promise<string>,
  runAiChat: (req: RunAiChatRequest): Promise<string> =>
    window.desktop.ipc.run_ai_chat(req) as Promise<string>,
  runCodexChat: (req: RunCodexChatRequest): Promise<string> =>
    window.desktop.ipc.run_codex_chat(req) as Promise<string>,
  warmupAiSession: (aiSessionId: string): Promise<AiSession> =>
    window.desktop.ipc.warmup_ai_session(aiSessionId) as Promise<AiSession>,
  warmupCodexSession: (aiSessionId: string): Promise<AiSession> =>
    window.desktop.ipc.warmup_codex_session(aiSessionId) as Promise<AiSession>,
  stopShellPty: (aiSessionId: string): Promise<void> =>
    window.desktop.ipc.stop_shell_pty(aiSessionId) as Promise<void>,
  isShellLive: (aiSessionId: string): Promise<boolean> =>
    window.desktop.ipc.is_shell_live(aiSessionId) as Promise<boolean>,
  listLocalAiHistory: (aiSessionId: string): Promise<AiHistoryMessage[]> =>
    window.desktop.ipc.list_local_ai_history(aiSessionId) as Promise<AiHistoryMessage[]>,
  listLocalAiSessions: (): Promise<AiSession[]> =>
    window.desktop.ipc.list_local_ai_sessions() as Promise<AiSession[]>,
  archiveLocalAiSession: (aiSessionId: string, archived: boolean): Promise<AiSession> =>
    window.desktop.ipc.archive_local_ai_session(aiSessionId, archived) as Promise<AiSession>,
  renameLocalAiSession: (aiSessionId: string, title: string): Promise<AiSession> =>
    window.desktop.ipc.rename_local_ai_session(aiSessionId, title) as Promise<AiSession>,
  openSessionInNewWindow: (aiSessionId: string): Promise<void> =>
    window.desktop.ipc.open_session_in_new_window(aiSessionId) as Promise<void>,
  checkAppUpdate: (): Promise<AppUpdateInfo> =>
    window.desktop.ipc.check_app_update() as Promise<AppUpdateInfo>,
  installAppUpdate: (): Promise<boolean> =>
    window.desktop.ipc.install_app_update() as Promise<boolean>,
  onShellTerminalOutput: (handler: (event: ShellTerminalEvent) => void): Promise<() => void> =>
    Promise.resolve(window.desktop.on["shell-terminal-output"](handler as (event: unknown) => void)),
  onShellSessionStatus: (handler: (event: ShellSessionStatusEvent) => void): Promise<() => void> =>
    Promise.resolve(window.desktop.on["shell-session-status"](handler as (event: unknown) => void)),
  onAiChatOutput: (handler: (event: AiChatOutputEvent) => void): Promise<() => void> =>
    Promise.resolve(window.desktop.on["ai-chat-output"](handler as (event: unknown) => void)),
  onWorkspaceChanged: (handler: () => void): Promise<() => void> =>
    Promise.resolve(window.desktop.on["workspace-changed"](handler as (...args: unknown[]) => void)),
  onAiHistoryChanged: (handler: (event: AiHistoryChangedEvent) => void): Promise<() => void> =>
    Promise.resolve(window.desktop.on["ai-history-changed"](handler as (event: unknown) => void)),
};
