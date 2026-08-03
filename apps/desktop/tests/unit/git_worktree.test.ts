import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import {
  defaultWorktreeDir,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
} from "../../src/main/git_worktree";

let repoDir: string;

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# demo\n");
  await git.add(".");
  await git.commit("init");
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe("git worktree isolation", () => {
  it("creates an isolated worktree on a new branch", async () => {
    const result = await gitWorktreeAdd(repoDir, "feature/login");
    expect(result.branch).toBe("feature/login");
    expect(fs.existsSync(result.path)).toBe(true);
    // 新 worktree 内是独立工作目录，带 README
    expect(fs.existsSync(path.join(result.path, "README.md"))).toBe(true);
  });

  it("lists the main worktree and the new one", async () => {
    await gitWorktreeAdd(repoDir, "task/fix-bug");
    const entries = await gitWorktreeList(repoDir);
    expect(entries.length).toBe(2);
    const main = entries.find((entry) => entry.main);
    const added = entries.find((entry) => !entry.main);
    expect(path.normalize(main?.path ?? "")).toBe(path.resolve(repoDir));
    expect(added?.branch).toBe("task/fix-bug");
    expect(added?.head).toBeTruthy();
  });

  it("removes an isolated worktree", async () => {
    const { path: worktreePath } = await gitWorktreeAdd(repoDir, "task/cleanup");
    expect(fs.existsSync(worktreePath)).toBe(true);

    await gitWorktreeRemove(repoDir, worktreePath);
    expect(fs.existsSync(worktreePath)).toBe(false);
    const entries = await gitWorktreeList(repoDir);
    expect(entries.length).toBe(1);
    expect(entries[0].main).toBe(true);
  });

  it("sanitizes illegal branch names", async () => {
    const result = await gitWorktreeAdd(repoDir, "bad name!!");
    expect(result.branch).toBe("bad-name--");
    const entries = await gitWorktreeList(repoDir);
    expect(entries.some((entry) => entry.branch === "bad-name--")).toBe(true);
  });

  it("computes the default worktree dir next to the repo", () => {
    const dir = defaultWorktreeDir(repoDir);
    expect(dir).toContain(".ai-workbench-worktrees");
    expect(dir).toContain(path.basename(repoDir));
  });

  it("rejects non-repository paths", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain-dir-"));
    try {
      await expect(gitWorktreeAdd(plain, "feature/x")).rejects.toThrow("Git 仓库");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
