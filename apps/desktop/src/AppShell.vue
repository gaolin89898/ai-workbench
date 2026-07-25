<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import SidebarProjectTree from "./components/SidebarProjectTree.vue";
import { useWorkspace } from "./composables/useWorkspace";
import type { ViewName } from "./services/desktop";

const ws = useWorkspace();
const route = useRoute();
const UPDATE_NOTICE_INTERVAL_MS = 5 * 60 * 1000;
const PROVIDER_DETECT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let updateNoticeTimer: ReturnType<typeof window.setInterval> | null = null;
let providerDetectTimer: ReturnType<typeof window.setInterval> | null = null;

const activeView = computed<ViewName>(() => {
  const name = route.name;
  if (name === "workspace" || name === "projects" || name === "resources" || name === "aiSessions") {
    return name;
  }
  return "aiSessions";
});
const isFullscreenRoute = computed(() => route.name === "settings");

const pinnedSessionIdsRecord = computed<Record<string, boolean>>(() => {
  const record: Record<string, boolean> = {};
  for (const id of ws.pinnedSessionIds.value) record[id] = true;
  return record;
});
const unreadSessionIdsRecord = computed<Record<string, boolean>>(() => {
  const record: Record<string, boolean> = {};
  for (const id of ws.unreadSessionIds.value) record[id] = true;
  return record;
});

onMounted(() => {
  ws.refreshWorkspace().catch((error) => {
    ws.chatMessages.value = [{ role: "error", text: `初始化失败：${String(error)}` }];
  });
  void ws.refreshAppUpdateNotice();
  updateNoticeTimer = window.setInterval(() => {
    void ws.refreshAppUpdateNotice();
  }, UPDATE_NOTICE_INTERVAL_MS);
  providerDetectTimer = window.setInterval(() => {
    void ws.detectProviders();
  }, PROVIDER_DETECT_INTERVAL_MS);
});

onUnmounted(() => {
  if (updateNoticeTimer) {
    window.clearInterval(updateNoticeTimer);
    updateNoticeTimer = null;
  }
  if (providerDetectTimer) {
    window.clearInterval(providerDetectTimer);
    providerDetectTimer = null;
  }
});
</script>

<template>
  <main class="app-shell" :class="{ fullscreen: isFullscreenRoute }">
    <SidebarProjectTree
      v-if="!isFullscreenRoute"
      :projects="ws.projects.value"
      :providers="ws.providers.value"
      :terminal-sessions="ws.terminalSessions.value"
      :active-sessions="ws.activeSessions.value"
      :active-ai-session="ws.activeAiSession.value"
      :provider-statuses="ws.providerStatuses.value"
      :app-update-available-version="ws.updateAvailableVersion.value"
      :selected-project-path="ws.selectedProjectPath.value"
      :thinking-session-ids="ws.thinkingSessionIds.value"
      :pinned-session-ids="pinnedSessionIdsRecord"
      :unread-session-ids="unreadSessionIdsRecord"
      :active-view="activeView"
      @choose-project="ws.chooseProject"
      @select-project="ws.selectProjectPath"
      @new-chat="ws.resetChatControlsForNewSession"
      @create-session="ws.createAiSessionForProject"
      @attach-session="ws.attachAiSessionForProject"
      @select-session="ws.setActiveAiSession"
      @archive-session="ws.archiveAiSession"
      @delete-session="ws.deleteAiSession"
      @rename-session="(session, title) => ws.renameAiSession(session, title)"
      @toggle-pin-session="(session) => ws.toggleSessionPinned(session.id)"
      @mark-session-unread="(session) => ws.markSessionUnread(session.id)"
      @derive-session="(session) => ws.deriveSessionToLocal(session)"
      @open-session-in-new-window="(session) => ws.openAiSessionInNewWindow(session)"
      @rename-project="(project, name) => ws.renameProject(project, name)"
      @remove-project="(project) => ws.removeProject(project)"
      @open-in-file-manager="(project) => ws.openProjectInFileManager(project)"
      @switch-view="ws.switchView"
    />
    <section class="content">
      <router-view />
    </section>
  </main>
</template>
