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

// GitHub OAuth polling state.
const githubLoading = ref(false);
let githubPollTimer: ReturnType<typeof setInterval> | null = null;

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
    const savedTheme = window.localStorage.getItem("ai-workbench-theme") === "dark" ? "dark" : "light";
    document.documentElement.classList.toggle("theme-dark", savedTheme === "dark");
    document.body.classList.toggle("theme-dark", savedTheme === "dark");
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
  if (githubPollTimer) clearInterval(githubPollTimer);
  if (googlePollTimer) clearInterval(googlePollTimer);
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

// loginWithGithub starts the GitHub OAuth flow: asks the backend for an
// authorize URL, opens it in the system browser, then polls until the user
// finishes authorization. On success it persists the cloud config (device
// pairing token returned by the desktop OAuth flow).
async function loginWithGithub() {
  if (!serverInput.value.trim()) {
    error.value = "请先填写服务器地址";
    return;
  }
  githubLoading.value = true;
  error.value = "";
  try {
    const { authorizeUrl, state } = await desktopApi.githubLoginStart(serverInput.value, true);
    await desktopApi.openExternalUrl(authorizeUrl);
    githubPollTimer = setInterval(async () => {
      try {
        const result = await desktopApi.githubLoginPoll(serverInput.value, state);
        if (result.status === "done" && result.accessToken) {
          if (githubPollTimer) {
            clearInterval(githubPollTimer);
            githubPollTimer = null;
          }
          githubLoading.value = false;
          authenticated.value = true;
        } else if (result.status === "error") {
          if (githubPollTimer) {
            clearInterval(githubPollTimer);
            githubPollTimer = null;
          }
          githubLoading.value = false;
          error.value = result.error || "GitHub 登录失败";
        }
      } catch {
        // network blip — keep polling
      }
    }, 1500);
  } catch (err) {
    githubLoading.value = false;
    error.value = String(err);
  }
}

// Google OAuth polling state.
const googleLoading = ref(false);
let googlePollTimer: ReturnType<typeof setInterval> | null = null;

// loginWithGoogle starts the Google OAuth flow, mirroring loginWithGithub.
async function loginWithGoogle() {
  if (!serverInput.value.trim()) {
    error.value = "请先填写服务器地址";
    return;
  }
  googleLoading.value = true;
  error.value = "";
  try {
    const { authorizeUrl, state } = await desktopApi.googleLoginStart(serverInput.value, true);
    await desktopApi.openExternalUrl(authorizeUrl);
    googlePollTimer = setInterval(async () => {
      try {
        const result = await desktopApi.googleLoginPoll(serverInput.value, state);
        if (result.status === "done" && result.accessToken) {
          if (googlePollTimer) {
            clearInterval(googlePollTimer);
            googlePollTimer = null;
          }
          googleLoading.value = false;
          authenticated.value = true;
        } else if (result.status === "error") {
          if (googlePollTimer) {
            clearInterval(googlePollTimer);
            googlePollTimer = null;
          }
          googleLoading.value = false;
          error.value = result.error || "Google 登录失败";
        }
      } catch {
        // network blip - keep polling
      }
    }, 1500);
  } catch (err) {
    googleLoading.value = false;
    error.value = String(err);
  }
}

function handleLogout() {
  authenticated.value = false;
  email.value = "";
  password.value = "";
  rememberPassword.value = false;
  error.value = "";
  if (githubPollTimer) {
    clearInterval(githubPollTimer);
    githubPollTimer = null;
  }
  githubLoading.value = false;
  if (router.currentRoute.value.path !== "/chat") {
    void router.replace("/chat");
  }
}
</script>

