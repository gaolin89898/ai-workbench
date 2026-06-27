/// <reference types="vite/client" />

export interface DesktopApi {
  ipc: Record<string, (...args: unknown[]) => Promise<unknown>>;
  on: Record<string, (listener: (...args: unknown[]) => void) => () => void>;
}

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
