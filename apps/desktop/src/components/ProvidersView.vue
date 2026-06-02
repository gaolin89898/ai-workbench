<script setup lang="ts">
import { useWorkspace } from "../composables/useWorkspace";

const ws = useWorkspace();
</script>

<template>
  <section class="view active" data-view-panel="providers">
    <header class="topbar">
      <div>
        <h1>AI 工具</h1>
        <p>检测本机 AI CLI/TUI，配置内置和自定义 Provider。</p>
      </div>
      <button class="button secondary" type="button" @click="ws.detectProviders">重新检测</button>
    </header>
    <article class="panel">
      <div class="provider-grid">
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
  </section>
</template>
