// Claude Code 配置迁移：扫描 ~/.claude/ 的非敏感配置并支持迁移到 Codex。
//
// 安全边界（AGENTS.md）：Provider 凭证与本地 CLI 认证状态仅存在于桌面端，
// 本模块绝不读取、展示或传输任何密钥。settings.json 的 env 段只提取
// 模型相关键，任何键名或值形似凭证的字段（token/key/secret/password 等）
// 一律丢弃。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type Sender = { send: (channel: string, ...args: unknown[]) => void };

// ---------- 类型 ----------

export type ClaudeMigrationOverview = {
  configDir: string;
  exists: boolean;
  settings: {
    model: string | null;
    permissionsAllow: string[];
    permissionsDeny: string[];
    envModelKeys: Array<{ key: string; value: string }>;
  };
  mcps: Array<{ name: string; type: string; command?: string; url?: string; enabled: boolean }>;
  skills: Array<{ name: string; path: string }>;
  commands: Array<{ name: string; path: string }>;
  history: { sessionFiles: number; totalBytes: number; lastModifiedAt: string | null };
  skippedSecrets: string[];
};

export type ClaudeMigrationResult = {
  migratedMcps: string[];
  failedMcps: Array<{ name: string; error: string }>;
};

// ---------- 工具 ----------

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function listMdFiles(dir: string): Array<{ name: string; path: string }> {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => ({ name: name.replace(/\.md$/i, ""), path: path.join(dir, name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// 判断键名/值是否形似凭证：命中即视为敏感，绝不读取/展示。
const SECRET_KEY_PATTERN = /(token|key|secret|password|passwd|api[_-]?key|auth)/i;

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const trimmed = value.trim();
  if (/^(sk-|sk_)/i.test(trimmed)) return true;
  if (trimmed.length >= 24 && /[A-Za-z0-9_-]{24,}/.test(trimmed)) return true;
  return false;
}

function safeEnvModelKeys(env: unknown, skippedSecrets: string[]): Array<{ key: string; value: string }> {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  const keys: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (isSensitiveKey(key) || isSensitiveValue(value)) {
      if (!skippedSecrets.includes(key)) skippedSecrets.push(key);
      continue;
    }
    if (typeof value === "string" && key.startsWith("ANTHROPIC_")) {
      keys.push({ key, value });
    }
  }
  return keys.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------- 扫描 ----------

export function scanClaudeConfig(): ClaudeMigrationOverview {
  const configDir = claudeConfigDir();
  const skippedSecrets: string[] = [];
  const overview: ClaudeMigrationOverview = {
    configDir,
    exists: fs.existsSync(configDir),
    settings: { model: null, permissionsAllow: [], permissionsDeny: [], envModelKeys: [] },
    mcps: [],
    skills: [],
    commands: [],
    history: { sessionFiles: 0, totalBytes: 0, lastModifiedAt: null },
    skippedSecrets,
  };
  if (!overview.exists) return overview;

  // settings.json：只提取模型与权限，跳过一切敏感内容。
  const settings = readJsonSafe(path.join(configDir, "settings.json"));
  if (settings) {
    const env = settings["env"];
    overview.settings.envModelKeys = safeEnvModelKeys(env, skippedSecrets);
    const model = env && typeof env === "object" && !Array.isArray(env)
      ? (env as Record<string, unknown>)["ANTHROPIC_MODEL"]
      : null;
    overview.settings.model = typeof model === "string" && !isSensitiveValue(model) ? model : null;

    const permissions = settings["permissions"];
    if (permissions && typeof permissions === "object" && !Array.isArray(permissions)) {
      const allow = (permissions as Record<string, unknown>)["allow"];
      const deny = (permissions as Record<string, unknown>)["deny"];
      overview.settings.permissionsAllow = Array.isArray(allow)
        ? allow.filter((item): item is string => typeof item === "string" && !isSensitiveValue(item))
        : [];
      overview.settings.permissionsDeny = Array.isArray(deny)
        ? deny.filter((item): item is string => typeof item === "string" && !isSensitiveValue(item))
        : [];
    }
  }

  // MCP 服务器：~/.claude/mcp.json（顶层 "mcpServers"）。
  const mcpJson = readJsonSafe(path.join(configDir, "mcp.json"));
  const mcpServers = mcpJson?.["mcpServers"];
  if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
    for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const server = value as Record<string, unknown>;
      if (isSensitiveValue(server["command"]) || isSensitiveValue(server["url"])) {
        if (!skippedSecrets.includes(name)) skippedSecrets.push(name);
        continue;
      }
      overview.mcps.push({
        name,
        type: typeof server["type"] === "string" ? server["type"] : (server["command"] ? "stdio" : "sse"),
        command: typeof server["command"] === "string" ? server["command"] : undefined,
        url: typeof server["url"] === "string" ? server["url"] : undefined,
        enabled: server["enabled"] !== false,
      });
    }
    overview.mcps.sort((a, b) => a.name.localeCompare(b.name));
  }

  overview.skills = listMdFiles(path.join(configDir, "skills"));
  overview.commands = listMdFiles(path.join(configDir, "commands"));

  // 历史会话：只统计文件数量、大小与最近修改时间，绝不读取内容。
  const projectsDir = path.join(configDir, "projects");
  try {
    if (fs.existsSync(projectsDir)) {
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            overview.history.sessionFiles += 1;
            try {
              const stat = fs.statSync(fullPath);
              overview.history.totalBytes += stat.size;
              const modified = stat.mtime.toISOString();
              if (!overview.history.lastModifiedAt || modified > overview.history.lastModifiedAt) {
                overview.history.lastModifiedAt = modified;
              }
            } catch {
              // ignore per-file stat errors
            }
          }
        }
      };
      walk(projectsDir);
    }
  } catch {
    // ignore scan errors
  }

  return overview;
}

// ---------- 迁移 ----------

/**
 * 把 Claude 的 MCP 服务器配置迁移到 Codex（写入 mcp_servers.<name>）。
 * 只迁移名称、type、command、url 等非敏感字段。
 */
export async function migrateClaudeMcpToCodex(
  overview: ClaudeMigrationOverview,
  serverNames: string[],
  sender?: Sender,
): Promise<ClaudeMigrationResult> {
  const result: ClaudeMigrationResult = { migratedMcps: [], failedMcps: [] };
  const targets = overview.mcps.filter((mcp) => serverNames.includes(mcp.name));
  if (!targets.length) return result;
  // 动态导入：避免静态加载 codex_admin（其依赖链含 better-sqlite3 原生模块，
  // 会让不涉及迁移的扫描路径在单元测试环境下无法加载）。
  const { batchWriteCodexConfig } = await import("./codex_admin");
  for (const mcp of targets) {
    const value: Record<string, unknown> = { type: mcp.type, enabled: mcp.enabled };
    if (mcp.command) value["command"] = mcp.command;
    if (mcp.url) value["url"] = mcp.url;
    try {
      await batchWriteCodexConfig({
        edits: [{ keyPath: `mcp_servers.${mcp.name}`, value, mergeStrategy: "upsert" }],
      }, sender);
      result.migratedMcps.push(mcp.name);
    } catch (error) {
      result.failedMcps.push({ name: mcp.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
