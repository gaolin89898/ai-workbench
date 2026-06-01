import { invoke } from "@tauri-apps/api/core";

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

export type ChatMessage = {
  role: "user" | "assistant" | "system" | "error";
  text: string;
  pending?: boolean;
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

export type SendAiPromptRequest = {
  aiSessionId: string;
  terminalSessionId: string;
  prompt: string;
};

export const tauriApi = {
  listSessions: () => invoke<TerminalSession[]>("list_sessions"),
  pairDesktop: (server: string, code: string) => invoke<PairResponse>("pair_desktop", { server, code }),
  listAiProviders: () => invoke<AiProvider[]>("list_ai_providers"),
  detectAiProviders: () => invoke<ProviderStatus[]>("detect_ai_providers"),
  addWorkspaceProject: (path: string) => invoke<WorkspaceProject>("add_workspace_project", { path }),
  chooseWorkspaceProject: () => invoke<WorkspaceProject | null>("choose_workspace_project"),
  listWorkspaceProjects: () => invoke<WorkspaceProject[]>("list_workspace_projects"),
  createAiSession: (req: CreateAiSessionRequest) => invoke<AiSession>("create_ai_session", { req }),
  sendAiPrompt: (req: SendAiPromptRequest) => invoke<string>("send_ai_prompt", { req }),
  listLocalAiHistory: (aiSessionId: string) => invoke<AiHistoryMessage[]>("list_local_ai_history", { aiSessionId }),
  listLocalAiSessions: () => invoke<AiSession[]>("list_local_ai_sessions"),
  archiveLocalAiSession: (aiSessionId: string, archived: boolean) =>
    invoke<AiSession>("archive_local_ai_session", { aiSessionId, archived }),
};
