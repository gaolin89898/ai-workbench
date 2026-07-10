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

import { app, ipcMain, BrowserWindow, clipboard, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import * as db from "./db";
import * as pty from "./pty";
import * as providers from "./providers";
import * as projects from "./projects";
import {
  loginDesktop,
  logoutDesktop,
  getCloudConfig,
  getDesktopCloudSync,
  fetchTokenUsageSummary,
  fetchDesktopAppRelease,
} from "./sync";
import { saveCredentials, loadCredentials, clearCredentials } from "./credentials";
import { getCodexApprovalMode, hasLiveCodexChat, listCodexModels, respondCodexApproval, runCodexChat, steerCodexChat, stopCodexChat } from "./codex";
import {
  batchWriteCodexConfig,
  listCodexFeatures,
  listCodexMcpServers,
  listCodexThreads,
  readCodexConfig,
  readCodexMcpResource,
  readCodexThread,
  reloadCodexMcpServers,
  renameCodexThread,
  setCodexFeature,
  startCodexMcpOauth,
  writeCodexConfigValue,
} from "./codex_admin";
import { syncCodexHistoryMirror } from "./codex_sessions";
import { hasLiveAiChat, runAiChat, stopAiChat } from "./claude";
import { hasLiveOpenCodeChat, listOpenCodeConfigOptions, runOpenCodeChat, stopOpenCodeChat } from "./acp";
import { hasLiveMimoChat, listMimoConfigOptions, respondMimoApproval, runMimoChat, stopMimoChat } from "./mimo";
import { checkAppUpdate, getUpdateDownloadSize, installAppUpdate, initUpdater } from "./updater";
import { listProjectFiles, readProjectFileForViewer, readProjectFilePreview } from "./project_files";
import type {
  CreateAiSessionRequest,
  StartShellPtyRequest,
  ShellInputRequest,
  ResizeShellRequest,
  RunAiChatRequest,
  RunCodexChatRequest,
  SteerCodexChatRequest,
  CodexApprovalResponseRequest,
  CodexConfigBatchWriteRequest,
  CodexConfigWriteRequest,
  CodexFeatureSetRequest,
  CodexMcpOauthRequest,
  CodexMcpResourceReadRequest,
  CodexThreadListRequest,
  CodexThreadReadRequest,
  CodexThreadRenameRequest,
  ChatMessage,
} from "../services/desktop";

let mainWindow: BrowserWindow | null = null;

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

  handle("login_desktop", async (_event, args: [string, string, string]) =>
    loginDesktop(args[0], args[1], args[2])
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

  handle("get_token_usage_summary", async () => fetchTokenUsageSummary());

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

  handle("get_project_environment", async (_event, args: [string]) =>
    projects.readProjectEnvironment(args[0])
  );

  handle("list_project_files", async (_event, args: [string, string | null]) =>
    listProjectFiles(args[0], args[1])
  );

  handle("read_project_file_preview", async (_event, args: [string, string]) =>
    readProjectFilePreview(args[0], args[1])
  );

  handle("read_project_file_for_viewer", async (_event, args: [string, string]) =>
    readProjectFileForViewer(args[0], args[1])
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
      summary: sessionProjectPath,
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
      summary: null,
    })
  );

  handle(
    "append_local_ai_message",
    async (_event, args: [string, ChatMessage["role"], string]) => {
      const [aiSessionId, role, content] = args;
      db.appendLocalAiMessage(aiSessionId, role, content);
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

  handle("get_codex_approval_mode", async (_event, args: [string]) =>
    getCodexApprovalMode(args[0] ?? "")
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
    if (await stopCodexChat(aiSessionId)) return true;
    return stopOpenCodeChat(aiSessionId)
      || stopMimoChat(aiSessionId)
      || stopAiChat(aiSessionId);
  });

  handle("has_live_ai_chat", async () =>
    hasLiveCodexChat() || hasLiveOpenCodeChat() || hasLiveMimoChat() || hasLiveAiChat()
  );

  const respondAiApproval = async (req: CodexApprovalResponseRequest) => {
    const codexHandled = respondCodexApproval(req.aiSessionId, req.approvalId, req.decision);
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

  handle("archive_local_ai_session", async (_event, args: [string, boolean]) =>
    db.archiveLocalAiSession(args[0], args[1])
  );

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
