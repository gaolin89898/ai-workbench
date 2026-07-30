// IPC handler registration for the Electron main process.
// Registers ipcMain.handle listeners for every channel exposed by the preload
// bridge (window.desktop.ipc.<channel>(...args)).
//
// Arg passing contract: the preload proxy calls
//   ipcRenderer.invoke(channel, args)
// where `args` is the array of frontend arguments. So every handler receives
// a single `args` array as the second parameter (after the IpcMainInvokeEvent).
// Example: window.desktop.ipc.loginDesktop("http://...", "user@example.com", "password") ->
//   ipcMain.handle("login_desktop", (_event, args) => { const [server, email, password] = args; ... })

import { app, ipcMain, BrowserWindow, clipboard, dialog, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as db from "./db";
import * as pty from "./pty";
import * as providers from "./providers";
import * as projects from "./projects";
import {
  loginDesktop,
  githubLoginStart,
  githubLoginPoll,
  googleLoginStart,
  googleLoginPoll,
  logoutDesktop,
  getCloudConfig,
  getDesktopCloudSync,
  fetchTokenUsageSummary,
  fetchDesktopAppRelease,
} from "./sync";
import { saveCredentials, loadCredentials, clearCredentials } from "./credentials";
import { getCodexApprovalMode, hasLiveCodexChat, listCodexModels, respondCodexApproval, respondCodexUserInput, runCodexChat, steerCodexChat, stopCodexChat } from "./codex";
import {
  archiveCodexThread,
  batchWriteCodexConfig,
  clearCodexThreadGoal,
  compactCodexThread,
  deleteCodexThread,
  getCodexThreadGoal,
  listCodexFeatures,
  listCodexSkills,
  listCodexMcpServers,
  listCodexPermissionProfiles,
  listCodexThreads,
  readCodexConfig,
  readCodexMcpResource,
  readCodexThread,
  reloadCodexMcpServers,
  renameCodexThread,
  setCodexThreadGoal,
  setCodexFeature,
  setCodexSkillEnabled,
  setCodexSkillsExtraRoots,
  startCodexMcpOauth,
  writeCodexConfigValue,
} from "./codex_admin";
import { syncCodexHistoryMirror } from "./codex_sessions";
import { hasLiveAiChat, runAiChat, stopAiChat } from "./claude";
import { hasLiveOpenCodeChat, listOpenCodeConfigOptions, runOpenCodeChat, stopOpenCodeChat } from "./acp";
import { hasLiveMimoChat, listMimoConfigOptions, respondMimoApproval, runMimoChat, stopMimoChat } from "./mimo";
import { checkAppUpdate, getUpdateDownloadSize, installAppUpdate, initUpdater } from "./updater";
import { listProjectFiles, openProjectHtmlInBrowser, readProjectFileForViewer, readProjectFilePreview } from "./project_files";
import { attachProviderSession, listProviderSessions } from "./provider_sessions";
import { listPipelineTemplates, runPipelineChat, stopPipelineChat, hasLivePipelineChat } from "./orchestrator";
import { listChatroomRoles, runChatroomTurn, stopChatroomTurn, hasLiveChatroom } from "./chatroom";
import type {
  CreateAiSessionRequest,
  StartShellPtyRequest,
  ShellInputRequest,
  ResizeShellRequest,
  RunAiChatRequest,
  RunCodexChatRequest,
  RunPipelineChatRequest,
  RunChatroomTurnRequest,
  SteerCodexChatRequest,
  CodexApprovalResponseRequest,
  CodexUserInputResponseRequest,
  CodexConfigBatchWriteRequest,
  CodexConfigWriteRequest,
  CodexSkillEnabledRequest,
  CodexSkillsListRequest,
  CodexFeatureSetRequest,
  CodexMcpOauthRequest,
  CodexMcpResourceReadRequest,
  CodexThreadListRequest,
  CodexThreadReadRequest,
  CodexThreadRenameRequest,
  CodexThreadArchiveRequest,
  CodexThreadGoalSetRequest,
  ChatFileAttachment,
  ChatMessage,
  ProjectOpenTarget,
  ProviderSessionCatalogEntry,
} from "../services/desktop";

let mainWindow: BrowserWindow | null = null;

function codexThreadId(providerSessionId?: string | null): string | null {
  const value = providerSessionId?.trim();
  if (!value) return null;
  return value.startsWith("app-server:") ? value.slice("app-server:".length) : value;
}

function attachmentMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".jsx": "text/javascript",
    ".py": "text/x-python",
    ".java": "text/x-java-source",
    ".go": "text/x-go",
    ".rs": "text/x-rust",
    ".vue": "text/x-vue",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".xml": "application/xml",
  };
  return types[extension] ?? "application/octet-stream";
}

