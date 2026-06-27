// Project / Git helpers for the Electron main process.
// Handles folder selection dialogs, git status reading, and opening
// a project in the host file manager.

import { dialog, shell } from "electron";
import simpleGit from "simple-git";
import path from "node:path";

// Select a folder via the native open dialog. Returns the chosen path or null.
export async function chooseWorkspaceProjectPath(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "选择项目目录",
  });
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

// Open a project path in the host file manager.
export async function openProjectInFileManager(projectPath: string): Promise<void> {
  await shell.openPath(projectPath);
}

// Derive a human-friendly project name from its path.
export function deriveProjectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}
