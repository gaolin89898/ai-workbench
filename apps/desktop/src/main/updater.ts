import { autoUpdater } from "electron-updater";
import type { BrowserWindow } from "electron";
import type { AppUpdateInfo } from "../services/desktop";

// 配置
autoUpdater.autoDownload = false; // 不自动下载，用户点击后才下载
autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装

let mainWindow: BrowserWindow | null = null;

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win;

  autoUpdater.on("update-available", (info) => {
    mainWindow?.send("update-available", info);
  });

  autoUpdater.on("update-not-available", () => {
    mainWindow?.send("update-not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.send("download-progress", progress);
  });

  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.send("update-downloaded", info);
  });

  autoUpdater.on("error", (err) => {
    mainWindow?.send("update-error", { message: err?.message ?? String(err) });
  });
}

// 将 electron-updater 的 releaseNotes 归一化为 string | null
function normalizeBody(releaseNotes: string | string[] | null | undefined): string | null {
  if (releaseNotes == null) return null;
  if (Array.isArray(releaseNotes)) {
    return releaseNotes.length > 0 ? releaseNotes.join("\n") : null;
  }
  return releaseNotes;
}

// 检查更新（对应 tauri.ts 的 checkAppUpdate）
export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      return { available: false };
    }
    const updateInfo = result.updateInfo;
    return {
      available: true,
      version: updateInfo.version,
      currentVersion: autoUpdater.currentVersion.version,
      date: updateInfo.releaseDate ?? null,
      body: normalizeBody(updateInfo.releaseNotes),
    };
  } catch (e) {
    // 检查失败时返回不可用
    return { available: false };
  }
}

// 下载并安装更新（对应 tauri.ts 的 installAppUpdate）
export async function installAppUpdate(): Promise<boolean> {
  try {
    await autoUpdater.downloadUpdate();
    await autoUpdater.quitAndInstall();
    return true;
  } catch (e) {
    return false;
  }
}
