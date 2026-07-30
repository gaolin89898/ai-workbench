// Task completion notifications for the Electron main process.
// Shows a system notification and flashes the taskbar when an AI task finishes
// while the main window is not focused (user is away or minimized).

import { BrowserWindow, Notification } from "electron";

let mainWindow: BrowserWindow | null = null;

const PROVIDER_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  mimo: "MiMo Code",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "任务已完成",
  failed: "任务执行失败",
  canceled: "任务已取消",
};

/** Register the main window so notifications can check focus state and restore it. */
export function setNotificationWindow(win: BrowserWindow | null): void {
  mainWindow = win;

  if (win) {
    // Stop flashing the taskbar once the user returns to the app.
    win.on("focus", () => {
      if (!win.isDestroyed()) {
        win.flashFrame(false);
      }
    });
  }
}

/** True when the user is actively looking at the app (window focused and visible). */
function isWindowActive(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isFocused() && mainWindow.isVisible();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Notify the user that a background AI task has finished.
 * Only fires when the main window is not focused (user is away).
 * Clicking the notification restores and focuses the window.
 */
export function notifyTaskComplete(
  sessionTitle: string | undefined,
  status: "completed" | "failed" | "canceled",
  providerId?: string | null,
): void {
  // Don't bother the user if they're already looking at the app.
  if (isWindowActive()) return;

  const providerName = providerId ? PROVIDER_NAMES[providerId] ?? "AI" : "AI";
  const statusLabel = STATUS_LABELS[status] ?? "任务结束";
  const title = `${providerName} · ${statusLabel}`;
  const body = sessionTitle?.trim() || "AI 会话";

  // System notification (click to bring window to front).
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on("click", () => showMainWindow());
    notification.show();
  }

  // Flash the taskbar button on Windows / Linux to draw attention.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(true);
  }
}
