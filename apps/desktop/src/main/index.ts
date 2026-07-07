/// <reference types="electron-vite/node" />
import { app, shell, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc";
import { initDesktopCloudSync } from "./sync";
import { startProviderAutoDetect } from "./providers";

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "AI 工作台",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const isToggleDevTools =
      input.key === "F12" ||
      ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "i");

    if (isToggleDevTools) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

app.whenReady().then(() => {
  const mainWindow = createWindow();
  registerIpcHandlers(mainWindow);
  initDesktopCloudSync(mainWindow);
  startProviderAutoDetect();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow();
      initDesktopCloudSync(win);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