type SafeIpcError = {
  __AI_WORKBENCH_IPC_ERROR__: true;
  name: string;
  message: string;
  stack?: string;
};

function toSafeIpcError(error: unknown): SafeIpcError {
  if (error instanceof Error) {
    return {
      __AI_WORKBENCH_IPC_ERROR__: true,
      name: error.name || "Error",
      message: error.message || "IPC 调用失败",
      stack: error.stack,
    };
  }
  return {
    __AI_WORKBENCH_IPC_ERROR__: true,
    name: "Error",
    message: typeof error === "string" ? error : "IPC 调用失败",
  };
}

function handle<TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, args: TArgs) => Promise<TResult> | TResult,
) {
  ipcMain.handle(channel, async (event, args: TArgs) => {
    try {
      return await listener(event, args);
    } catch (error) {
      return toSafeIpcError(error);
    }
  });
}

/**
 * Resolve a WebContents sender for streaming events (shell output / AI chat
 * output) to the renderer. Falls back to the first available BrowserWindow if
 * no window was passed to registerIpcHandlers.
 */
function getSender(): WebContents {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.webContents;
  }
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    return wins[0].webContents;
  }
  throw new Error("no BrowserWindow available to send events");
}

export function registerIpcHandlers(win?: BrowserWindow): void {
  if (win) {
    mainWindow = win;
    initUpdater(win);
  }

  // ---------- legacy terminal sessions ----------

  // Old tmux/screen agent sessions were removed; terminal sessions now stream
  // live via PTY events. Kept as an empty-array stub for API compatibility.
  handle("list_sessions", async () => []);

  // ---------- cloud pairing ----------

  // login_desktop takes [server, email, password].
  handle("login_desktop", async (_event, args: [string, string, string]) =>
    loginDesktop(args[0], args[1], args[2])
  );

  // github_login_start begins a GitHub OAuth flow; returns {authorizeUrl,state}.
  handle("github_login_start", async (_event, args: [string, boolean?]) =>
    githubLoginStart(args[0], args[1] ?? true)
  );

  // github_login_poll checks whether the OAuth flow finished. Returns
  // {status, accessToken?, deviceId?, error?}.
  handle("github_login_poll", async (_event, args: [string, string]) =>
    githubLoginPoll(args[0], args[1])
  );

  // google_login_start begins a Google OAuth flow; returns {authorizeUrl,state}.
  handle("google_login_start", async (_event, args: [string, boolean?]) =>
    googleLoginStart(args[0], args[1] ?? true)
  );

  // google_login_poll checks whether the Google OAuth flow finished. Returns
  // {status, accessToken?, deviceId?, error?}.
  handle("google_login_poll", async (_event, args: [string, string]) =>
    googleLoginPoll(args[0], args[1])
  );

  handle("logout_desktop", async () => {
    logoutDesktop();
  });

  handle("save_credentials", async (_event, args: [string, string]) =>
    saveCredentials(args[0], args[1])
  );

  handle("load_credentials", async () => loadCredentials());

  handle("clear_credentials", async () => clearCredentials());

  // 在系统默认浏览器中打开 URL（用于外部文档和授权跳转）。
  handle("open_external_url", async (_event, args: [string]) => {
    const url = args[0];
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  handle("get_cloud_config", async () => getCloudConfig());

  handle("get_token_usage_summary", async (_event, args: [number]) => fetchTokenUsageSummary(args[0]));

  handle("get_ai_activity_summary", async () => db.getAiActivitySummary());

  handle("export_text_file", async (_event, args: [string, string]) => {
    const options = {
      defaultPath: args[0],
      filters: [{ name: "CSV", extensions: ["csv"] }],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, `\uFEFF${args[1]}`, "utf8");
    return true;
  });

  handle("read_clipboard_image", async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    return {
      name: "截图",
      mimeType: "image/png",
      dataUrl: image.toDataURL(),
    };
  });

  // ---------- AI providers ----------

  handle("list_ai_providers", async () => providers.listAiProviders());

  handle("detect_ai_providers", async () => providers.detectAiProviders());

  handle("run_provider_action", async (_event, args: [string, providers.ProviderActionKind]) =>
    providers.runProviderAction(args[0], args[1])
  );

  handle("get_npm_registry", async () => providers.getNpmRegistry());

  handle("set_npm_registry", async (_event, args: [string]) =>
    providers.setNpmRegistry(args[0])
  );

  handle("probe_npm_registries", async () => providers.probeNpmRegistries());

  // ---------- workspace projects ----------

  handle("add_workspace_project", async (_event, args: [string]) => {
    const project = await db.addWorkspaceProject(args[0]);
    getSender().send("workspace-changed");
    getDesktopCloudSync()?.pushProjectSnapshot();
    return project;
  });

  handle("choose_workspace_project", async () => {
    const projectPath = await projects.chooseWorkspaceProjectPath(mainWindow);
    if (!projectPath) return null;
    const project = await db.addWorkspaceProject(projectPath);
    getSender().send("workspace-changed");
    getDesktopCloudSync()?.pushProjectSnapshot();
    return project;
  });

  handle("list_workspace_projects", async () => db.listWorkspaceProjects());

  handle("rename_workspace_project", async (_event, args: [string, string]) =>
    db.renameWorkspaceProject(args[0], args[1])
  );

  handle("remove_workspace_project", async (_event, args: [string]) => {
    db.removeWorkspaceProject(args[0]);
  });

  handle("open_project_in_file_manager", async (_event, args: [string]) =>
    projects.openProjectInFileManager(args[0])
  );

  handle("open_project_with", async (_event, args: [string, ProjectOpenTarget]) =>
    projects.openProjectWith(args[0], args[1])
  );

  handle("get_project_environment", async (_event, args: [string]) =>
    projects.readProjectEnvironment(args[0])
  );

  handle("list_project_files", async (_event, args: [string, string | null]) =>
    listProjectFiles(args[0], args[1])
  );

  handle("choose_chat_file_attachments", async () => {
    const options = {
      properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections">,
      filters: [
        { name: "文档与代码", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "md", "mdx", "txt", "csv", "json", "jsonc", "js", "jsx", "ts", "tsx", "vue", "html", "css", "scss", "py", "java", "go", "rs", "rb", "php", "c", "cpp", "h", "hpp", "cs", "swift", "kt", "sql", "xml", "yaml", "yml", "toml", "ini", "sh"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    const attachments: ChatFileAttachment[] = [];
    for (const filePath of result.filePaths.slice(0, 10)) {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      attachments.push({
        id: randomUUID(),
        name: path.basename(filePath),
        path: filePath,
        mimeType: attachmentMimeType(filePath),
        size: info.size,
      });
    }
    return attachments;
  });

  handle("read_project_file_preview", async (_event, args: [string, string]) =>
    readProjectFilePreview(args[0], args[1])
  );

  handle("read_project_file_for_viewer", async (_event, args: [string, string]) =>
    readProjectFileForViewer(args[0], args[1])
  );

  handle("open_project_html_in_browser", async (_event, args: [string, string]) =>
    openProjectHtmlInBrowser(args[0], args[1])
  );

  // ---------- AI sessions ----------

  handle("create_ai_session", async (_event, args: [CreateAiSessionRequest]) => {
    const req = args[0];
    const id = randomUUID();

    let sessionProjectPath = req.projectPath || null;
    // Best-effort: register the workspace project so it appears in lists.
    // 如果传入的是已添加项目里的子文件夹，会归到已有项目，避免自动新增子项目。
    if (req.projectPath) {
      try {
        sessionProjectPath = await db.resolveWorkspaceProjectPath(req.projectPath);
      } catch {
        // project may not exist or git may be unavailable — ignore
      }
    }

    const session = db.createLocalAiSession({
      id,
      providerId: req.providerId,
      terminalSessionId: req.terminalSessionId ?? null,
      title: req.title,
      status: "idle",
      projectPath: sessionProjectPath,
    });

    // Immediately push the updated session list to the cloud so mobile clients
    // see the new session without waiting for the next 10s snapshot tick.
    getDesktopCloudSync()?.pushSessionSnapshot();

    return session;
  });

  handle("restart_ai_session", async (_event, args: [string]) =>
    db.updateLocalAiSession(args[0], {
      status: "idle",
      providerSessionId: null,
      projectPath: null,
    })
  );

  handle(
    "append_local_ai_message",
    async (_event, args: [string, ChatMessage["role"], string, string?]) => {
      const [aiSessionId, role, content, agentRole] = args;
      db.appendLocalAiMessage(aiSessionId, role, content, agentRole);
      getSender().send("ai-history-changed", { aiSessionId });
      await getDesktopCloudSync()?.pushAiHistory(aiSessionId);
    }
  );

  // ---------- shell PTY ----------

  handle("start_shell_pty", async (_event, args: [StartShellPtyRequest]) => {
    pty.startShellPty(args[0], getSender());
  });

  handle("send_shell_input", async (_event, args: [ShellInputRequest]) => {
    pty.sendShellInput(args[0]);
  });

  handle("resize_shell", async (_event, args: [ResizeShellRequest]) => {
    pty.resizeShell(args[0]);
  });

  handle("get_shell_buffer", async (_event, args: [string]) =>
    pty.getShellBuffer(args[0])
  );

  handle("stop_shell_pty", async (_event, args: [string]) => {
    pty.stopShellPty(args[0]);
  });

  handle("is_shell_live", async (_event, args: [string]) =>
    pty.isShellLive(args[0])
  );

  // ---------- AI chat ----------

  handle("run_ai_chat", async (_event, args: [RunAiChatRequest]) => {
    const req = args[0];
    const sync = getDesktopCloudSync();
    sync?.beginAiTurn(req.aiSessionId);
    const sender = sync?.createRendererAndMobileAiChatSender(getSender()) ?? getSender();
    // Resume an existing session if we have a providerSessionId stored.
    const session = db.getLocalAiSession(req.aiSessionId);
    const existingSessionId = session?.providerSessionId ?? null;
    const providerId = session?.providerId ?? "claude";
    const providerSessionId = providerId === "opencode"
      ? await runOpenCodeChat(req, sender, existingSessionId)
      : providerId === "mimo"
        ? await runMimoChat(req, sender, existingSessionId)
        : await runAiChat(req, sender, existingSessionId);
    db.updateLocalAiSession(req.aiSessionId, {
      providerSessionId: providerSessionId || existingSessionId,
      status: "completed",
    });
    void sync?.pushSessionSnapshot();
    void sync?.pushAiHistory(req.aiSessionId);
    return providerSessionId;
  });

  handle("run_codex_chat", async (_event, args: [RunCodexChatRequest]) => {
    const req = args[0];
    const session = db.getLocalAiSession(req.aiSessionId);
    const existingSessionId = session?.providerSessionId ?? null;
    const sync = getDesktopCloudSync();
    sync?.beginAiTurn(req.aiSessionId);
    const sender = sync?.createRendererAndMobileAiChatSender(getSender()) ?? getSender();
    const providerSessionId = await runCodexChat(req, sender);
    db.updateLocalAiSession(req.aiSessionId, {
      providerSessionId: providerSessionId || existingSessionId,
      status: "completed",
    });
    void sync?.pushSessionSnapshot();
    void sync?.pushAiHistory(req.aiSessionId);
    return providerSessionId;
  });

  handle("list_codex_models", async () => listCodexModels());

  handle("steer_codex_chat", async (_event, args: [SteerCodexChatRequest]) =>
    steerCodexChat(args[0])
  );

  // ---------- Multi-agent pipeline ----------

  handle("list_pipeline_templates", async () => listPipelineTemplates());

  handle("run_pipeline_chat", async (_event, args: [RunPipelineChatRequest]) => {
    const req = args[0];
    const sync = getDesktopCloudSync();
    sync?.beginAiTurn(req.aiSessionId);
    const sender = sync?.createRendererAndMobileAiChatSender(getSender()) ?? getSender();
    db.updateLocalAiSession(req.aiSessionId, { status: "running" });
    try {
      await runPipelineChat(req, sender);
      db.updateLocalAiSession(req.aiSessionId, { status: "completed" });
    } catch (err) {
      db.updateLocalAiSession(req.aiSessionId, { status: "failed" });
      throw err;
    } finally {
      void sync?.pushSessionSnapshot();
      void sync?.pushAiHistory(req.aiSessionId);
    }
  });

  // ---------- Chatroom ----------

  handle("list_chatroom_roles", async () => listChatroomRoles());

  handle("run_chatroom_turn", async (_event, args: [RunChatroomTurnRequest]) => {
    const req = args[0];
    const sync = getDesktopCloudSync();
    sync?.beginAiTurn(req.aiSessionId);
    const sender = sync?.createRendererAndMobileAiChatSender(getSender()) ?? getSender();
    db.updateLocalAiSession(req.aiSessionId, { status: "running" });
    try {
      await runChatroomTurn(req, sender);
      db.updateLocalAiSession(req.aiSessionId, { status: "completed" });
    } catch (err) {
      db.updateLocalAiSession(req.aiSessionId, { status: "failed" });
      throw err;
    } finally {
      void sync?.pushSessionSnapshot();
      void sync?.pushAiHistory(req.aiSessionId);
    }
  });

  // ---------- Codex management ----------

  handle("list_codex_threads", async (event, args: [CodexThreadListRequest]) =>
    listCodexThreads(args[0], event.sender)
  );

  handle("read_codex_thread", async (event, args: [CodexThreadReadRequest]) =>
    readCodexThread(args[0], event.sender)
  );

  handle("rename_codex_thread", async (event, args: [CodexThreadRenameRequest]) =>
    renameCodexThread(args[0], event.sender)
  );

  handle("archive_codex_thread", async (event, args: [CodexThreadArchiveRequest]) =>
    archiveCodexThread(args[0], event.sender)
  );

  handle("delete_codex_thread", async (event, args: [string]) =>
    deleteCodexThread(args[0], event.sender)
  );

  handle("get_codex_thread_goal", async (event, args: [string]) =>
    getCodexThreadGoal(args[0], event.sender)
  );

  handle("set_codex_thread_goal", async (event, args: [CodexThreadGoalSetRequest]) =>
    setCodexThreadGoal(args[0], event.sender)
  );

  handle("clear_codex_thread_goal", async (event, args: [string]) =>
    clearCodexThreadGoal(args[0], event.sender)
  );

  handle("compact_codex_thread", async (event, args: [string]) =>
    compactCodexThread(args[0], event.sender)
  );

  handle("list_codex_mcp_servers", async (event) =>
    listCodexMcpServers(event.sender)
  );

  handle("read_codex_mcp_resource", async (event, args: [CodexMcpResourceReadRequest]) =>
    readCodexMcpResource(args[0], event.sender)
  );

  handle("start_codex_mcp_oauth", async (event, args: [CodexMcpOauthRequest]) =>
    startCodexMcpOauth(args[0], event.sender)
  );

  handle("reload_codex_mcp_servers", async (event) =>
    reloadCodexMcpServers(event.sender)
  );

  handle("read_codex_config", async (event, args: [string | null | undefined]) =>
    readCodexConfig(args[0], event.sender)
  );

  handle("write_codex_config_value", async (event, args: [CodexConfigWriteRequest]) =>
    writeCodexConfigValue(args[0], event.sender)
  );

  handle("batch_write_codex_config", async (event, args: [CodexConfigBatchWriteRequest]) =>
    batchWriteCodexConfig(args[0], event.sender)
  );

  handle("list_codex_features", async (event) =>
    listCodexFeatures(event.sender)
  );

  handle("set_codex_feature", async (event, args: [CodexFeatureSetRequest]) =>
    setCodexFeature(args[0], event.sender)
  );

  handle("list_codex_skills", async (event, args: [CodexSkillsListRequest | undefined]) =>
    listCodexSkills(args[0] ?? {}, event.sender)
  );

  handle("set_codex_skill_enabled", async (event, args: [CodexSkillEnabledRequest]) =>
    setCodexSkillEnabled(args[0], event.sender)
  );

  handle("set_codex_skills_extra_roots", async (event, args: [string[]]) =>
    setCodexSkillsExtraRoots(Array.isArray(args[0]) ? args[0] : [], event.sender)
  );

  handle("get_codex_approval_mode", async (_event, args: [string]) =>
    getCodexApprovalMode(args[0] ?? "")
  );

  handle("list_codex_permission_profiles", async (event, args: [string]) =>
    listCodexPermissionProfiles(args[0] ?? "", event.sender)
  );

  handle("list_opencode_config_options", async (_event, args: [string]) =>
    listOpenCodeConfigOptions(args[0] ?? "")
  );

  handle("list_mimo_config_options", async (_event, args: [string]) =>
    listMimoConfigOptions(args[0] ?? "")
  );

  handle("publish_ai_run_settings", async (_event, args: [unknown]) => {
    getDesktopCloudSync()?.publishRunSettings(args[0] as any);
  });

  handle("stop_ai_chat", async (_event, args: [string]) => {
    const aiSessionId = args[0];
    if (stopPipelineChat(aiSessionId)) return true;
    if (stopChatroomTurn(aiSessionId)) return true;
    if (await stopCodexChat(aiSessionId)) return true;
    return stopOpenCodeChat(aiSessionId)
      || stopMimoChat(aiSessionId)
      || stopAiChat(aiSessionId);
  });

  handle("has_live_ai_chat", async () =>
    hasLivePipelineChat() || hasLiveChatroom() || hasLiveCodexChat() || hasLiveOpenCodeChat() || hasLiveMimoChat() || hasLiveAiChat()
  );

  const respondAiApproval = async (req: CodexApprovalResponseRequest) => {
    const codexHandled = respondCodexApproval(req.aiSessionId, req.approvalId, req.decision, req.scope);
    return codexHandled || await respondMimoApproval(req.aiSessionId, req.approvalId, req.decision);
  };

  handle("respond_ai_approval", async (_event, args: [CodexApprovalResponseRequest]) => {
    const req = args[0];
    return respondAiApproval(req);
  });

  // Compatibility for renderers that still use the previous Codex-only IPC name.
  handle("respond_codex_approval", async (_event, args: [CodexApprovalResponseRequest]) => {
    const req = args[0];
    return respondAiApproval(req);
  });

  handle("respond_codex_user_input", async (_event, args: [CodexUserInputResponseRequest]) => {
    const req = args[0];
    return respondCodexUserInput(req.aiSessionId, req.requestId, req.answers);
  });

  // Simplified warmup: return the current session record. (Full pre-warm of
  // the provider subprocess is handled lazily on the first chat turn.)
  handle("warmup_ai_session", async (_event, args: [string]) =>
    db.getLocalAiSession(args[0])
  );

  handle("warmup_codex_session", async (_event, args: [string]) =>
    db.getLocalAiSession(args[0])
  );

  // ---------- AI history ----------

  handle("list_local_ai_history", async (_event, args: [string]) => {
    const synced = await syncCodexHistoryMirror(args[0]);
    if (synced) {
      getDesktopCloudSync()?.pushSessionSnapshot();
      getSender().send("ai-history-changed", { aiSessionId: args[0] });
    }
    return db.listLocalAiHistory(args[0]);
  });

  handle("get_local_ai_trace", async (_event, args: [string, string | undefined]) =>
    db.getLocalAiTrace(args[0], args[1] ?? "codex")
  );

  handle("list_local_ai_sessions", async () => db.listLocalAiSessions());

  handle("list_provider_sessions", async (event) => listProviderSessions(event.sender));

  handle("attach_provider_session", async (_event, args: [ProviderSessionCatalogEntry]) => {
    const session = attachProviderSession(args[0]);
    getDesktopCloudSync()?.pushSessionSnapshot();
    return session;
  });

  handle("archive_local_ai_session", async (event, args: [string, boolean]) => {
    const [aiSessionId, archived] = args;
    const current = db.getLocalAiSession(aiSessionId);
    const threadId = current?.providerId === "codex" ? codexThreadId(current.providerSessionId) : null;
    if (threadId) await archiveCodexThread({ threadId, archived }, event.sender);
    const session = db.archiveLocalAiSession(aiSessionId, archived);
    getDesktopCloudSync()?.pushSessionSnapshot();
    return session;
  });

  handle("delete_local_ai_session", async (event, args: [string]) => {
    const aiSessionId = args[0];
    const current = db.getLocalAiSession(aiSessionId);
    if (!current) return false;
    await stopCodexChat(aiSessionId);
    const threadId = current.providerId === "codex" ? codexThreadId(current.providerSessionId) : null;
    if (threadId) await deleteCodexThread(threadId, event.sender);
    const deleted = db.deleteLocalAiSession(aiSessionId);
    if (deleted) {
      getDesktopCloudSync()?.pushSessionSnapshot();
      getSender().send("ai-history-changed", { aiSessionId });
    }
    return deleted;
  });

  handle("rename_local_ai_session", async (_event, args: [string, string]) =>
    db.updateLocalAiSession(args[0], { title: args[1] })
  );

  // Desktop sessions are authoritative locally; the sync layer immediately
  // publishes the updated session snapshot to the backend and mobile clients.
  handle("rename_ai_session", async (_event, args: [string, string]) => {
    const [aiSessionId, title] = args;
    const sync = getDesktopCloudSync();
    if (sync) {
      await sync.renameAiSession(aiSessionId, title);
    } else {
      // Sync not initialized — at least persist locally.
      db.updateLocalAiSession(aiSessionId, { title });
    }
  });

  // Multi-window sessions are not supported in the current Electron build;
  // no-op for now.
  handle("open_session_in_new_window", async () => {
    /* no-op */
  });

  // ---------- desktop runtime ----------

  handle("get_desktop_runtime_info", async () => ({
    platform: process.platform,
    arch: process.arch,
  }));

  // ---------- app update ----------

  handle("get_app_version", async () => app.getVersion());

  handle("check_server_app_update", async () => fetchDesktopAppRelease(app.getVersion()));

  handle("get_update_download_size", async (_event, args) => {
    const [url] = args as [string];
    if (typeof url !== "string" || !url.trim()) return null;
    return getUpdateDownloadSize(url);
  });

  handle("check_app_update", async () => checkAppUpdate());

  handle("install_app_update", async () => installAppUpdate());
}
