<script setup lang="ts">
import { ref } from "vue";
import { useWorkspace } from "../composables/useWorkspace";

const ws = useWorkspace();

const projectPath = ref("");
</script>

<template>
  <section class="view active" data-view-panel="projects">
    <header class="topbar">
      <div>
        <h1>项目</h1>
        <p>选择本机项目，然后创建新的 AI 会话。</p>
      </div>
      <button class="button primary narrow" type="button" @click="ws.chooseProject">选择本地项目</button>
    </header>
    <section class="workspace-grid two-columns">
      <article class="panel">
        <h2>添加项目</h2>
        <label>
          <span>项目目录</span>
          <input v-model="projectPath" placeholder="点击下方按钮选择本地项目目录" />
        </label>
        <div class="button-row">
          <button class="button primary narrow" type="button" @click="ws.chooseProject">打开文件夹选择器</button>
          <button class="button secondary narrow" type="button" @click="ws.addProject(projectPath)">手动添加路径</button>
        </div>
        <div class="result-box" :class="{ error: ws.projectResultError.value }">{{ ws.projectResult.value }}</div>
      </article>
      <article class="panel">
        <h2>项目列表</h2>
        <p class="hint-text">项目是主入口。聊天使用本地 AI 会话，终端页提供独立项目 shell。</p>
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
    </section>
  </section>
</template>
