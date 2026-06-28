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

import { ipcMain, BrowserWindow, clipboard, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import * as db from "./db";
import * as pty from "./pty";
import * as providers from "./providers";
import * as projects from "./projects";
import {
  loginDesktop,
  pairDesktop,
  createDesktopPairingRequest,
  getDesktopPairingStatus,
  buildDesktopPairingQrPayload,
  getCloudConfig,
  getDesktopCloudSync,
} from "./sync";
import { runCodexChat, stopCodexChat } from "./codex";
import { runAiChat, stopAiChat } from "./claude";
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
  const visibleEntries = entries.filter((entry) => entry.name !== ".git" && !entry.name.startsWith("."));
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
  ipcMain.handle("list_sessions", async () => []);

  // ---------- cloud pairing ----------

  ipcMain.handle("login_desktop", async (_event, args: [string, string, string]) =>
    loginDesktop(args[0], args[1], args[2])
  );

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

  ipcMain.handle("read_clipboard_image", async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    return {
      name: "截图",
      mimeType: "image/png",
      dataUrl: image.toDataURL(),
    };
  });

  // ---------- AI providers ----------

  ipcMain.handle("list_ai_providers", async () => providers.listAiProviders());

  ipcMain.handle("detect_ai_providers", async () => providers.detectAiProviders());

  // ---------- workspace projects ----------

  ipcMain.handle("add_workspace_project", async (_event, args: [string]) => {
    const project = await db.addWorkspaceProject(args[0]);
    getSender().send("workspace-changed");
    getDesktopCloudSync()?.pushProjectSnapshot();
    return project;
  });

  ipcMain.handle("choose_workspace_project", async () => {
    const projectPath = await projects.chooseWorkspaceProjectPath(mainWindow);
    if (!projectPath) return null;
    const project = await db.addWorkspaceProject(projectPath);
    getSender().send("workspace-changed");
    getDesktopCloudSync()?.pushProjectSnapshot();
    return project;
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

  ipcMain.handle("list_project_files", async (_event, args: [string, string | null]) =>
    listProjectFiles(args[0], args[1])
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

    const session = db.createLocalAiSession({
      id,
      providerId: req.providerId,
      terminalSessionId: req.terminalSessionId ?? null,
      title: req.title,
      status: "idle",
      summary: req.projectPath || null,
    });

    // Immediately push the updated session list to the cloud so mobile clients
    // see the new session without waiting for the next 10s snapshot tick.
    getDesktopCloudSync()?.pushSessionSnapshot();

    return session;
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
    const providerSessionId = await runAiChat(req, sender, existingSessionId);
    db.updateLocalAiSession(req.aiSessionId, {
      providerSessionId: providerSessionId || existingSessionId,
      status: "completed",
    });
    return providerSessionId;
  });

  ipcMain.handle("run_codex_chat", async (_event, args: [RunCodexChatRequest]) => {
    const req = args[0];
    const session = db.getLocalAiSession(req.aiSessionId);
    const existingSessionId = session?.providerSessionId ?? null;
    const providerSessionId = await runCodexChat(req, getSender());
    db.updateLocalAiSession(req.aiSessionId, {
      providerSessionId: providerSessionId || existingSessionId,
      status: "completed",
    });
    return providerSessionId;
  });

  ipcMain.handle("stop_ai_chat", async (_event, args: [string]) => {
    const aiSessionId = args[0];
    return stopCodexChat(aiSessionId) || stopAiChat(aiSessionId);
  });

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
