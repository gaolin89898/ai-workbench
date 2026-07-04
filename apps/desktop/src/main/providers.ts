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
  return "unknown";
}

export function listAiProviders(): AiProvider[] {
  return BUILTIN_PROVIDERS;
}

async function detectAiProvidersUncached(): Promise<ProviderStatus[]> {
  const lastCheckedAt = new Date().toISOString();
  return Promise.all(BUILTIN_PROVIDERS.map(async (provider) => {
    const installed = await commandExists(provider.command);
    const version = installed ? await getCommandVersion(provider.command) : null;
    const authStatus = detectAuthStatus(provider.id);
    return {
      providerId: provider.id,
      installed,
      version,
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
