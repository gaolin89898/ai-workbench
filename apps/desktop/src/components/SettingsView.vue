<script setup lang="ts">
import { ref, watch } from "vue";
import { useWorkspace } from "../composables/useWorkspace";

type SettingsPanel = "connection" | "security" | "pairing" | "debug";

const ws = useWorkspace();

const localServer = ref(ws.settingsServer.value);
const settingsPanel = ref<SettingsPanel>("connection");
const pairingCode = ref("");
const deviceName = ref("gl-H610M");
const historyDb = ref("~/.ai-workbench/history.db");
const riskGuard = ref(true);
const commandLog = ref(true);
const localHistory = ref(true);
const autoReconnect = ref(true);
const terminalDebug = ref(true);

watch(() => ws.settingsServer.value, (next) => {
  localServer.value = next;
});

watch(localServer, (next) => {
  ws.settingsServer.value = next;
});
</script>

<template>
  <main class="app-fullscreen">
    <section class="view active settings-page" data-view-panel="settings">
      <aside class="settings-nav">
        <button class="settings-back-button" type="button" @click="ws.switchView('aiSessions')">← 返回首页</button>
        <nav class="settings-nav-list" aria-label="设置分组">
          <button :class="{ active: settingsPanel === 'connection' }" type="button" @click="settingsPanel = 'connection'">连接</button>
          <button :class="{ active: settingsPanel === 'security' }" type="button" @click="settingsPanel = 'security'">安全与历史</button>
          <button :class="{ active: settingsPanel === 'pairing' }" type="button" @click="settingsPanel = 'pairing'">设备配对</button>
          <button :class="{ active: settingsPanel === 'debug' }" type="button" @click="settingsPanel = 'debug'">调试入口</button>
        </nav>
      </aside>

      <div class="settings-content">
        <div class="settings-scroll">
          <header class="settings-header">
            <div>
              <h1>设置</h1>
              <p>配置连接、安全保护、设备配对和本机历史。</p>
            </div>
            <button class="button primary narrow" type="button" @click="ws.saveSettings">保存设置</button>
          </header>

          <section v-if="settingsPanel === 'connection'" class="settings-section">
            <h2 class="settings-section-title">连接</h2>
            <p class="settings-section-description">这里控制桌面端与云端、移动端、本机历史的基础连接信息。</p>
            <div class="settings-card">
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>服务器地址</strong>
                  <small>桌面端配对和移动端转发使用的云端地址</small>
                </span>
                <input v-model="localServer" class="settings-input" />
              </label>
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>设备名称</strong>
                  <small>移动端设备列表里显示的桌面名称</small>
                </span>
                <input v-model="deviceName" class="settings-input" />
              </label>
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>本地历史</strong>
                  <small>完整聊天记录默认只保存在这台电脑</small>
                </span>
                <input v-model="historyDb" class="settings-input" />
              </label>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'security'" class="settings-section">
            <h2 class="settings-section-title">安全与历史</h2>
            <p class="settings-section-description">这些选项用于控制高危操作确认、命令摘要和本机历史保留方式。</p>
            <div class="settings-card">
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>风险保护</strong>
                  <small>高危命令需要确认</small>
                </span>
                <input v-model="riskGuard" class="settings-switch" type="checkbox" />
              </label>
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>命令日志</strong>
                  <small>记录命令摘要和风险结果</small>
                </span>
                <input v-model="commandLog" class="settings-switch" type="checkbox" />
              </label>
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>完整历史</strong>
                  <small>聊天内容默认只保存在桌面本机</small>
                </span>
                <input v-model="localHistory" class="settings-switch" type="checkbox" />
              </label>
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>自动重连</strong>
                  <small>断线后恢复移动端和桌面连接</small>
                </span>
                <input v-model="autoReconnect" class="settings-switch" type="checkbox" />
              </label>
            </div>
          </section>

          <section v-else-if="settingsPanel === 'pairing'" class="settings-section">
            <h2 class="settings-section-title">设备配对</h2>
            <p class="settings-section-description">在这里把当前桌面绑定到移动端账号。配对成功后，移动端可以看到这台桌面并控制 AI 会话。</p>
            <div class="settings-card settings-form-card">
              <label class="settings-field">
                <span>服务器地址</span>
                <input v-model="localServer" class="settings-field-input" />
              </label>
              <label class="settings-field">
                <span>配对码</span>
                <input v-model="pairingCode" class="settings-field-input" placeholder="A7K9Q2LM" maxlength="16" />
              </label>
              <button class="button primary" type="button" @click="ws.pairDesktop(localServer, pairingCode)">配对这台桌面</button>
              <div class="settings-pair-result" :class="{ error: ws.pairResultError.value }">{{ ws.pairResult.value }}</div>
            </div>
          </section>

          <section v-else class="settings-section">
            <h2 class="settings-section-title">调试入口</h2>
            <p class="settings-section-description">这些入口主要用于排查 Provider 检测和本地 PTY 承载状态。</p>
            <div class="settings-card">
              <label class="settings-row">
                <span class="settings-row-copy">
                  <strong>底层终端</strong>
                  <small>保留本地 PTY 调试信息</small>
                </span>
                <input v-model="terminalDebug" class="settings-switch" type="checkbox" />
              </label>
              <div class="settings-row">
                <span class="settings-row-copy">
                  <strong>Provider 检测</strong>
                  <small>检测 Codex、Claude、Gemini、DeepSeek</small>
                </span>
                <span class="settings-pill">自动检测</span>
              </div>
            </div>
          </section>

          <div class="settings-result">{{ ws.settingsResult.value }}</div>
        </div>
      </div>
    </section>
  </main>
</template>
