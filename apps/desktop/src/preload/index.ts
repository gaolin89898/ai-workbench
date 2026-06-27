import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const api = {
  ipc: new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get: (_t, channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, args),
  }),
  on: new Proxy({} as Record<string, (listener: (...args: unknown[]) => void) => () => void>, {
    get: (_t, channel: string) => (listener: (...args: unknown[]) => void) => {
      const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...args);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
  }),
};

contextBridge.exposeInMainWorld("desktop", api);
