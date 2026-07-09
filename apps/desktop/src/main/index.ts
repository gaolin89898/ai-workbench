/// <reference types="electron-vite/node" />
import { app, shell, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc";
import { initDesktopCloudSync } from "./sync";
import { startProviderAutoDetect } from "./providers";

let tray: Tray | null = null;

const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAOvSURBVFhHxddrTJNXGAfw89HsA3ReJir0pRSZTMetUJ2GhcVkU1GjsdY2GDF4FxJAMV6CdDJcx7x0gK0OrTXIhtxaHRGNURpv4HRYGWSo1SlIKYw0KlGJbsl/OU3a0Oqprwbbf/J8eT+c33tuT3II8UpwqHSRQDRTLYhINn8clYLR0bMxeuo3GBMzD2PiFmCsZDHGSWUYN0OBT2alYfyXKxDyVQZCZq/BhK/XY+LcTEyan41JCzchdPEWhMm2QSjPNwuVBRpueeFKLl01ytt05iMuKSRYKD0jEM2EQJyMEcOX5UOoVIFbXojw9N0QZRR3cmv3TvHAg8fHhgeFSR/7AYdo9V5ErNMMRa4vmeH+gSCh1OxHHOKNpRBn6jq5dMMoEhQ6XeF3PEuHyOyfEZlzeBsRiL44GBA89wgmbz56hggiki0BwfMMiNp6/DEJII6o7b+CBBL/NL8ahA+emqXGkrz9WLL1J8i2l0G2Q4ulOw9BriqHfJce8u8MWPSt/p3xKao6EF94amYRrN128M2jgSdYpz3JG48uPAnCwunMm653eBtvzT27gzceXdQAwsLpnrtyp/cpLnf2e9TQq/884OHhi3+mbgRh4fTA0Tx5/grBK068VrnH/vB23blmteGatRcF9c0+8ak/ngNh4fS0j0RWGcxMfNq+CyAsnF41V/QXrFAb299Ymoa/PEDvVF2/x8SnaS6CsHB6z2noFqSqm5iVoWt2YxsO/+7eoq6BZ85vRstDJv556RUQFk6bTMeDXvfg7xvjrS4mHqNtAWHhtMNt1tV7j+czdNb0hgyPsa2bicceugHCwl3tNTFzPxTqSiiLq6DcUw3lvlrYHIP45+lzpJU1IKeiyY3RM0G3xbX8NKY/e5h4bPlNEF84q7c/cgyixzHovOcpu2vd2Jtiarcx8Th9GwhfPC5Xh6LaSyhpvIHBFy+dVXrOguLTrXj5L7spVbR2M/H4Yx0gfHA6c4qz0tbj8P7kjqyylYnHV9wG4YPTZY/fokeRsRmlZ2/i+NVOVDbfRtn5dnzfaEGS+hQU+os4cOkOtJet0F69j2LzXaSUt/jEE36xgvDB36W3+zpw3nhC1d8gYfL8B4HCE2q6hohQUVAVCFxS04XEOlsL4dJ25QQEr7dBYuzXEC5dJRBl/GD3O27qG5pusoc7X0bcqj0p/sQTTX1IOtW/ctjrkBDxxpI54iyd/UPjdOav4a5w2QaBeNMRzeS8oy0jjUvqbZZEY59B8tuAx8v4f7TeWjUIYOP8AAAAAElFTkSuQmCC";

function createAppIcon() {
  return nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
}

function showMainWindow(mainWindow: BrowserWindow): void {
  if (mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

async function openLogsDirectory(): Promise<void> {
  const logsPath = app.getPath("logs");
  await fs.mkdir(logsPath, { recursive: true });
  await shell.openPath(logsPath);
}

function createTray(mainWindow: BrowserWindow): void {
  const icon = createAppIcon();
  icon.setTemplateImage(process.platform === "darwin");

  tray = new Tray(icon);
  tray.setToolTip("AI Workbench");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 AI Workbench",
        click: () => showMainWindow(mainWindow),
      },
      {
        label: "打开日志目录",
        click: () => {
          void openLogsDirectory();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => app.quit(),
      },
    ]),
  );
  tray.on("double-click", () => showMainWindow(mainWindow));
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "AI 工作台",
    icon: createAppIcon(),
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
  createTray(mainWindow);
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
