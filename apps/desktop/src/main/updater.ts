import { autoUpdater } from "electron-updater";
import { app, type BrowserWindow } from "electron";
import type { AppUpdateInfo } from "../services/desktop";
import { fetchDesktopAppRelease } from "./sync";

// 配置
autoUpdater.autoDownload = false; // 不自动下载，用户点击后才下载
autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装
autoUpdater.setFeedURL({
  provider: "github",
  owner: "gaolin89898",
  repo: "ai-workbench",
  releaseType: "release",
});

let mainWindow: BrowserWindow | null = null;

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win;

  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("update-available", info);
  });

  autoUpdater.on("update-not-available", () => {
    mainWindow?.webContents.send("update-not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("download-progress", progress);
  });

  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.webContents.send("update-downloaded", info);
  });

  autoUpdater.on("error", (err) => {
    mainWindow?.webContents.send("update-error", { message: err?.message ?? String(err) });
  });
}

// 将 electron-updater 的 releaseNotes 归一化为 string | null
function normalizeBody(releaseNotes: unknown): string | null {
  if (releaseNotes == null) return null;
  if (Array.isArray(releaseNotes)) {
    const notes = releaseNotes
      .map((note) => {
        if (typeof note === "string") return note;
        if (note && typeof note === "object" && "note" in note) {
          const value = (note as { note?: unknown }).note;
          return typeof value === "string" ? value : "";
        }
        return "";
      })
      .filter(Boolean);
    return notes.length > 0 ? notes.join("\n") : null;
  }
  return typeof releaseNotes === "string" ? releaseNotes : null;
}

function normalizeVersion(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isNewerVersion(candidate: string, current: string): boolean {
  const left = normalizeVersion(candidate);
  const right = normalizeVersion(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

async function checkGitHubReleases(note?: string): Promise<AppUpdateInfo> {
  const response = await fetch("https://api.github.com/repos/gaolin89898/ai-workbench/releases?per_page=20", {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "ai-workbench-updater",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases HTTP ${response.status}: ${await response.text()}`);
  }

  const releases = await response.json() as Array<{
    tag_name?: string;
    name?: string;
    published_at?: string;
    body?: string;
  }>;
  const latestDesktop = releases.find((release) => /^v\d+\.\d+\.\d+$/.test(release.tag_name ?? ""));
  if (!latestDesktop?.tag_name) {
    throw new Error("GitHub Releases 中没有找到桌面端 vX.Y.Z 版本");
  }

  const latestVersion = latestDesktop.tag_name.replace(/^v/i, "");
  const currentVersion = app.getVersion();
  return {
    available: isNewerVersion(latestVersion, currentVersion),
    version: latestVersion,
    currentVersion,
    date: latestDesktop.published_at ?? null,
    body: note ?? latestDesktop.body ?? null,
    installable: false,
  };
}

// 检查更新（对应 tauri.ts 的 checkAppUpdate）
export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  const currentVersion = app.getVersion();
  const serverRelease = await fetchDesktopAppRelease(currentVersion);
  if (serverRelease) {
    return {
      ...serverRelease,
      installable: app.isPackaged,
    };
  }
  if (!app.isPackaged) {
    return checkGitHubReleases("当前是开发模式，只能诊断是否有新版本；安装更新需要使用已打包的 exe。");
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      return checkGitHubReleases("自动更新通道没有返回版本信息，已改用 GitHub Releases 兜底检查。");
    }
    const updateInfo = result.updateInfo;
    const available = isNewerVersion(updateInfo.version, currentVersion);
    return {
      available,
      version: updateInfo.version,
      currentVersion,
      date: updateInfo.releaseDate ?? null,
      body: normalizeBody(updateInfo.releaseNotes),
      installable: available,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return checkGitHubReleases(`自动更新通道检查失败：${message}。已改用 GitHub Releases 兜底检查。`);
  }
}

// 下载并安装更新（对应 tauri.ts 的 installAppUpdate）
export async function installAppUpdate(): Promise<boolean> {
  if (!app.isPackaged) {
    throw new Error("当前是开发模式，不能安装更新；请打开已安装的正式版客户端。");
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const updateVersion = result?.updateInfo?.version;
    if (!updateVersion || !isNewerVersion(updateVersion, app.getVersion())) {
      throw new Error("自动更新通道没有返回可安装的新版本，请重新检查更新或手动下载最新版安装包。");
    }
    await autoUpdater.downloadUpdate();
    await autoUpdater.quitAndInstall();
    return true;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
}
