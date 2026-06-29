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
const loading = ref(false);
const oauthLoading = ref(false);
const oauthStatus = ref("");
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
          <input v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
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
