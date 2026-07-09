// PTY shell session management for the Electron main process.
// Mirrors the original Tauri Rust ShellPtySessionHandle: one node-pty per
// aiSessionId, with output streamed to the renderer via WebContents.send.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";
import type { WebContents } from "electron";
import type {
  StartShellPtyRequest,
  ShellInputRequest,
  ResizeShellRequest,
} from "../services/desktop";

// ---------- Types ----------

type ShellSessionStatus = "running" | "exited" | "failed";

interface ShellPtySession {
  pty: pty.IPty;
  buffer: string;
  status: ShellSessionStatus;
}

// ---------- Session map ----------

const sessions = new Map<string, ShellPtySession>();

function resolveShell(): string {
  return process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
}

function isDirectoryPath(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function normalizeCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(value);
}

function resolveShellCwd(cwd: string): { requestedCwd: string; resolvedCwd: string; fallbackUsed: boolean } {
  const requestedCwd = (cwd || "").trim();
  const normalized = requestedCwd ? normalizeCwd(requestedCwd) : "";
  if (normalized && isDirectoryPath(normalized)) {
    return { requestedCwd, resolvedCwd: normalized, fallbackUsed: false };
  }
  const fallbacks = [os.homedir(), process.cwd()].filter(isDirectoryPath);
  return {
    requestedCwd,
    resolvedCwd: fallbacks[0] ?? os.homedir(),
    fallbackUsed: true,
  };
}

function destroySession(aiSessionId: string, session: ShellPtySession): void {
  try {
    session.pty.kill();
  } catch {
    // already dead — ignore
  }
  sessions.delete(aiSessionId);
}

// ---------- Public API ----------

export function startShellPty(req: StartShellPtyRequest, sender: WebContents): void {
  const { aiSessionId, cwd } = req;

  // If a session already exists for this id, tear it down first.
  const existing = sessions.get(aiSessionId);
  if (existing) {
    destroySession(aiSessionId, existing);
  }

  const shell = resolveShell();
  const cwdInfo = resolveShellCwd(cwd);
  const proc = pty.spawn(shell, [], { cwd: cwdInfo.resolvedCwd, cols: 100, rows: 30 });

  const initialMessage = cwdInfo.fallbackUsed
    ? [
        `Requested shell cwd is unavailable: ${cwdInfo.requestedCwd || "<empty>"}`,
        `Using: ${cwdInfo.resolvedCwd}`,
        "",
      ].join("\r\n")
    : "";

  const session: ShellPtySession = {
    pty: proc,
    buffer: initialMessage,
    status: "running",
  };

  proc.onData((data) => {
    session.buffer += data;
    sender.send("shell-terminal-output", { aiSessionId, chunk: data });
  });

  proc.onExit(({ exitCode }) => {
    const status: ShellSessionStatus = exitCode === 0 ? "exited" : "failed";
    session.status = status;
    sender.send("shell-session-status", {
      aiSessionId,
      status,
      message: `exit code ${exitCode}`,
    });
  });

  sessions.set(aiSessionId, session);
  if (initialMessage) sender.send("shell-terminal-output", { aiSessionId, chunk: initialMessage });

  sender.send("shell-session-status", { aiSessionId, status: "running" });
}

export function sendShellInput(req: ShellInputRequest): void {
  const { aiSessionId, text, submit } = req;
  const session = sessions.get(aiSessionId);
  if (!session) {
    throw new Error(`shell session not found: ${aiSessionId}`);
  }
  const payload = submit ? text + "\r" : text;
  session.pty.write(payload);
}

export function resizeShell(req: ResizeShellRequest): void {
  const { aiSessionId, cols, rows } = req;
  const session = sessions.get(aiSessionId);
  if (!session) return;
  try {
    session.pty.resize(cols, rows);
  } catch {
    // ignore resize errors (e.g. process already exiting)
  }
}

export function stopShellPty(aiSessionId: string): void {
  const session = sessions.get(aiSessionId);
  if (!session) return;
  destroySession(aiSessionId, session);
}

export function isShellLive(aiSessionId: string): boolean {
  const session = sessions.get(aiSessionId);
  return !!session && session.status === "running";
}

export function getShellBuffer(aiSessionId: string): string {
  const session = sessions.get(aiSessionId);
  return session ? session.buffer : "";
}

export function disposeAll(): void {
  for (const [aiSessionId, session] of sessions) {
    destroySession(aiSessionId, session);
  }
}
