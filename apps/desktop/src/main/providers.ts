// AI provider detection for the Electron main process.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { app } from "electron";
import type { AiProvider, NpmRegistryInfo, NpmRegistryProbeResult, ProviderStatus } from "../services/desktop";

const BUILTIN_PROVIDERS: AiProvider[] = [
  { id: "codex", name: "Codex CLI", command: "codex", builtIn: true, enabled: true },
  { id: "claude", name: "Claude Code", command: "claude", builtIn: true, enabled: true },
  { id: "opencode", name: "OpenCode", command: "opencode", builtIn: true, enabled: true },
  { id: "mimo", name: "MiMo Code", command: "mimo", builtIn: true, enabled: true },
];

let detectionInFlight: Promise<ProviderStatus[]> | null = null;
let selectedNpmRegistry: string | null = null;
let providerAutoDetectTimer: NodeJS.Timeout | null = null;
let providerAutoDetectInFlight = false;
const PROVIDER_AUTO_DETECT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_MAINTENANCE_STATE_PATH = path.join(app.getPath("userData"), "provider-maintenance.json");

const NPM_REGISTRY_OPTIONS = [
  { label: "npm 官方源", registry: "https://registry.npmjs.org/" },
  { label: "清华 TUNA", registry: "https://mirrors.tuna.tsinghua.edu.cn/npm/" },
  { label: "淘宝 npmmirror", registry: "https://registry.npmmirror.com/" },
  { label: "腾讯云镜像", registry: "https://mirrors.cloud.tencent.com/npm/" },
  { label: "华为云镜像", registry: "https://repo.huaweicloud.com/repository/npm/" },
];

type ProviderMetadata = {
  npmPackage?: string;
  installCommand?: string;
  updateCommand?: string;
  platformInstallCommands?: Partial<Record<NodeJS.Platform, string>>;
  platformUpdateCommands?: Partial<Record<NodeJS.Platform, string>>;
  installUrl?: string;
};

export type ProviderActionKind = "install" | "update";

export type ProviderActionResult = {
  providerId: string;
  action: ProviderActionKind;
  command: string;
  success: boolean;
  status: number | null;
  output: string;
};

const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  codex: {
    npmPackage: "@openai/codex",
    installCommand: "npm i -g @openai/codex@latest",
    updateCommand: "npm i -g @openai/codex@latest",
    installUrl: "https://www.npmjs.com/package/@openai/codex",
  },
  claude: {
    npmPackage: "@anthropic-ai/claude-code",
    installCommand: "npm i -g @anthropic-ai/claude-code@latest",
    updateCommand: "npm i -g @anthropic-ai/claude-code@latest",
    installUrl: "https://claude.ai/download",
  },
  opencode: {
    npmPackage: "opencode-ai",
    installCommand: "npm i -g opencode-ai@latest",
    updateCommand: "npm i -g opencode-ai@latest",
    installUrl: "https://opencode.ai/docs",
  },
  mimo: {
    npmPackage: "@mimo-ai/cli",
    installCommand: "npm install -g @mimo-ai/cli",
    updateCommand: "npm install -g @mimo-ai/cli",
    platformInstallCommands: {
      linux: "curl -fsSL https://mimo.xiaomi.com/install | bash",
      win32: "npm install -g @mimo-ai/cli",
    },
    platformUpdateCommands: {
      linux: "curl -fsSL https://mimo.xiaomi.com/install | bash",
      win32: "npm install -g @mimo-ai/cli",
    },
    installUrl: "https://mimo.xiaomi.com/",
  },
};

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type ProviderMaintenanceState = {
  lastAutoDetectAt?: string;
};