<template>
  <div v-if="checkingAuth" class="boot-loading">正在启动 CodeHub AI...</div>
  <main v-else-if="!authenticated" class="desktop-login-page">
    <!-- 左侧:品牌展示区 -->
    <section class="desktop-login-showcase">
      <div class="desktop-login-showcase-bg" aria-hidden="true">
        <div class="desktop-login-grid"></div>
        <div class="desktop-login-glow desktop-login-glow-tr"></div>
        <div class="desktop-login-glow desktop-login-glow-bl"></div>
        <div class="desktop-login-accent desktop-login-accent-v"></div>
        <div class="desktop-login-accent desktop-login-accent-h"></div>
      </div>
      <div class="desktop-login-showcase-content">
        <div class="desktop-login-brand-row">
          <div class="desktop-login-logo">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 5l6 6-6 6M12 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <span class="desktop-login-brand-name">CodeHub AI</span>
        </div>
        <h1 class="desktop-login-tagline">桌面端 AI 编程助手</h1>
        <div class="desktop-login-features">
          <div class="desktop-login-feature">
            <div class="desktop-login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="desktop-login-feature-text">
              <p class="desktop-login-feature-title">智能代码生成</p>
              <p class="desktop-login-feature-desc">基于多模型推理，精准理解意图，自动生成高质量代码</p>
            </div>
          </div>
          <div class="desktop-login-feature">
            <div class="desktop-login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 3l9 5-9 5-9-5 9-5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                <path d="M3 13l9 5 9-5M3 17l9 5 9-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="desktop-login-feature-text">
              <p class="desktop-login-feature-title">多模型支持</p>
              <p class="desktop-login-feature-desc">Codex、Claude、OpenCode 等主流模型无缝切换</p>
            </div>
          </div>
          <div class="desktop-login-feature">
            <div class="desktop-login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="desktop-login-feature-text">
              <p class="desktop-login-feature-title">安全本地运行</p>
              <p class="desktop-login-feature-desc">数据不离设备，全本地推理，隐私安全有保障</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 右侧:登录表单区 -->
    <section class="desktop-login-panel">
      <div class="desktop-login-panel-inner">
        <div class="desktop-login-header">
          <h2 class="desktop-login-title">登录到 CodeHub AI</h2>
          <p class="desktop-login-subtitle">输入你的账号信息以继续</p>
        </div>
        <form class="desktop-login-form" @submit.prevent="login">
          <label class="desktop-login-field">
            <span>服务器地址</span>
            <div class="desktop-login-input-wrap">
              <span class="desktop-login-input-icon">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
                  <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </span>
              <input v-model="serverInput" type="text" autocomplete="url" placeholder="请输入服务器地址" class="desktop-login-input" />
            </div>
          </label>
          <label class="desktop-login-field">
            <span>账号</span>
            <div class="desktop-login-input-wrap">
              <span class="desktop-login-input-icon">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/>
                  <path d="M4 20c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <input v-model="email" type="text" autocomplete="username" placeholder="请输入账号" class="desktop-login-input" />
            </div>
          </label>
          <label class="desktop-login-field">
            <span>密码</span>
            <div class="desktop-login-input-wrap">
              <span class="desktop-login-input-icon">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2"/>
                  <path d="M8 11V7a4 4 0 1 1 8 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </span>
              <input
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="请输入密码"
                class="desktop-login-input"
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
          <div class="desktop-login-options">
            <label class="desktop-login-remember">
              <input type="checkbox" v-model="rememberPassword" />
              <span>记住密码</span>
            </label>
            <a class="desktop-login-forgot" href="#" @click.prevent>忘记密码？</a>
          </div>
          <p v-if="error" class="desktop-login-error">{{ error }}</p>
          <button class="desktop-login-button" type="submit" :disabled="loading">
            {{ loading ? "登录中..." : "登录" }}
          </button>
          <div class="desktop-login-divider">
            <span>或</span>
          </div>
          <div class="desktop-login-oauth">
            <button
              type="button"
              class="desktop-login-oauth-button desktop-login-github-button"
              :disabled="githubLoading"
              @click="loginWithGithub"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="github-icon">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              <span>{{ githubLoading ? "等待授权..." : "GitHub" }}</span>
            </button>
            <button
              type="button"
              class="desktop-login-oauth-button desktop-login-google-button"
              @click="loginWithGoogle"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              <span>Google</span>
            </button>
          </div>
          <p class="desktop-login-signup">登录及注册</p>
        </form>
      </div>
    </section>
  </main>
  <router-view v-else />
</template>
