/// <reference types="vite/client" />

declare module "*.vue" {
  const component: import("vue").DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

export {};

declare global {
  interface DesktopApi {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  }

  interface Window {
    desktop: DesktopApi;
  }
}
