import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";

const ignoredWatchPaths = (path: string): boolean => {
  const normalizedPath = path.replaceAll("\\", "/");
  return normalizedPath.split("/").some((part) => [".git", "node_modules", "out", "dist-electron"].includes(part));
};

const watchOptions = {
  ignored: ignoredWatchPaths,
  usePolling: process.env.ELECTRON_VITE_USE_POLLING === "1",
  interval: 500,
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
    resolve: {
      alias: { "@main": resolve(__dirname, "src/main") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "index.html") },
      },
    },
    resolve: {
      alias: { "@": resolve(__dirname, "src") },
    },
    plugins: [vue()],
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
      watch: watchOptions,
    },
    clearScreen: false,
  },
});
