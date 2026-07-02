<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useWorkspace } from "./composables/useWorkspace";
import { desktopApi, oauthApi } from "./services/desktop";
import router from "./router";

const ws = useWorkspace();
const checkingAuth = ref(true);
const authenticated = ref(false);
const email = ref("");
const password = ref("");
const showPassword = ref(false);
const rememberPassword = ref(false);
const loading = ref(false);
const oauthLoading = ref(false);
const oauthStatus = ref("");
const error = ref("");

onMounted(async () => {
  window.addEventListener("desktop-logout", handleLogout);
  try {
    const config = await desktopApi.getCloudConfig();
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
    const ok = await ws.loginDesktop(ws.settingsServer.value, email.value, password.value);
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

// 钉钉 OAuth 登录流程：
// 1. 调 /oauth/dingtalk/start 拿授权 URL + state
// 2. 调用 shell.openExternal 在系统浏览器打开
// 3. 启动轮询任务，每 2s 调 /oauth/dingtalk/poll，直到拿到结果或超时
async function loginWithDingTalk() {
  if (oauthLoading.value) return;
  oauthLoading.value = true;
  oauthStatus.value = "正在获取授权链接...";
  error.value = "";
  const serverUrl = ws.settingsServer.value;
  try {
    const startResp = await oauthApi.dingTalkStart(serverUrl);
    oauthStatus.value = "请在浏览器中扫码完成授权...";
    await desktopApi.openExternalUrl(startResp.authUrl);
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const poll = await oauthApi.dingTalkPoll(serverUrl, startResp.state);
      if (poll.status === "success" && poll.accessToken) {
        await desktopApi.saveOAuthLogin(
          serverUrl,
          poll.accessToken,
          poll.userId ?? "",
          poll.displayName ?? ""
        );
        oauthStatus.value = `已通过钉钉登录：${poll.displayName ?? "用户"}`;
        authenticated.value = true;
        return;
      }
      if (poll.status === "error") {
        throw new Error(poll.error || "钉钉登录失败");
      }
      if (poll.status === "expired") {
        throw new Error("授权超时，请重试");
      }
      // pending → 继续轮询
    }
    throw new Error("授权超时");
  } catch (err) {
    error.value = String(err);
    oauthStatus.value = "";
  } finally {
    oauthLoading.value = false;
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
  oauthStatus.value = "";
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
        <div class="desktop-login-divider"><span>或</span></div>
        <button
          class="desktop-login-oauth-button"
          type="button"
          :disabled="oauthLoading"
          @click="loginWithDingTalk"
        >
          <span class="desktop-login-oauth-icon" aria-hidden="true">钉</span>
          {{ oauthLoading ? "等待扫码..." : "钉钉扫码登录" }}
        </button>
        <p v-if="oauthStatus" class="desktop-login-oauth-status">{{ oauthStatus }}</p>
        <p class="desktop-login-hint">还没有账号？<span>立即注册</span></p>
      </form>
      <p class="desktop-login-version">v0.3.2</p>
    </section>
  </main>
  <router-view v-else />
</template>
