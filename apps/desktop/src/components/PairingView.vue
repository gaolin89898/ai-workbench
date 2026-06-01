<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  server: string;
  pairResult: string;
  pairResultError: boolean;
}>();

const emit = defineEmits<{
  "update:server": [value: string];
  pairDesktop: [server: string, code: string];
}>();

const localServer = ref(props.server);
const code = ref("");

watch(
  () => props.server,
  (next) => {
    localServer.value = next;
  },
);

watch(localServer, (next) => emit("update:server", next));
</script>

<template>
  <section class="view active" data-view-panel="pairing">
    <header class="topbar">
      <div>
        <h1>设备配对</h1>
        <p>绑定当前桌面到移动端账号。移动端可远程控制 AI 会话。</p>
      </div>
    </header>
    <section class="workspace-grid two-columns">
      <article class="panel pairing-card">
        <h2>配对当前桌面</h2>
        <label>
          <span>服务器地址</span>
          <input v-model="localServer" />
        </label>
        <label>
          <span>配对码</span>
          <input v-model="code" placeholder="A7K9Q2LM" maxlength="16" />
        </label>
        <button class="button primary" type="button" @click="emit('pairDesktop', localServer, code)">配对这台桌面</button>
        <div class="result-box large" :class="{ error: pairResultError }">{{ pairResult }}</div>
      </article>
      <article class="panel">
        <h2>同步策略</h2>
        <dl class="detail-list">
          <div><dt>云端</dt><dd>只保存元信息和摘要</dd></div>
          <div><dt>完整历史</dt><dd>本机 SQLite</dd></div>
          <div><dt>移动端历史</dt><dd>桌面在线时拉取</dd></div>
          <div><dt>底层承载</dt><dd>tmux / screen</dd></div>
        </dl>
      </article>
    </section>
  </section>
</template>
