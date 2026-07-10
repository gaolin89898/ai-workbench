// Project / Git helpers for the Electron main process.
// Handles folder selection dialogs, git status reading, and opening
// a project in the host file manager.

import { BrowserWindow, dialog, shell } from "electron";
import simpleGit from "simple-git";
import path from "node:path";
import { spawn } from "node:child_process";

// Select a folder via the native open dialog. Returns the chosen path or null.
export async function chooseWorkspaceProjectPath(parent?: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    properties: ["openDirectory"],
    title: "选择项目目录",
  };
  const result = parent && !parent.isDestroyed()
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

// Read git status for a project path. Returns branch / dirty flag / changed
// file list. Non-repo or failure yields a safe empty state.
export async function readGitStatus(projectPath: string): Promise<{
  branch: string | null;
  dirty: boolean;
  files: string[];
}> {
  try {
    const git = simpleGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return { branch: null, dirty: false, files: [] };
    const branch = await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => null);
    const status = await git.status();
    const files = status.files.map((f) => f.path);
    const dirty = files.length > 0;
    return { branch: branch?.trim() || null, dirty, files };
  } catch {
    return { branch: null, dirty: false, files: [] };
  }
}

function parseNumstat(output: string): { additions: number; deletions: number } {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((total, line) => {
      const [additions, deletions] = line.split(/\s+/, 3);
      const added = Number(additions);
      const deleted = Number(deletions);
      return {
        additions: total.additions + (Number.isFinite(added) ? added : 0),
        deletions: total.deletions + (Number.isFinite(deleted) ? deleted : 0),
      };
    }, { additions: 0, deletions: 0 });
}

async function readGitLineSummary(projectPath: string): Promise<{ additions: number; deletions: number }> {
  try {
    const git = simpleGit(projectPath);
    const [worktree, staged] = await Promise.all([
      git.raw(["diff", "--numstat"]),
      git.raw(["diff", "--cached", "--numstat"]),
    ]);
    const worktreeSummary = parseNumstat(worktree);
    const stagedSummary = parseNumstat(staged);
    return {
      additions: worktreeSummary.additions + stagedSummary.additions,
      deletions: worktreeSummary.deletions + stagedSummary.deletions,
    };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

function commandAvailable(command: string, args: string[] = ["--version"], timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.once("error", () => {
      finish(false);
    });
    child.once("exit", (code) => {
      finish(code === 0);
    });
  });
}

export async function readProjectEnvironment(projectPath: string): Promise<{
  projectPath: string;
  branch: string | null;
  dirty: boolean;
  changedFiles: number;
  additions: number;
  deletions: number;
  githubCliAvailable: boolean;
}> {
  const [status, lineSummary, githubCliAvailable] = await Promise.all([
    readGitStatus(projectPath),
    readGitLineSummary(projectPath),
    commandAvailable("gh"),
  ]);
  return {
    projectPath,
    branch: status.branch,
    dirty: status.dirty,
    changedFiles: status.files.length,
    additions: lineSummary.additions,
    deletions: lineSummary.deletions,
    githubCliAvailable,
  };
}

// Open a project path in the host file manager.
export async function openProjectInFileManager(projectPath: string): Promise<void> {
  await shell.openPath(projectPath);
}

// Derive a human-friendly project name from its path.
export function deriveProjectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}