function runCommand(command: string, args: string[], timeout = 5000, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      env: env ? { ...process.env, ...env } : undefined,
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

function runShellCommand(command: string, timeout = 300000, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const shellCommand = process.platform === "win32" ? "cmd.exe" : "bash";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  return runCommand(shellCommand, shellArgs, timeout, env);
}

function normalizeRegistry(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return "https://registry.npmjs.org/";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function npmRegistryOptions() {
  return NPM_REGISTRY_OPTIONS;
}

function readProviderMaintenanceState(): ProviderMaintenanceState {
  try {
    if (!fs.existsSync(PROVIDER_MAINTENANCE_STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(PROVIDER_MAINTENANCE_STATE_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as ProviderMaintenanceState : {};
  } catch {
    return {};
  }
}

function writeProviderMaintenanceState(state: ProviderMaintenanceState) {
  try {
    fs.mkdirSync(path.dirname(PROVIDER_MAINTENANCE_STATE_PATH), { recursive: true });
    fs.writeFileSync(PROVIDER_MAINTENANCE_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (error) {
    console.warn("failed to persist provider maintenance state:", error);
  }
}

function shouldRunProviderAutoDetect(): boolean {
  const lastAutoDetectAt = readProviderMaintenanceState().lastAutoDetectAt;
  if (!lastAutoDetectAt) return true;
  const lastTime = new Date(lastAutoDetectAt).getTime();
  if (!Number.isFinite(lastTime)) return true;
  return Date.now() - lastTime >= PROVIDER_AUTO_DETECT_INTERVAL_MS;
}

function markProviderAutoDetectComplete() {
  writeProviderMaintenanceState({ lastAutoDetectAt: new Date().toISOString() });
}

export async function getNpmRegistry(): Promise<NpmRegistryInfo> {
  const result = await runShellCommand("npm config get registry", 5000);
  const registry = normalizeRegistry(result.status === 0 ? result.stdout : selectedNpmRegistry);
  selectedNpmRegistry = registry;
  return {
    registry,
    options: npmRegistryOptions(),
    success: result.status === 0,
    error: result.status === 0 ? null : `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim() || "读取 npm registry 失败",
  };
}

export async function setNpmRegistry(registry: string): Promise<NpmRegistryInfo> {
  const next = normalizeRegistry(registry);
  const safeRegistry = JSON.stringify(next);
  const result = await runShellCommand(`npm config set registry ${safeRegistry}`, 10000);
  if (result.status !== 0) {
    return {
      registry: next,
      options: npmRegistryOptions(),
      success: false,
      error: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim() || "设置 npm registry 失败",
    };
  }
  selectedNpmRegistry = next;
  return getNpmRegistry();
}

async function probeRegistry(registry: string): Promise<NpmRegistryProbeResult> {
  const normalized = normalizeRegistry(registry);
  const startedAt = Date.now();
  try {
    await fetchJsonWithTimeout(`${normalized}opencode-ai/latest`, 5000, {
      headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
    });
    return {
      registry: normalized,
      latencyMs: Date.now() - startedAt,
      ok: true,
      error: null,
    };
  } catch (error) {
    return {
      registry: normalized,
      latencyMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeNpmRegistries(): Promise<NpmRegistryInfo> {
  const probeResults = await Promise.all(NPM_REGISTRY_OPTIONS.map((option) => probeRegistry(option.registry)));
  const fastest = probeResults
    .filter((result) => result.ok)
    .sort((left, right) => (left.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.latencyMs ?? Number.MAX_SAFE_INTEGER))[0];
  if (!fastest) {
    const current = await getNpmRegistry();
    return {
      ...current,
      probeResults,
      success: false,
      error: "所有 npm 源测速失败",
    };
  }
  const updated = await setNpmRegistry(fastest.registry);
  return {
    ...updated,
    probeResults,
  };
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

async function fetchJsonWithTimeout(url: string, timeout = 4000, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
      ...init,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNpmLatestVersion(packageName: string, registry: string): Promise<string> {
  const encodedPackage = packageName.replace(/\//g, "%2F");
  const data = await fetchJsonWithTimeout(`${normalizeRegistry(registry)}${encodedPackage}`);
  if (!data || typeof data !== "object") throw new Error("registry response is empty");
  const tags = (data as { "dist-tags"?: Record<string, unknown> })["dist-tags"];
  const latest = tags?.latest;
  if (typeof latest !== "string" || !latest) throw new Error("registry response has no latest tag");
  return latest;
}

async function detectLatestVersion(providerId: string, registry: string): Promise<{ latestVersion: string | null; versionCheckError: string | null }> {
  const metadata = PROVIDER_METADATA[providerId];
  if (!metadata?.npmPackage) {
    return { latestVersion: null, versionCheckError: "暂未配置版本源" };
  }
  try {
    return { latestVersion: await fetchNpmLatestVersion(metadata.npmPackage, registry), versionCheckError: null };
  } catch (error) {
    return {
      latestVersion: null,
      versionCheckError: error instanceof Error ? error.message : String(error),
    };
  }
}

function getProviderCommand(metadata: ProviderMetadata, action: ProviderActionKind): string | null {
  if (action === "install") {
    return metadata.platformInstallCommands?.[process.platform] ?? metadata.installCommand ?? null;
  }
  return metadata.platformUpdateCommands?.[process.platform]
    ?? metadata.updateCommand
    ?? metadata.platformInstallCommands?.[process.platform]
    ?? metadata.installCommand
    ?? null;
}

export function listAiProviders(): AiProvider[] {
  return BUILTIN_PROVIDERS;
}

async function detectAiProvidersUncached(): Promise<ProviderStatus[]> {
  const lastCheckedAt = new Date().toISOString();
  const npmRegistry = (await getNpmRegistry()).registry;
  return Promise.all(BUILTIN_PROVIDERS.map(async (provider) => {
    const metadata = PROVIDER_METADATA[provider.id] ?? {};
    const installed = await commandExists(provider.command);
    const version = installed ? await getCommandVersion(provider.command) : null;
    const authStatus = detectAuthStatus(provider.id);
    const { latestVersion, versionCheckError } = await detectLatestVersion(provider.id, npmRegistry);
    const versionComparison = installed ? compareVersions(version, latestVersion) : null;
    return {
      providerId: provider.id,
      installed,
      version,
      latestVersion,
      updateAvailable: versionComparison === null ? null : versionComparison === -1,
      versionCheckError,
      installCommand: getProviderCommand(metadata, "install"),
      updateCommand: getProviderCommand(metadata, "update"),
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

export async function runProviderAction(providerId: string, action: ProviderActionKind): Promise<ProviderActionResult> {
  const provider = BUILTIN_PROVIDERS.find((item) => item.id === providerId);
  if (!provider) throw new Error("未知的 AI 工具");
  const metadata = PROVIDER_METADATA[providerId];
  if (!metadata) throw new Error("该 AI 工具暂无安装配置");
  const command = getProviderCommand(metadata, action);
  if (!command) {
    throw new Error(metadata.installUrl ? "该 AI 工具只能打开安装说明，暂未配置自动安装命令" : "该 AI 工具暂无自动安装命令");
  }
  const registry = (await getNpmRegistry()).registry;
  const result = await runShellCommand(command, 300000, {
    npm_config_registry: registry,
    NPM_CONFIG_REGISTRY: registry,
  });
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  return {
    providerId,
    action,
    command,
    success: result.status === 0,
    status: result.status,
    output,
  };
}

async function runProviderAutoDetect() {
  if (providerAutoDetectInFlight) return;
  providerAutoDetectInFlight = true;
  try {
    await probeNpmRegistries();
    await detectAiProviders();
    markProviderAutoDetectComplete();
  } catch (error) {
    console.warn("provider auto detect failed:", error);
  } finally {
    providerAutoDetectInFlight = false;
  }
}

export function startProviderAutoDetect() {
  if (providerAutoDetectTimer) return;
  void getNpmRegistry();
  if (shouldRunProviderAutoDetect()) {
    void runProviderAutoDetect();
  }
  providerAutoDetectTimer = setInterval(() => {
    if (shouldRunProviderAutoDetect()) {
      void runProviderAutoDetect();
    }
  }, PROVIDER_AUTO_DETECT_INTERVAL_MS);
}
