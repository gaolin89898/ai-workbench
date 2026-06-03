import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
      icon?: "check" | "read" | "edit" | "search" | "think";
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
  kind: "status" | "step-start" | "step-update" | "done" | "error";
  text?: string;
  stepId?: string | null;
  segment?: ChatSegment | null;
};

export type AiHistoryChangedEvent = {
  aiSessionId: string;
};

export const tauriApi = {
  listSessions: () => invoke<TerminalSession[]>("list_sessions"),
  pairDesktop: (server: string, code: string) => invoke<PairResponse>("pair_desktop", { server, code }),
  createDesktopPairingRequest: (server: string) =>
    invoke<DesktopPairingRequest>("create_desktop_pairing_request", { server }),
  getDesktopPairingStatus: (server: string, code: string) =>
    invoke<DesktopPairingStatus>("get_desktop_pairing_status", { server, code }),
  buildDesktopPairingQrPayload: (server: string, code: string) =>
    invoke<string>("build_desktop_pairing_qr_payload", { server, code }),
  getCloudConfig: () => invoke<SavedCloudConfig | null>("get_cloud_config"),
  listAiProviders: () => invoke<AiProvider[]>("list_ai_providers"),
  detectAiProviders: () => invoke<ProviderStatus[]>("detect_ai_providers"),
  addWorkspaceProject: (path: string) => invoke<WorkspaceProject>("add_workspace_project", { path }),
  chooseWorkspaceProject: () => invoke<WorkspaceProject | null>("choose_workspace_project"),
  listWorkspaceProjects: () => invoke<WorkspaceProject[]>("list_workspace_projects"),
  createAiSession: (req: CreateAiSessionRequest) => invoke<AiSession>("create_ai_session", { req }),
  restartAiSession: (aiSessionId: string) => invoke<AiSession>("restart_ai_session", { aiSessionId }),
  appendLocalAiMessage: (aiSessionId: string, role: ChatMessage["role"], content: string) =>
    invoke<void>("append_local_ai_message", { aiSessionId, role, content }),
  startShellPty: (req: StartShellPtyRequest) => invoke<void>("start_shell_pty", { req }),
  sendShellInput: (req: ShellInputRequest) => invoke<void>("send_shell_input", { req }),
  resizeShell: (req: ResizeShellRequest) => invoke<void>("resize_shell", { req }),
  getShellBuffer: (aiSessionId: string) => invoke<string>("get_shell_buffer", { aiSessionId }),
  runCodexChat: (req: RunCodexChatRequest) => invoke<string>("run_codex_chat", { req }),
  warmupCodexSession: (aiSessionId: string) => invoke<AiSession>("warmup_codex_session", { aiSessionId }),
  stopShellPty: (aiSessionId: string) => invoke<void>("stop_shell_pty", { aiSessionId }),
  isShellLive: (aiSessionId: string) => invoke<boolean>("is_shell_live", { aiSessionId }),
  listLocalAiHistory: (aiSessionId: string) => invoke<AiHistoryMessage[]>("list_local_ai_history", { aiSessionId }),
  listLocalAiSessions: () => invoke<AiSession[]>("list_local_ai_sessions"),
  archiveLocalAiSession: (aiSessionId: string, archived: boolean) =>
    invoke<AiSession>("archive_local_ai_session", { aiSessionId, archived }),
  onShellTerminalOutput: (handler: (event: ShellTerminalEvent) => void) =>
    listen<ShellTerminalEvent>("shell-terminal-output", ({ payload }) => handler(payload)),
  onShellSessionStatus: (handler: (event: ShellSessionStatusEvent) => void) =>
    listen<ShellSessionStatusEvent>("shell-session-status", ({ payload }) => handler(payload)),
  onAiChatOutput: (handler: (event: AiChatOutputEvent) => void) =>
    listen<AiChatOutputEvent>("ai-chat-output", ({ payload }) => handler(payload)),
  onWorkspaceChanged: (handler: () => void) =>
    listen<void>("workspace-changed", () => handler()),
  onAiHistoryChanged: (handler: (event: AiHistoryChangedEvent) => void) =>
    listen<AiHistoryChangedEvent>("ai-history-changed", ({ payload }) => handler(payload)),
};
