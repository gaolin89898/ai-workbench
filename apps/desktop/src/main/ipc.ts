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

import { ipcMain, BrowserWindow, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import * as db from "./db";
import * as pty from "./pty";
import * as providers from "./providers";
import * as projects from "./projects";
import {
  pairDesktop,
  createDesktopPairingRequest,
  getDesktopPairingStatus,
  buildDesktopPairingQrPayload,
  getCloudConfig,
} from "./sync";
import { runCodexChat } from "./codex";
import { runAiChat } from "./claude";
import { checkAppUpdate, installAppUpdate, initUpdater } from "./updater";
import type {
  CreateAiSessionRequest,
  StartShellPtyRequest,
  ShellInputRequest,
  ResizeShellRequest,
  RunAiChatRequest,
  RunCodexChatRequest,
  ChatMessage,
} from "../services/desktop";

let mainWindow: BrowserWindow | null = null;

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
  ipcMain.handle("list_sessions", async () => []);

  // ---------- cloud pairing ----------

  ipcMain.handle("pair_desktop", async (_event, args: [string, string]) =>
    pairDesktop(args[0], args[1])
  );

  ipcMain.handle("create_desktop_pairing_request", async (_event, args: [string]) =>
    createDesktopPairingRequest(args[0])
  );

  ipcMain.handle("get_desktop_pairing_status", async (_event, args: [string, string]) =>
    getDesktopPairingStatus(args[0], args[1])
  );

  ipcMain.handle("build_desktop_pairing_qr_payload", async (_event, args: [string, string]) =>
    buildDesktopPairingQrPayload(args[0], args[1])
  );

  ipcMain.handle("get_cloud_config", async () => getCloudConfig());

  // ---------- AI providers ----------

  ipcMain.handle("list_ai_providers", async () => providers.listAiProviders());

  ipcMain.handle("detect_ai_providers", async () => providers.detectAiProviders());

  // ---------- workspace projects ----------

  ipcMain.handle("add_workspace_project", async (_event, args: [string]) =>
    db.addWorkspaceProject(args[0])
  );

  ipcMain.handle("choose_workspace_project", async () => {
    const projectPath = await projects.chooseWorkspaceProjectPath();
    if (!projectPath) return null;
    return db.addWorkspaceProject(projectPath);
  });

  ipcMain.handle("list_workspace_projects", async () => db.listWorkspaceProjects());

  ipcMain.handle("rename_workspace_project", async (_event, args: [string, string]) =>
    db.renameWorkspaceProject(args[0], args[1])
  );

  ipcMain.handle("remove_workspace_project", async (_event, args: [string]) => {
    db.removeWorkspaceProject(args[0]);
  });

  ipcMain.handle("open_project_in_file_manager", async (_event, args: [string]) =>
    projects.openProjectInFileManager(args[0])
  );

  // ---------- AI sessions ----------

  ipcMain.handle("create_ai_session", async (_event, args: [CreateAiSessionRequest]) => {
    const req = args[0];
    const id = randomUUID();

    // Best-effort: register the workspace project so it appears in lists.
    if (req.projectPath) {
      try {
        if (!db.getWorkspaceProjectByPath(req.projectPath)) {
          await db.addWorkspaceProject(req.projectPath);
        }
      } catch {
        // project may not exist or git may be unavailable — ignore
      }
    }

    return db.createLocalAiSession({
      id,
      providerId: req.providerId,
      terminalSessionId: req.terminalSessionId ?? null,
      title: req.title,
      status: "idle",
    });
  });

  ipcMain.handle("restart_ai_session", async (_event, args: [string]) =>
    db.updateLocalAiSession(args[0], {
      status: "idle",
      providerSessionId: null,
      summary: null,
    })
  );

  ipcMain.handle(
    "append_local_ai_message",
    async (_event, args: [string, ChatMessage["role"], string]) =>
      db.appendLocalAiMessage(args[0], args[1], args[2])
  );

  // ---------- shell PTY ----------

  ipcMain.handle("start_shell_pty", async (_event, args: [StartShellPtyRequest]) => {
    pty.startShellPty(args[0], getSender());
  });

  ipcMain.handle("send_shell_input", async (_event, args: [ShellInputRequest]) => {
    pty.sendShellInput(args[0]);
  });

  ipcMain.handle("resize_shell", async (_event, args: [ResizeShellRequest]) => {
    pty.resizeShell(args[0]);
  });

  ipcMain.handle("get_shell_buffer", async (_event, args: [string]) =>
    pty.getShellBuffer(args[0])
  );

  ipcMain.handle("stop_shell_pty", async (_event, args: [string]) => {
    pty.stopShellPty(args[0]);
  });

  ipcMain.handle("is_shell_live", async (_event, args: [string]) =>
    pty.isShellLive(args[0])
  );

  // ---------- AI chat ----------

  ipcMain.handle("run_ai_chat", async (_event, args: [RunAiChatRequest]) => {
    const req = args[0];
    const sender = getSender();
    // Resume an existing Claude session if we have a providerSessionId stored.
    const session = db.getLocalAiSession(req.aiSessionId);
    const existingSessionId = session?.providerSessionId ?? null;
    return runAiChat(req, sender, existingSessionId);
  });

  ipcMain.handle("run_codex_chat", async (_event, args: [RunCodexChatRequest]) =>
    runCodexChat(args[0], getSender())
  );

  // Simplified warmup: return the current session record. (Full pre-warm of
  // the provider subprocess is handled lazily on the first chat turn.)
  ipcMain.handle("warmup_ai_session", async (_event, args: [string]) =>
    db.getLocalAiSession(args[0])
  );

  ipcMain.handle("warmup_codex_session", async (_event, args: [string]) =>
    db.getLocalAiSession(args[0])
  );

  // ---------- AI history ----------

  ipcMain.handle("list_local_ai_history", async (_event, args: [string]) =>
    db.listLocalAiHistory(args[0])
  );

  ipcMain.handle("list_local_ai_sessions", async () => db.listLocalAiSessions());

  ipcMain.handle("archive_local_ai_session", async (_event, args: [string, boolean]) =>
    db.archiveLocalAiSession(args[0], args[1])
  );

  ipcMain.handle("rename_local_ai_session", async (_event, args: [string, string]) =>
    db.updateLocalAiSession(args[0], { title: args[1] })
  );

  // Multi-window sessions are not supported in the current Electron build;
  // no-op for now.
  ipcMain.handle("open_session_in_new_window", async () => {
    /* no-op */
  });

  // ---------- app update ----------

  ipcMain.handle("check_app_update", async () => checkAppUpdate());

  ipcMain.handle("install_app_update", async () => installAppUpdate());
}
