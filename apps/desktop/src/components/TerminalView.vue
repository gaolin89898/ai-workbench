<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi } from "../services/desktop";

type ProjectTerminalTab = {
  id: string;
  label: string;
  primary: boolean;
};

const emit = defineEmits<{ close: [] }>();
const terminalIcon = new URL("../assets/icons/terminal.svg", import.meta.url).href;

const ws = useWorkspace();
const terminalHost = ref<HTMLDivElement | null>(null);
const activeProjectPath = computed(() => ws.activeAiSession.value?.summary?.trim() || ws.selectedProjectPath.value);
const selectedProject = computed(() => ws.projects.value.find((project) => project.path === activeProjectPath.value) ?? null);
const terminalTabs = ref<ProjectTerminalTab[]>([]);
const activeTerminalId = ref("");
const primarySessionId = computed(() => activeProjectPath.value ? ws.projectShellSessionId(activeProjectPath.value) : "");
const activeSessionId = computed(() => activeTerminalId.value || primarySessionId.value);
const activeTerminalTab = computed(() => terminalTabs.value.find((tab) => tab.id === activeSessionId.value) ?? null);
const activeBuffer = computed(() => ws.shellBuffers.value[activeSessionId.value] ?? "");
const activeLiveState = computed(() => {
  if (!activeSessionId.value) return null;
  return ws.liveShellSessions.value[activeSessionId.value];
});
const terminalState = computed<"no-session" | "checking" | "offline" | "waiting" | "ready">(() => {
  if (!activeSessionId.value) return "no-session";
  if (activeLiveState.value === undefined) return "checking";
  if (activeLiveState.value === false) return "offline";
  if (!activeBuffer.value) return "waiting";
  return "ready";
});
const terminalNoticeTitle = computed(() => {
  if (terminalState.value === "no-session") return "还没有选择项目";
  if (terminalState.value === "checking") return "正在检查项目 shell";
  if (terminalState.value === "offline") return "这个 shell 没有运行";
  if (terminalState.value === "waiting") return "正在等待终端输出";
  return "";
});
const terminalNoticeText = computed(() => {
  if (terminalState.value === "no-session") return "先选择一个本地项目，然后打开项目 shell。";
  if (terminalState.value === "checking") return "桌面端正在确认这个项目的 shell 是否已经启动。";
  if (terminalState.value === "offline") return "这个项目 shell 没有运行。可以重新启动 shell。";
  if (terminalState.value === "waiting") return "shell 已启动，等待输出。";
  return "";
});

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let lastSessionId = "";
let lastBufferLength = 0;
let terminalSerial = 1;

function resolveTerminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.classList.contains("theme-dark");

  return {
    background: color("--color-bg-content", dark ? "#1e2235" : "#ffffff"),
    foreground: color("--color-text-primary", dark ? "#e8eaed" : "#0f172a"),
    cursor: color("--color-text-primary", dark ? "#e8eaed" : "#0f172a"),
    cursorAccent: color("--color-bg-content", dark ? "#1e2235" : "#ffffff"),
    selectionBackground: dark ? "rgba(148, 163, 184, 0.28)" : "rgba(37, 99, 235, 0.18)",
    black: dark ? "#111318" : "#334155",
    red: dark ? "#f87171" : "#dc2626",
    green: dark ? "#4ade80" : "#15803d",
    yellow: dark ? "#facc15" : "#a16207",
    blue: dark ? "#60a5fa" : "#2563eb",
    magenta: dark ? "#c084fc" : "#9333ea",
    cyan: dark ? "#2dd4bf" : "#0f766e",
    white: dark ? "#d1d5db" : "#cbd5e1",
    brightBlack: dark ? "#6b7280" : "#64748b",
    brightRed: dark ? "#fca5a5" : "#ef4444",
    brightGreen: dark ? "#86efac" : "#16a34a",
    brightYellow: dark ? "#fde047" : "#ca8a04",
    brightBlue: dark ? "#93c5fd" : "#3b82f6",
    brightMagenta: dark ? "#d8b4fe" : "#a855f7",
    brightCyan: dark ? "#67e8f9" : "#0891b2",
    brightWhite: dark ? "#f8fafc" : "#0f172a",
  };
}

