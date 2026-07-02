// AI provider detection for the Electron main process.
// Detects install status / version / auth status of built-in AI CLI tools
// (codex / claude) using synchronous child_process calls.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AiProvider, ProviderStatus } from "../services/desktop";

const BUILTIN_PROVIDERS: AiProvider[] = [
  { id: "codex", name: "Codex CLI", command: "codex", builtIn: true, enabled: true },
  { id: "claude", name: "Claude Code", command: "claude", builtIn: true, enabled: true },
  { id: "opencode", name: "OpenCode", command: "opencode", builtIn: true, enabled: true },
  { id: "mimo", name: "MiMo Code", command: "mimo", builtIn: true, enabled: true },
];

function commandExists(command: string): boolean {
  try {
    const result = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "where", command], { encoding: "utf-8" })
      : spawnSync("which", [command], { encoding: "utf-8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getCommandVersion(command: string): string | null {
  try {
    const result = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", command, "--version"], { encoding: "utf-8", timeout: 5000 })
      : spawnSync(command, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (result.status === 0) {
      const out = (result.stdout || result.stderr || "").trim();
      return out.length > 0 ? out : null;
    }
    return null;
  } catch {
    return null;
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function detectAuthStatus(providerId: string): string {
  const home = os.homedir();
  if (providerId === "codex") {
    // codex: ~/.codex/auth.json presence implies signed in.
    // We can't reliably auto-determine auth from the CLI, so fall back to
    // "unknown" when the file is absent (covers both installed-no-file and
    // not-installed cases).
    const authFile = path.join(home, ".codex", "auth.json");
    return fileExists(authFile) ? "signedIn" : "unknown";
  }
  if (providerId === "claude") {
    // claude: ~/.claude/ dir or ~/.claude.json presence implies signed in.
    const claudeDir = path.join(home, ".claude");
    const claudeJson = path.join(home, ".claude.json");
    return dirExists(claudeDir) || fileExists(claudeJson) ? "signedIn" : "signedOut";
  }
  if (providerId === "mimo") {
    // mimo: ~/.mimocode/ dir presence implies available.
    const mimoDir = path.join(home, ".mimocode");
    return dirExists(mimoDir) ? "signedIn" : "unknown";
  }
  return "unknown";
}

export function listAiProviders(): AiProvider[] {
  return BUILTIN_PROVIDERS;
}

export async function detectAiProviders(): Promise<ProviderStatus[]> {
  const lastCheckedAt = new Date().toISOString();
  return BUILTIN_PROVIDERS.map((provider) => {
    const installed = commandExists(provider.command);
    const version = installed ? getCommandVersion(provider.command) : null;
    const authStatus = detectAuthStatus(provider.id);
    return {
      providerId: provider.id,
      installed,
      version,
      authStatus,
      lastCheckedAt,
    };
  });
}
