<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useWorkspace } from "./composables/useWorkspace";
import { desktopApi } from "./services/desktop";
import router from "./router";

const ws = useWorkspace();
const checkingAuth = ref(true);
const authenticated = ref(false);
const email = ref("");
const password = ref("");
const loading = ref(false);
const error = ref("");

onMounted(async () => {
  window.addEventListener("desktop-logout", handleLogout);
  try {
    const config = await desktopApi.getCloudConfig();
    authenticated.value = Boolean(config?.paired && config.authMode === "desktop-login");
  } catch {
    authenticated.value = false;
  } finally {
    checkingAuth.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener("desktop-logout", handleLogout);
});

async function login() {
  loading.value = true;
  error.value = "";
  try {
    const ok = await ws.loginDesktop(ws.settingsServer.value, email.value, password.value);
    if (ok) {
      password.value = "";
      authenticated.value = true;
    } else {
      error.value = ws.pairResult.value;
    }
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}

// handleLogout responds to the "desktop-logout" window event dispatched by
// SettingsView after the IPC logout call returns. It resets the local auth
// state so the login page is shown again.
function handleLogout() {
  authenticated.value = false;
  email.value = "";
  password.value = "";
  error.value = "";
  // Reset to the default route so the next login starts at the workspace.
  if (router.currentRoute.value.path !== "/chat") {
    void router.replace("/chat");
  }
}
</script>

<template>
  <div v-if="checkingAuth" class="boot-loading">正在启动 AI 工作台...</div>
  <main v-else-if="!authenticated" class="desktop-login-page">
    <section class="desktop-login-card">
      <div class="desktop-login-brand">
        <div class="desktop-login-icon" aria-hidden="true">⌘</div>
        <h1>AI 工作台</h1>
        <p>桌面端 AI 编程助手</p>
      </div>
      <form class="desktop-login-form" @submit.prevent="login">
        <label class="desktop-login-field">
          <span>账号</span>
          <input v-model="email" type="email" autocomplete="username" placeholder="请输入账号" />
        </label>
        <label class="desktop-login-field">
          <span>密码</span>
          <input v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
        </label>
        <p v-if="error" class="desktop-login-error">{{ error }}</p>
        <button class="desktop-login-button" type="submit" :disabled="loading">
          {{ loading ? "登录中..." : "登录" }}
        </button>
        <p class="desktop-login-hint">还没有账号？<span>立即注册</span></p>
      </form>
      <p class="desktop-login-version">v0.3.2</p>
    </section>
  </main>
  <router-view v-else />
</template>
