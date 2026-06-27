import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld("desktop", api);
