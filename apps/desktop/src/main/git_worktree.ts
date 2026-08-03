// Git Worktree 任务隔离：为 AI 任务创建/列出/清理隔离工作区。
// 纯 git + fs 实现，不依赖 Electron，可独立单元测试。
import path from "node:path";
import simpleGit from "simple-git";

export type GitWorktreeEntry = {
  path: string;
  branch: string;
  head: string | null;
  main: boolean;
};

// 隔离工作区默认放在项目同级的 .ai-workbench-worktrees/<项目名>/<分支>，
// 避免污染主工作树目录。
export function defaultWorktreeDir(projectPath: string): string {
  return path.join(path.dirname(path.resolve(projectPath)), ".ai-workbench-worktrees", path.basename(projectPath) || projectPath);
}

function sanitizeBranchName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._/-]/g, "-").replace(/^\/+|\/+$/g, "");
  return cleaned || "task";
}

// 为任务创建隔离工作区（git worktree add -b <branch> <path>）。
export async function gitWorktreeAdd(
  projectPath: string,
  branch: string,
  targetPath?: string,
): Promise<{ path: string; branch: string }> {
  const git = simpleGit(projectPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) throw new Error("该项目不是一个 Git 仓库");
  const branchName = sanitizeBranchName(branch);
  if (!branchName) throw new Error("分支名不能为空");
  const worktreePath = targetPath?.trim() || path.join(defaultWorktreeDir(projectPath), branchName);
  await git.raw(["worktree", "add", "-b", branchName, worktreePath]);
  return { path: worktreePath, branch: branchName };
}

// 列出仓库的全部 worktree（porcelain 格式解析）。
export async function gitWorktreeList(projectPath: string): Promise<GitWorktreeEntry[]> {
  const git = simpleGit(projectPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) throw new Error("该项目不是一个 Git 仓库");
  const output = await git.raw(["worktree", "list", "--porcelain"]);
  const entries: GitWorktreeEntry[] = [];
  let current: Partial<GitWorktreeEntry> | null = null;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("worktree ")) {
      if (current?.path) entries.push(current as GitWorktreeEntry);
      // porcelain 无显式标记，第一块始终是主工作树。
      current = { path: trimmed.slice("worktree ".length), branch: "", head: null, main: entries.length === 0 };
    } else if (trimmed.startsWith("HEAD ")) {
      if (current) current.head = trimmed.slice("HEAD ".length);
    } else if (trimmed.startsWith("branch ")) {
      if (current) current.branch = trimmed.slice("branch refs/heads/".length);
    }
  }
  if (current?.path) entries.push(current as GitWorktreeEntry);
  // 主工作树没有 branch 行，用当前分支补全。
  const currentBranch = (await git.branch()).current;
  return entries.map((entry) => ({
    path: entry.path,
    branch: entry.branch || (entry.main && currentBranch ? currentBranch : "(detached)"),
    head: entry.head ?? null,
    main: entry.main,
  }));
}

// 移除隔离工作区（脏工作区需 force）。
export async function gitWorktreeRemove(projectPath: string, worktreePath: string, force = false): Promise<boolean> {
  const git = simpleGit(projectPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) throw new Error("该项目不是一个 Git 仓库");
  if (!worktreePath.trim()) throw new Error("工作区路径不能为空");
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  await git.raw(args);
  return true;
}
