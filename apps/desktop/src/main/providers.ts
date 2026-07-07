// AI provider detection for the Electron main process.

import { spawn } from "node:child_process";
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

let detectionInFlight: Promise<ProviderStatus[]> | null = null;

type ProviderMetadata = {
  npmPackage?: string;
  installCommand?: string;
  updateCommand?: string;
  installUrl?: string;
};

const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  codex: {
    npmPackage: "@openai/codex",
    installCommand: "npm install -g @openai/codex",
    updateCommand: "npm install -g @openai/codex@latest",
    installUrl: "https://www.npmjs.com/package/@openai/codex",
  },
  claude: {
    npmPackage: "@anthropic-ai/claude-code",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
    installUrl: "https://www.npmjs.com/package/@anthropic-ai/claude-code",
  },
  opencode: {
    npmPackage: "opencode-ai",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
    updateCommand: "curl -fsSL https://opencode.ai/install | bash",
    installUrl: "https://opencode.ai/docs",
  },
  mimo: {
    installUrl: "https://mimo.xiaomi.com/",
  },
};

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runCommand(command: string, args: string[], timeout = 5000): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ status: null, stdout, stderr });
    }, timeout);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  const result = process.platform === "win32"
    ? await runCommand("cmd.exe", ["/d", "/s", "/c", "where", command], 3000)
    : await runCommand("which", [command], 3000);
  return result.status === 0;
}

async function getCommandVersion(command: string): Promise<string | null> {
  const result = process.platform === "win32"
    ? await runCommand("cmd.exe", ["/d", "/s", "/c", command, "--version"], 5000)
    : await runCommand(command, ["--version"], 5000);
  if (result.status !== 0) return null;
  const out = (result.stdout || result.stderr || "").trim();
  return out.length > 0 ? out : null;
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
    const authFile = path.join(home, ".codex", "auth.json");
    return fileExists(authFile) ? "signedIn" : "unknown";
  }
  if (providerId === "claude") {
    const claudeDir = path.join(home, ".claude");
    const claudeJson = path.join(home, ".claude.json");
    return dirExists(claudeDir) || fileExists(claudeJson) ? "signedIn" : "signedOut";
  }
  if (providerId === "mimo") {
    const mimoDir = path.join(home, ".mimocode");
    return dirExists(mimoDir) ? "signedIn" : "unknown";
  }
  if (providerId === "opencode") {
    const authFile = path.join(home, ".local", "share", "opencode", "auth.json");
    const accountFile = path.join(home, ".local", "share", "opencode", "account.json");
    return fileExists(authFile) || fileExists(accountFile) ? "signedIn" : "unknown";
  }
  return "unknown";
}

function extractVersion(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? null;
}

function compareVersions(left: string | null | undefined, right: string | null | undefined): number | null {
  const leftVersion = extractVersion(left);
  const rightVersion = extractVersion(right);
  if (!leftVersion || !rightVersion) return null;
  const leftParts = leftVersion.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  const rightParts = rightVersion.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (leftParts.some(Number.isNaN) || rightParts.some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i += 1) {
    if (leftParts[i] !== rightParts[i]) return leftParts[i] > rightParts[i] ? 1 : -1;
  }
  return 0;
}

async function fetchJsonWithTimeout(url: string, timeout = 4000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNpmLatestVersion(packageName: string): Promise<string> {
  const encodedPackage = packageName.replace(/\//g, "%2F");
  const data = await fetchJsonWithTimeout(`https://registry.npmjs.org/${encodedPackage}`);
  if (!data || typeof data !== "object") throw new Error("registry response is empty");
  const tags = (data as { "dist-tags"?: Record<string, unknown> })["dist-tags"];
  const latest = tags?.latest;
  if (typeof latest !== "string" || !latest) throw new Error("registry response has no latest tag");
  return latest;
}

async function detectLatestVersion(providerId: string): Promise<{ latestVersion: string | null; versionCheckError: string | null }> {
  const metadata = PROVIDER_METADATA[providerId];
  if (!metadata?.npmPackage) {
    return { latestVersion: null, versionCheckError: "暂未配置版本源" };
  }
  try {
    return { latestVersion: await fetchNpmLatestVersion(metadata.npmPackage), versionCheckError: null };
  } catch (error) {
    return {
      latestVersion: null,
      versionCheckError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function listAiProviders(): AiProvider[] {
  return BUILTIN_PROVIDERS;
}

async function detectAiProvidersUncached(): Promise<ProviderStatus[]> {
  const lastCheckedAt = new Date().toISOString();
  return Promise.all(BUILTIN_PROVIDERS.map(async (provider) => {
    const metadata = PROVIDER_METADATA[provider.id] ?? {};
    const installed = await commandExists(provider.command);
    const version = installed ? await getCommandVersion(provider.command) : null;
    const authStatus = detectAuthStatus(provider.id);
    const { latestVersion, versionCheckError } = await detectLatestVersion(provider.id);
    const versionComparison = installed ? compareVersions(version, latestVersion) : null;
    return {
      providerId: provider.id,
      installed,
      version,
      latestVersion,
      updateAvailable: versionComparison === null ? null : versionComparison === -1,
      versionCheckError,
      installCommand: metadata.installCommand ?? null,
      updateCommand: metadata.updateCommand ?? metadata.installCommand ?? null,
      installUrl: metadata.installUrl ?? null,
      authStatus,
      lastCheckedAt,
    };
  }));
}

export async function detectAiProviders(): Promise<ProviderStatus[]> {
  if (detectionInFlight) return detectionInFlight;
  detectionInFlight = detectAiProvidersUncached().finally(() => {
    detectionInFlight = null;
  });
  return detectionInFlight;
}