function syncTerminalTheme() {
  if (terminal) terminal.options.theme = resolveTerminalTheme();
}

onMounted(() => {
  resetTerminalTabs();
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: "\"DejaVu Sans Mono\", \"Noto Sans Mono CJK SC\", \"Source Han Mono SC\", \"WenQuanYi Micro Hei Mono\", monospace",
    fontSize: 14,
    fontWeight: 400,
    fontWeightBold: 700,
    letterSpacing: 0,
    lineHeight: 1.2,
    scrollback: 8000,
    theme: resolveTerminalTheme(),
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  if (terminalHost.value) {
    terminal.open(terminalHost.value);
    fitTerminal();
    resizeObserver = new ResizeObserver(() => fitTerminal());
    resizeObserver.observe(terminalHost.value);
  }
  terminal.onData((data) => {
    void sendActiveTerminalInput(data);
  });
  if (activeProjectPath.value) void ws.startShellForProject(activeProjectPath.value);
  syncTerminalBuffer(true);
  themeObserver = new MutationObserver(syncTerminalTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
});

onBeforeUnmount(() => {
  disposeAdditionalTerminals();
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  themeObserver = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
});

watch(
  () => activeProjectPath.value,
  () => {
    disposeAdditionalTerminals();
    resetTerminalTabs();
    if (activeProjectPath.value) void ws.startShellForProject(activeProjectPath.value);
    syncTerminalBuffer(true);
  },
);

watch(
  () => [activeSessionId.value, activeBuffer.value],
  () => {
    syncTerminalBuffer(false);
  },
  { deep: true },
);

function syncTerminalBuffer(forceReset: boolean) {
  const sessionId = activeSessionId.value;
  const buffer = activeBuffer.value;
  if (!terminal) return;
  if (forceReset || sessionId !== lastSessionId || buffer.length < lastBufferLength) {
    terminal.clear();
    terminal.write(buffer);
  } else if (buffer.length > lastBufferLength) {
    terminal.write(buffer.slice(lastBufferLength));
  }
  lastSessionId = sessionId;
  lastBufferLength = buffer.length;
}

function resetTerminalTabs() {
  const sessionId = primarySessionId.value;
  terminalSerial = 1;
  terminalTabs.value = sessionId
    ? [{ id: sessionId, label: selectedProject.value?.name ?? "项目 shell", primary: true }]
    : [];
  activeTerminalId.value = sessionId;
}

function disposeAdditionalTerminals() {
  for (const tab of terminalTabs.value) {
    if (!tab.primary) void desktopApi.stopShellPty(tab.id).catch(() => undefined);
  }
}

async function startTerminal(tab: ProjectTerminalTab, forceRestart = false) {
  const path = activeProjectPath.value;
  if (!path) {
    void ws.chooseProject();
    return;
  }
  if (tab.primary) {
    await ws.startShellForProject(path, forceRestart);
    return;
  }
  if (ws.liveShellSessions.value[tab.id] && !forceRestart) return;
  if (forceRestart) {
    ws.shellBuffers.value = { ...ws.shellBuffers.value, [tab.id]: "" };
  }
  try {
    await desktopApi.startShellPty({ aiSessionId: tab.id, cwd: path });
    ws.liveShellSessions.value = { ...ws.liveShellSessions.value, [tab.id]: true };
  } catch (error) {
    ws.liveShellSessions.value = { ...ws.liveShellSessions.value, [tab.id]: false };
    ws.shellBuffers.value = { ...ws.shellBuffers.value, [tab.id]: `启动 shell 失败：${String(error)}\r\n` };
  }
}

async function createTerminal() {
  const path = activeProjectPath.value;
  if (!path) {
    void ws.chooseProject();
    return;
  }
  await ws.startShellForProject(path);
  terminalSerial += 1;
  const tab: ProjectTerminalTab = {
    id: `project-terminal:${path}:${Date.now()}:${terminalSerial}`,
    label: `${selectedProject.value?.name ?? "终端"} ${terminalSerial}`,
    primary: false,
  };
  terminalTabs.value = [...terminalTabs.value, tab];
  activeTerminalId.value = tab.id;
  await nextTick();
  syncTerminalBuffer(true);
  await startTerminal(tab);
  await fitTerminal();
}

function selectTerminal(tab: ProjectTerminalTab) {
  if (tab.id === activeSessionId.value) return;
  activeTerminalId.value = tab.id;
  void nextTick(() => {
    syncTerminalBuffer(true);
    void fitTerminal();
  });
}

async function sendActiveTerminalInput(data: string) {
  const tab = activeTerminalTab.value;
  if (!tab || !data) return;
  if (!ws.liveShellSessions.value[tab.id]) await startTerminal(tab);
  if (!ws.liveShellSessions.value[tab.id]) return;
  await desktopApi.sendShellInput({ aiSessionId: tab.id, text: data, submit: false });
}

function startActiveTerminal(forceRestart = false) {
  const tab = activeTerminalTab.value;
  if (!tab) {
    if (!activeProjectPath.value) void ws.chooseProject();
    return;
  }
  void startTerminal(tab, forceRestart);
}

async function fitTerminal() {
  await nextTick();
  if (!fitAddon || !terminal) return;
  try {
    fitAddon.fit();
    const dimensions = fitAddon.proposeDimensions();
    if (dimensions && activeSessionId.value) {
      await desktopApi.resizeShell({ aiSessionId: activeSessionId.value, cols: dimensions.cols, rows: dimensions.rows });
    }
  } catch {
    // xterm can throw while the tab is hidden; the next visible resize will fit again.
  }
}
</script>

<template>
  <div class="terminal-frame" :class="{ 'no-session': terminalState === 'no-session' }">
    <header class="chat-bottom-terminal-header">
      <div class="terminal-header-main">
        <img :src="terminalIcon" alt="" aria-hidden="true" />
        <strong>终端</strong>
        <div class="terminal-tabs">
          <button
            v-for="tab in terminalTabs"
            :key="tab.id"
            class="terminal-tab"
            :class="{ active: tab.id === activeSessionId }"
            type="button"
            @click="selectTerminal(tab)"
          >{{ tab.label }}</button>
          <button
            class="terminal-add-button"
            type="button"
            title="新建终端"
            aria-label="新建终端"
            @click="createTerminal"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <button class="chat-bottom-terminal-close" type="button" title="关闭终端" aria-label="关闭终端" @click="emit('close')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" />
        </svg>
      </button>
    </header>
    <div ref="terminalHost" class="terminal-view"></div>
    <div v-if="terminalState === 'no-session'" class="terminal-session-placeholder">
      <div class="terminal-session-placeholder-inner">
        <span class="terminal-placeholder-kicker">项目 shell</span>
        <h2>{{ selectedProject ? `在 ${selectedProject.name} 下运行命令` : "选择项目后打开 shell" }}</h2>
        <p>
          {{ selectedProject ? "终端页只提供干净的 shell，不会自动启动 Codex/Claude/OpenCode。" : "先选择一个本地项目，然后打开项目 shell。" }}
        </p>
        <div class="terminal-placeholder-actions">
          <button v-if="selectedProject" class="button primary narrow" type="button" @click="startActiveTerminal()">
            打开 shell
          </button>
          <button v-if="!selectedProject" class="button secondary narrow" type="button" @click="ws.chooseProject">
            选择项目
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="terminalState !== 'ready'" class="terminal-empty-state" :class="terminalState">
      <strong>{{ terminalNoticeTitle }}</strong>
      <span>{{ terminalNoticeText }}</span>
      <button v-if="terminalState === 'offline'" type="button" @click="startActiveTerminal()">
        启动 shell
      </button>
    </div>
  </div>
</template>
