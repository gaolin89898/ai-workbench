<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWorkspace } from "../composables/useWorkspace";
import type { AiProvider } from "../services/tauri";

const ws = useWorkspace();
const terminalHost = ref<HTMLDivElement | null>(null);
const activeSessionId = computed(() => ws.activeAiSession.value?.id ?? "");
const selectedProject = computed(() => ws.projects.value.find((project) => project.path === ws.selectedProjectPath.value) ?? null);
const fallbackProvider: AiProvider = { id: "codex", name: "Codex", command: "codex", builtIn: true, enabled: true };
const providerChoices = computed(() => ws.providers.value.length ? ws.providers.value : [fallbackProvider]);
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
  if (terminalState.value === "no-session") return "还没有选择 AI 会话";
  if (terminalState.value === "checking") return "正在检查项目 shell";
  if (terminalState.value === "offline") return "这个 shell 没有运行";
  if (terminalState.value === "waiting") return "正在等待终端输出";
  return "";
});
const terminalNoticeText = computed(() => {
  if (terminalState.value === "no-session") return "先在左侧选择项目，然后创建一个会话。";
  if (terminalState.value === "checking") return "桌面端正在确认这个项目的 shell 是否已经启动。";
  if (terminalState.value === "offline") return "历史聊天还在，但这个项目 shell 没有运行。可以重新启动 shell。";
  if (terminalState.value === "waiting") return "shell 已启动，等待输出。";
  return "";
});

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let lastSessionId = "";
let lastBufferLength = 0;

onMounted(() => {
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
    theme: {
      background: "#202424",
      foreground: "#f3f4f6",
      cursor: "#d7dde2",
      selectionBackground: "#414747",
      black: "#151819",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#38bdf8",
      magenta: "#c084fc",
      cyan: "#2dd4bf",
      white: "#e5e7eb",
      brightBlack: "#7b858b",
      brightRed: "#f87171",
      brightGreen: "#22c55e",
      brightYellow: "#facc15",
      brightBlue: "#38bdf8",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#f8fafc",
    },
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
    ws.sendShellInput(data).catch(() => undefined);
  });
  void ws.startShellForActiveSession();
  syncTerminalBuffer(true);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
});

watch(
  () => [activeSessionId.value, activeBuffer.value],
  () => {
    void ws.startShellForActiveSession();
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

function createSession(providerId?: string) {
  const path = selectedProject.value?.path;
  if (!path) {
    void ws.chooseProject();
    return;
  }
  void ws.createAiSessionForProject(path, providerId ?? providerChoices.value[0]?.id ?? "codex");
}

async function fitTerminal() {
  await nextTick();
  if (!fitAddon || !terminal) return;
  try {
    fitAddon.fit();
    const dimensions = fitAddon.proposeDimensions();
    if (dimensions) {
      await ws.resizeShell(dimensions.cols, dimensions.rows);
    }
  } catch {
    // xterm can throw while the tab is hidden; the next visible resize will fit again.
  }
}
</script>

<template>
  <div class="terminal-frame" :class="{ 'no-session': terminalState === 'no-session' }">
    <div ref="terminalHost" class="terminal-view"></div>
    <button
      v-if="terminalState === 'ready'"
      class="terminal-restart-button"
      type="button"
      @click="ws.restartShellForActiveSession"
    >
      重启 shell
    </button>
    <div v-if="terminalState === 'no-session'" class="terminal-session-placeholder">
      <div class="terminal-session-placeholder-inner">
        <span class="terminal-placeholder-kicker">项目 shell</span>
        <h2>{{ selectedProject ? `在 ${selectedProject.name} 下运行命令` : "选择项目后打开 shell" }}</h2>
        <p>
          {{ selectedProject ? "终端页只提供干净的 shell，不会自动启动 Codex/Claude/Gemini/DeepSeek。" : "先选择一个本地项目，然后打开项目 shell。" }}
        </p>
        <div class="terminal-placeholder-actions">
          <button
            v-for="provider in providerChoices"
            :key="provider.id"
            class="button primary narrow"
            type="button"
            @click="createSession(provider.id)"
          >
            新建 {{ provider.name }}
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
      <button v-if="terminalState === 'offline'" type="button" @click="ws.startShellForActiveSession">
        启动 shell
      </button>
    </div>
  </div>
</template>
