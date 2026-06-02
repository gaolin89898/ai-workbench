<script setup lang="ts">
import { computed } from "vue";
import { statusText } from "../utils/chat";
import { useWorkspace } from "../composables/useWorkspace";

const ws = useWorkspace();

const installedCount = computed(() => ws.providerStatuses.value.filter((item) => item.installed).length);
const visibleSessions = computed(() => (ws.showArchivedSessions.value ? ws.archivedSessions.value : ws.activeSessions.value));
const firstProject = computed(() => ws.projects.value[0]);
</script>

<template>
  <section class="view active" data-view-panel="workspace">
    <header class="topbar">
      <div>
        <h1>工作台首页</h1>
        <p>先选择本地项目，再创建 AI 会话。终端页只提供项目 shell。</p>
      </div>
      <div class="topbar-actions">
        <button class="button secondary" type="button" @click="ws.refreshWorkspace">刷新</button>
        <button class="button primary narrow" type="button" @click="ws.switchView('projects')">选择项目</button>
      </div>
    </header>
    <section class="metrics-grid">
      <article class="metric-card">
        <p>AI 工具</p>
        <strong>{{ ws.providerStatuses.value.length || ws.providers.value.length }}</strong>
        <span>{{ installedCount }} 个可用</span>
      </article>
      <article class="metric-card">
        <p>项目</p>
        <strong>{{ ws.projects.value.length }}</strong>
        <span>本地登记项目</span>
      </article>
      <article class="metric-card">
        <p>AI 会话</p>
        <strong>{{ ws.activeSessions.value.length }}</strong>
        <span>本机本地会话</span>
      </article>
    </section>
    <section class="workspace-grid">
      <article class="panel">
        <div class="panel-heading">
          <div>
            <h2>项目入口</h2>
            <p>每个项目都可以创建新的 AI 会话，并在聊天视图和项目 shell 之间切换。</p>
          </div>
        </div>
        <div class="compact-list">
          <div v-if="!ws.projects.value.length" class="empty-state">还没有项目。先添加本机项目目录，再创建 AI 会话。</div>
          <article v-for="project in ws.projects.value" :key="project.path" class="compact-row project-row">
            <div class="compact-main">
              <strong>{{ project.name }}</strong>
              <p>{{ project.path }}</p>
            </div>
            <div class="row-actions">
              <span class="badge" :class="project.gitDirty ? 'warning' : 'success'">{{ project.gitDirty ? "有变更" : "干净" }}</span>
              <button class="button secondary mini" type="button" @click="ws.prepareProjectSession(project.path, 'create')">创建 AI 会话</button>
            </div>
          </article>
        </div>
      </article>
      <aside class="side-panels">
        <article class="panel">
          <h2>AI 工具状态</h2>
          <div class="compact-list">
            <div v-if="!ws.providerStatuses.value.length && !ws.providers.value.length" class="empty-state">暂无 Provider。</div>
            <article v-for="status in ws.providerStatuses.value" :key="status.providerId" class="provider-card">
              <div>
                <strong>{{ ws.providers.value.find((provider) => provider.id === status.providerId)?.name ?? status.providerId }}</strong>
                <p>{{ status.version ?? ws.providers.value.find((provider) => provider.id === status.providerId)?.command ?? "未检测" }}</p>
              </div>
              <span class="badge" :class="status.installed ? 'success' : 'warning'">{{ status.installed ? "可用" : "未安装" }}</span>
            </article>
          </div>
        </article>
        <article class="panel">
          <div class="panel-section-heading compact">
            <h2>最近 AI 会话</h2>
            <button class="button secondary mini" :class="{ active: ws.showArchivedSessions.value }" type="button" @click="ws.showArchivedSessions.value = !ws.showArchivedSessions.value">
              已归档
            </button>
          </div>
          <div class="session-list">
            <div v-if="!visibleSessions.length" class="empty-state">{{ ws.showArchivedSessions.value ? "没有已归档会话。" : "还没有 AI 会话。" }}</div>
            <article
              v-for="session in visibleSessions"
              :key="session.id"
              class="session-card"
              :class="{ selected: ws.activeAiSession.value?.id === session.id }"
              @click="ws.setActiveAiSession(session)"
            >
              <div class="session-icon">AI</div>
              <div class="session-copy">
                <div class="session-title">
                  <strong>{{ session.title }}</strong>
                  <span>{{ ws.providers.value.find((provider) => provider.id === session.providerId)?.name ?? session.providerId }}</span>
                </div>
                <p>{{ session.summary ?? session.terminalSessionId ?? "本地 AI 会话" }}</p>
              </div>
              <div class="session-actions">
                <div class="session-state">
                  <span class="status-dot online"></span>
                  <span>{{ session.archivedAt ? "已归档" : statusText(session.status) }}</span>
                </div>
                <button class="button secondary mini" type="button" @click.stop="ws.archiveAiSession(session.id, !session.archivedAt)">
                  {{ session.archivedAt ? "恢复" : "归档" }}
                </button>
              </div>
            </article>
          </div>
        </article>
        <article class="panel">
          <h2>当前项目 Git 摘要</h2>
          <div class="result-box">
            {{
              firstProject
                ? `${firstProject.name} · ${firstProject.gitBranch ?? "未知分支"} · ${firstProject.gitDirty ? "有变更" : "Git 干净"}`
                : "添加项目后显示 Git 状态。"
            }}
          </div>
        </article>
      </aside>
    </section>
  </section>
</template>
