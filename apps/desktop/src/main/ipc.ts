// IPC handler registration for the Electron main process.
// Registers ipcMain.handle listeners for every channel exposed by the preload
// bridge (window.desktop.ipc.<channel>(...args)).
//
// Arg passing contract: the preload proxy calls
//   ipcRenderer.invoke(channel, args)
// where `args` is the array of frontend arguments. So every handler receives
// a single `args` array as the second parameter (after the IpcMainInvokeEvent).
// Example: window.desktop.ipc.pairDesktop("http://...", "ABC123") ->
//   ipcMain.handle("pair_desktop", (_event, args) => { const [server, code] = args; ... })

import { app, ipcMain, BrowserWindow, clipboard, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import * as db from "./db";
import * as pty from "./pty";
import * as providers from "./providers";
import * as projects from "./projects";
import {
  loginDesktop,
  logoutDesktop,
  saveOAuthLogin,
  pairDesktop,
  createDesktopPairingRequest,
  getDesktopPairingStatus,
  buildDesktopPairingQrPayload,
  getCloudConfig,
  getDesktopCloudSync,
  fetchTokenUsageSummary,
} from "./sync";
import { saveCredentials, loadCredentials, clearCredentials } from "./credentials";
import { respondCodexApproval, runCodexChat, stopCodexChat } from "./codex";
import { syncCodexHistoryMirror } from "./codex_sessions";
import { runAiChat, stopAiChat } from "./claude";
import { checkAppUpdate, installAppUpdate, initUpdater } from "./updater";
import type {
  CreateAiSessionRequest,
  StartShellPtyRequest,
  ShellInputRequest,
  ResizeShellRequest,
  RunAiChatRequest,
  RunCodexChatRequest,
  CodexApprovalResponseRequest,
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

async function listProjectFiles(projectPath: string, directoryPath?: string | null) {
  const project = db.getWorkspaceProjectByPath(projectPath);
  if (!project) throw new Error("project is not registered");
  const root = path.resolve(project.path);
  const target = directoryPath ? path.resolve(directoryPath) : root;
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("directory is outside project");
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) throw new Error("target is not a directory");
  const entries = await readdir(target, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => entry.name !== ".git");
  const files = await Promise.all(
    visibleEntries.map(async (entry) => {
      const fullPath = path.join(target, entry.name);
      const info = await stat(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        kind: entry.isDirectory() ? "directory" : "file",
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      };
    })
  );
  return files.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });
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

  // OAuth 登录完成后，前端把 token/userId 传过来保存
  handle("save_oauth_login", async (_event, args: [string, string, string, string]) => {
    const [serverUrl, accessToken, userId, displayName] = args;
    await saveOAuthLogin(serverUrl, accessToken, userId, displayName);
  });

  // 在系统默认浏览器中打开 URL（用于 OAuth 授权跳转，避免 BrowserWindow 限制）
  handle("open_external_url", async (_event, args: [string]) => {
    const url = args[0];
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  handle("pair_desktop", async (_event, args: [string, string]) =>
    pairDesktop(args[0], args[1])
  );

  handle("create_desktop_pairing_request", async (_event, args: [string]) =>
    createDesktopPairingRequest(args[0])
  );

  handle("get_desktop_pairing_status", async (_event, args: [string, string]) =>
    getDesktopPairingStatus(args[0], args[1])
  );

  handle("build_desktop_pairing_qr_payload", async (_event, args: [string, string]) =>
    buildDesktopPairingQrPayload(args[0], args[1])
  );

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

  handle("list_project_files", async (_event, args: [string, string | null]) =>
    listProjectFiles(args[0], args[1])
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
      void getDesktopCloudSync()?.pushAiHistory(aiSessionId);
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
    const sender = getDesktopCloudSync()?.createRendererAndMobileAiChatSender(getSender()) ?? getSender();
    // Resume an existing Claude session if we have a providerSessionId stored.
    const session = db.getLocalAiSession(req.aiSessionId);
    const existingSessionId = session?.providerSessionId ?? null;
    const providerSessionId = await runAiChat(req, sender, existingSessionId);
    db.updateLocalAiSession(req.aiSessionId, {
      providerSessionId: providerSessionId || existingSessionId,
      status: "completed",
    });
    return providerSessionId;
  });

  handle("run_codex_chat", async (_event, args: [RunCodexChatRequest]) => {
    const req = args[0];
    const session = db.getLocalAiSession(req.aiSessionId);
    const existingSessionId = session?.providerSessionId ?? null;
    const sender = getDesktopCloudSync()?.createRendererAndMobileAiChatSender(getSender()) ?? getSender();
    const providerSessionId = await runCodexChat(req, sender);
    db.updateLocalAiSession(req.aiSessionId, {
      providerSessionId: providerSessionId || existingSessionId,
      status: "completed",
    });
    return providerSessionId;
  });

  handle("stop_ai_chat", async (_event, args: [string]) => {
    const aiSessionId = args[0];
    return stopCodexChat(aiSessionId) || stopAiChat(aiSessionId);
  });

  handle("respond_codex_approval", async (_event, args: [CodexApprovalResponseRequest]) => {
    const req = args[0];
    return respondCodexApproval(req.aiSessionId, req.approvalId, req.decision);
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

  // Rename a session everywhere: local SQLite + backend PATCH (which also
  // forwards ai.session.rename to other clients over WS).
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

  handle("check_app_update", async () => checkAppUpdate());

  handle("install_app_update", async () => installAppUpdate());
}
