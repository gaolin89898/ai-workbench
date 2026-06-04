<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ChatView from "./ChatView.vue";
import { useWorkspace } from "../composables/useWorkspace";

const ws = useWorkspace();
const route = useRoute();
const status = ref("正在加载会话...");

const targetSessionId = computed(() => {
  const id = route.params.id;
  if (Array.isArray(id)) return id[0] ?? "";
  return id ?? "";
});

const targetSession = computed(() => {
  return ws.aiSessions.value.find((session) => session.id === targetSessionId.value) ?? null;
});

async function prepare() {
  status.value = "正在加载会话...";
  try {
    await ws.refreshWorkspace();
    if (!ws.aiSessions.value.length) {
      status.value = "没有可用的 AI 会话。";
      return;
    }
    const session = ws.aiSessions.value.find((item) => item.id === targetSessionId.value);
    if (!session) {
      status.value = `未找到会话 ${targetSessionId.value.slice(0, 8)}。`;
      return;
    }
    await ws.setActiveAiSession(session);
    status.value = "已就绪";
  } catch (error) {
    status.value = `加载失败：${String(error)}`;
  }
}

onMounted(prepare);
watch(targetSessionId, prepare);
</script>

<template>
  <main class="session-window">
    <header class="session-window-header">
      <strong>{{ targetSession?.title ?? "AI 会话" }}</strong>
      <span>{{ status }}</span>
    </header>
    <section v-if="targetSession" class="session-window-body">
      <ChatView />
    </section>
    <section v-else class="session-window-empty">
      {{ status }}
    </section>
  </main>
</template>

<style scoped>
.session-window {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: #f8fafc;
}
.session-window-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e8f0;
  background: #ffffff;
  font-size: 13px;
}
.session-window-header strong {
  color: #0f172a;
}
.session-window-header span {
  color: #64748b;
  font-size: 12px;
}
.session-window-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}
.session-window-empty {
  flex: 1 1 auto;
  display: grid;
  place-items: center;
  color: #94a3b8;
  font-size: 14px;
}
</style>
