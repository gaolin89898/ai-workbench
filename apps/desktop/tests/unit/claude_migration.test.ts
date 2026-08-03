import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanClaudeConfig } from "../../src/main/claude_migration";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-migration-test-"));
  process.env.CLAUDE_CONFIG_DIR = tempDir;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
});

function write(file: string, content: string): void {
  const fullPath = path.join(tempDir, file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

describe("scanClaudeConfig", () => {
  it("reports missing config directory", () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    const overview = scanClaudeConfig();
    expect(overview.exists).toBe(false);
    expect(overview.mcps).toHaveLength(0);
  });

  it("strips credentials from env and records them as skipped", () => {
    write("settings.json", JSON.stringify({
      env: {
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_AUTH_TOKEN: "sk-c6087d6e69fb4499b4d0a9539e89ba8f",
        ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
        SOME_API_KEY: "abcdef1234567890abcdef1234567890",
      },
    }));
    const overview = scanClaudeConfig();
    expect(overview.exists).toBe(true);
    expect(overview.settings.model).toBe("deepseek-v4-pro");
    // 只有非敏感键进入 envModelKeys
    const keys = overview.settings.envModelKeys.map((item) => item.key);
    expect(keys).toContain("ANTHROPIC_MODEL");
    expect(keys).toContain("ANTHROPIC_BASE_URL");
    expect(keys).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(keys).not.toContain("SOME_API_KEY");
    // 敏感键被记录，且任何键值都不包含 token 内容
    expect(overview.skippedSecrets).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(overview.skippedSecrets).toContain("SOME_API_KEY");
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain("c6087d6e");
    expect(serialized).not.toContain("abcdef1234567890");
  });

  it("skips mcp servers whose command looks like a secret", () => {
    write("mcp.json", JSON.stringify({
      mcpServers: {
        pencil: { type: "stdio", command: "npx", args: ["-y", "@pencil/ts"] },
        evil: { type: "stdio", command: "sk-fake-token-value-here" },
      },
    }));
    const overview = scanClaudeConfig();
    expect(overview.mcps.map((mcp) => mcp.name)).toEqual(["pencil"]);
    expect(overview.mcps[0].command).toBe("npx");
    expect(overview.skippedSecrets).toContain("evil");
  });

  it("lists skills and commands and counts history files", () => {
    write("skills/code-review.md", "# Code Review\n审查代码质量。");
    write("commands/explain.md", "# Explain\n解释当前选区。");
    write("projects/C--repo/session-1.jsonl", "{}");
    write("projects/C--repo/session-2.jsonl", "{}");
    write("projects/C--repo/notes.txt", "not a session");

    const overview = scanClaudeConfig();
    expect(overview.skills.map((skill) => skill.name)).toEqual(["code-review"]);
    expect(overview.commands.map((command) => command.name)).toEqual(["explain"]);
    expect(overview.history.sessionFiles).toBe(2);
    expect(overview.history.totalBytes).toBeGreaterThan(0);
    expect(overview.history.lastModifiedAt).not.toBeNull();
  });

  it("parses permissions allow/deny lists", () => {
    write("settings.json", JSON.stringify({
      permissions: {
        allow: ["Bash(git status:*)", "Read(*)"],
        deny: ["Write(/etc/*)"],
      },
    }));
    const overview = scanClaudeConfig();
    expect(overview.settings.permissionsAllow).toContain("Bash(git status:*)");
    expect(overview.settings.permissionsDeny).toEqual(["Write(/etc/*)"]);
  });
});
