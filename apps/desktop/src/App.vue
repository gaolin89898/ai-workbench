<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useWorkspace } from "./composables/useWorkspace";
import { desktopApi } from "./services/desktop";
import router from "./router";

const ws = useWorkspace();
const checkingAuth = ref(true);
const authenticated = ref(false);
const serverInput = ref("");
const email = ref("");
const password = ref("");
const showPassword = ref(false);
const rememberPassword = ref(false);
const loading = ref(false);
const error = ref("");
const serverStorageKey = "ai-workbench.serverUrl";

function persistServerUrl(value: string) {
  const trimmed = value.trim();
  ws.settingsServer.value = trimmed;
  try {
    if (trimmed) {
      window.localStorage.setItem(serverStorageKey, trimmed);
    } else {
      window.localStorage.removeItem(serverStorageKey);
    }
  } catch {
    /* ignore localStorage errors */
  }
}

watch(serverInput, (next) => {
  persistServerUrl(next);
});

onMounted(async () => {
  window.addEventListener("desktop-logout", handleLogout);
  try {
    const storedServer = window.localStorage.getItem(serverStorageKey) || "";
    if (storedServer) {
      serverInput.value = storedServer;
      ws.settingsServer.value = storedServer.trim();
    }
  } catch {
    /* ignore localStorage errors */
  }
  try {
    const config = await desktopApi.getCloudConfig();
    if (config?.serverUrl) {
      serverInput.value = config.serverUrl;
      persistServerUrl(config.serverUrl);
    }
    authenticated.value = Boolean(config?.paired && config.authMode === "desktop-login");
    if (!authenticated.value) {
      const saved = await desktopApi.loadCredentials();
      if (saved) {
        email.value = saved.email;
        password.value = saved.password;
        rememberPassword.value = true;
      }
    }
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
    const ok = await ws.loginDesktop(serverInput.value, email.value, password.value);
    if (ok) {
      if (rememberPassword.value) {
        await desktopApi.saveCredentials(email.value, password.value);
      } else {
        await desktopApi.clearCredentials();
      }
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
  rememberPassword.value = false;
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
          <span>服务器地址</span>
          <input v-model="serverInput" type="text" autocomplete="url" placeholder="请输入服务器地址" />
        </label>
        <label class="desktop-login-field">
          <span>账号</span>
          <input v-model="email" type="email" autocomplete="username" placeholder="请输入账号" />
        </label>
        <label class="desktop-login-field">
          <span>密码</span>
          <div class="desktop-login-password-input">
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="请输入密码"
            />
            <button
              type="button"
              class="desktop-login-password-toggle"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <svg v-if="showPassword" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                <path d="M9.9 4.4A9.8 9.8 0 0 1 12 4c5 0 8.3 4.2 9.5 6a2.5 2.5 0 0 1 0 2.1 14.4 14.4 0 0 1-2.1 2.7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M6.4 6.4A14.1 14.1 0 0 0 2.5 10a2.5 2.5 0 0 0 0 2.1C3.7 13.8 7 18 12 18c1.2 0 2.3-.2 3.3-.7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M2.5 10.9a2.5 2.5 0 0 0 0 2.2C3.7 14.9 7 19 12 19s8.3-4.1 9.5-5.9a2.5 2.5 0 0 0 0-2.2C20.3 9.1 17 5 12 5s-8.3 4.1-9.5 5.9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" />
              </svg>
            </button>
          </div>
        </label>
        <label class="desktop-login-remember">
          <input type="checkbox" v-model="rememberPassword" />
          <span>记住密码</span>
        </label>
        <p v-if="error" class="desktop-login-error">{{ error }}</p>
        <button class="desktop-login-button" type="submit" :disabled="loading">
          {{ loading ? "登录中..." : "登录" }}
        </button>
        <p class="desktop-login-hint">登录及注册</p>
      </form>
    </section>
  </main>
  <router-view v-else />
</template>
