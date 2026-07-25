<script setup lang="ts">
import { computed, onMounted, reactive, ref, type Component } from "vue";
import {
  IconCheckCircle,
  IconClockCircle,
  IconDesktop,
  IconEdit,
  IconFile,
  IconLock,
  IconMobile,
  IconRefresh,
  IconSearch,
  IconSafe,
  IconUser,
  IconUserGroup,
} from "@arco-design/web-vue/es/icon";
import { Message } from "@arco-design/web-vue";

type UserStatus = "online" | "offline";

type SystemUserRecord = {
  id: string;
  account: string;
  email: string;
  displayName: string;
  authMode: string;
  status: UserStatus;
  disabled: boolean;
  desktopDeviceCount: number;
  onlineDesktopCount: number;
  mobileDeviceCount: number;
  onlineMobileCount: number;
  lastDesktopSeenAt: string | null;
  lastMobileSeenAt: string | null;
  latestSeenAt: string | null;
  createdAt: string;
};

type UserDevice = {
  id: string;
  name: string;
  os: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
};

type DeviceSession = {
  id: string;
  title: string;
  providerId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type AdminSection = "users" | "releases";
type ReleasePlatform = "desktop" | "mobile";

type AppReleaseRecord = {
  platform: "desktop" | "mobile";
  latestVersion: string;
  minSupportedVersion: string | null;
  downloadUrl: string | null;
  windowsDownloadUrl: string | null;
  linuxDownloadUrl: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  force: boolean;
  enabled: boolean;
  source: string;
  updatedAt: string;
};

const token = ref(localStorage.getItem("user-admin-token") ?? "");
const activeSection = ref<AdminSection>("users");
const releasePlatforms: ReleasePlatform[] = ["desktop", "mobile"];
const authLoading = ref(false);
const pageLoading = ref(false);
const actionLoading = ref(false);
const editModalVisible = ref(false);
const passwordModalVisible = ref(false);
const deleteModalVisible = ref(false);
const drawerVisible = ref(false);
const activeUser = ref<SystemUserRecord | null>(null);
const userDevices = ref<UserDevice[]>([]);
const devicesLoading = ref(false);
const editingDeviceId = ref<string | null>(null);
const editingDeviceName = ref("");
const activeDevice = ref<UserDevice | null>(null);
const deviceSessions = ref<DeviceSession[]>([]);
const sessionsLoading = ref(false);
const loginForm = reactive({
  email: "admin",
  password: "070900gl",
});
const editForm = reactive({
  account: "",
  displayName: "",
});
const passwordForm = reactive({
  password: "",
  confirmPassword: "",
});
const users = ref<SystemUserRecord[]>([]);
const releases = ref<Record<ReleasePlatform, AppReleaseRecord>>({
  desktop: emptyRelease("desktop"),
  mobile: emptyRelease("mobile"),
});
const releaseForms = reactive<Record<ReleasePlatform, {
  latestVersion: string;
  minSupportedVersion: string;
  downloadUrl: string;
  windowsDownloadUrl: string;
  linuxDownloadUrl: string;
  releaseUrl: string;
  releaseNotes: string;
  force: boolean;
  enabled: boolean;
}>>({
  desktop: emptyReleaseForm(),
  mobile: emptyReleaseForm(),
});
const releasesLoading = ref(false);
const releaseSaving = ref<Record<ReleasePlatform, boolean>>({ desktop: false, mobile: false });

const filters = reactive({
  keyword: "",
});

const columns = [
  { title: "系统账号", slotName: "user", width: 260 },
  { title: "登录方式", slotName: "authMode", width: 120 },
  { title: "桌面端", slotName: "desktop", width: 170 },
  { title: "移动端", slotName: "mobile", width: 170 },
  { title: "状态", slotName: "status", width: 110 },
  { title: "最近活跃", slotName: "latestSeenAt", width: 180 },
  { title: "注册时间", slotName: "createdAt", width: 180 },
  { title: "用户 ID", slotName: "id", width: 250 },
  { title: "操作", slotName: "actions", width: 280, fixed: "right" as const },
];

const statusMeta: Record<UserStatus, { text: string; color: string; icon: Component }> = {
  online: { text: "在线", color: "green", icon: IconCheckCircle },
  offline: { text: "离线", color: "gray", icon: IconClockCircle },
};

const isAuthenticated = computed(() => Boolean(token.value));

const filteredUsers = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase();
  if (!keyword) return users.value;
  return users.value.filter((user) =>
    [user.account, user.email, user.displayName, user.id].some((value) =>
      (value || "").toLowerCase().includes(keyword)
    )
  );
});

onMounted(() => {
  if (token.value) {
    void fetchUsers();
    void fetchReleases();
  }
});

async function requestAPI<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token.value) {
    headers.set("Authorization", `Bearer ${token.value}`);
  }
  const response = await fetch(`/api${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.error ?? `请求失败：${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function formatDate(value: string | null) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function onlineCountText(onlineCount: number, deviceCount: number) {
  const normalizedDeviceCount = Math.max(deviceCount, onlineCount);
  return `${onlineCount} / ${normalizedDeviceCount} 在线`;
}

function formatMobileLastSeen(record: SystemUserRecord) {
  if (!record.lastMobileSeenAt && record.onlineMobileCount > 0) {
    return "当前在线";
  }
  return formatDate(record.lastMobileSeenAt);
}

function getStatusMeta(status: UserStatus) {
  return statusMeta[status] ?? statusMeta.offline;
}

function authModeText(value: string) {
  if (value === "password") return "账号密码";
  if (value) return "第三方登录";
  return "未知";
}

function resetFilters() {
  filters.keyword = "";
}

async function submitAuth() {
  authLoading.value = true;
  try {
    // The admin panel uses the bootstrap admin account, which is the only
    // email still allowed to log in with a password (every other user must
    // use the verification-code flow on desktop/mobile).
    const result = await requestAPI<{ accessToken: string }>(`/auth/login`, {
      method: "POST",
      body: JSON.stringify({
        email: loginForm.email.trim(),
        password: loginForm.password,
      }),
    });
    token.value = result.accessToken;
    localStorage.setItem("user-admin-token", result.accessToken);
    Message.success("登录成功");
    await Promise.all([fetchUsers(), fetchReleases()]);
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    authLoading.value = false;
  }
}

function logout() {
  token.value = "";
  localStorage.removeItem("user-admin-token");
  users.value = [];
  releases.value = { desktop: emptyRelease("desktop"), mobile: emptyRelease("mobile") };
}

function switchSection(key: string) {
  if (key === "users" || key === "releases") {
    activeSection.value = key;
  }
}

function emptyRelease(platform: ReleasePlatform): AppReleaseRecord {
  return {
    platform,
    latestVersion: "",
    minSupportedVersion: null,
    downloadUrl: null,
    windowsDownloadUrl: null,
    linuxDownloadUrl: null,
    releaseUrl: null,
    releaseNotes: null,
    force: false,
    enabled: false,
    source: "manual",
    updatedAt: "",
  };
}

function emptyReleaseForm() {
  return {
    latestVersion: "",
    minSupportedVersion: "",
    downloadUrl: "",
    windowsDownloadUrl: "",
    linuxDownloadUrl: "",
    releaseUrl: "",
    releaseNotes: "",
    force: false,
    enabled: false,
  };
}

function applyReleaseToForm(release: AppReleaseRecord) {
  const form = releaseForms[release.platform];
  form.latestVersion = release.latestVersion ?? "";
  form.minSupportedVersion = release.minSupportedVersion ?? "";
  form.downloadUrl = release.downloadUrl ?? "";
  form.windowsDownloadUrl = release.windowsDownloadUrl ?? "";
  form.linuxDownloadUrl = release.linuxDownloadUrl ?? "";
  form.releaseUrl = release.releaseUrl ?? "";
  form.releaseNotes = release.releaseNotes ?? "";
  form.force = release.force;
  form.enabled = release.enabled;
}

async function fetchUsers() {
  pageLoading.value = true;
  try {
    users.value = await requestAPI<SystemUserRecord[]>("/admin/users");
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.message.includes("unauthorized")) {
      logout();
    }
  } finally {
    pageLoading.value = false;
  }
}

async function fetchReleases() {
  releasesLoading.value = true;
  try {
    const items = await requestAPI<AppReleaseRecord[]>("/admin/app-releases");
    const next: Record<ReleasePlatform, AppReleaseRecord> = { desktop: emptyRelease("desktop"), mobile: emptyRelease("mobile") };
    for (const item of items) {
      if (item.platform === "desktop" || item.platform === "mobile") {
        next[item.platform] = item;
      }
    }
    releases.value = next;
    applyReleaseToForm(next.desktop);
    applyReleaseToForm(next.mobile);
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    releasesLoading.value = false;
  }
}

async function importGithubRelease(platform: ReleasePlatform) {
  releaseSaving.value = { ...releaseSaving.value, [platform]: true };
  try {
    const info = await requestAPI<{
      latestVersion?: string;
      downloadUrl?: string | null;
      windowsDownloadUrl?: string | null;
      linuxDownloadUrl?: string | null;
      releaseUrl?: string | null;
      releaseNotes?: string | null;
    }>(`/admin/app-releases/${platform}/import-github`, { method: "POST" });
    const form = releaseForms[platform];
    form.latestVersion = info.latestVersion ?? "";
    form.downloadUrl = info.downloadUrl ?? "";
    form.windowsDownloadUrl = info.windowsDownloadUrl ?? "";
    form.linuxDownloadUrl = info.linuxDownloadUrl ?? "";
    form.releaseUrl = info.releaseUrl ?? "";
    form.releaseNotes = info.releaseNotes ?? "";
    Message.success("已从 GitHub 读取版本信息，请确认后保存");
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    releaseSaving.value = { ...releaseSaving.value, [platform]: false };
  }
}

async function saveRelease(platform: ReleasePlatform) {
  const form = releaseForms[platform];
  releaseSaving.value = { ...releaseSaving.value, [platform]: true };
  try {
    const saved = await requestAPI<AppReleaseRecord>(`/admin/app-releases/${platform}`, {
      method: "PUT",
      body: JSON.stringify({
        latestVersion: form.latestVersion,
        minSupportedVersion: form.minSupportedVersion || null,
        downloadUrl: form.downloadUrl || null,
        windowsDownloadUrl: form.windowsDownloadUrl || null,
        linuxDownloadUrl: form.linuxDownloadUrl || null,
        releaseUrl: form.releaseUrl || null,
        releaseNotes: form.releaseNotes || null,
        force: form.force,
        enabled: form.enabled,
      }),
    });
    releases.value = { ...releases.value, [platform]: saved };
    applyReleaseToForm(saved);
    Message.success("版本配置已保存，在线客户端会收到更新提示");
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    releaseSaving.value = { ...releaseSaving.value, [platform]: false };
  }
}

function platformTitle(platform: ReleasePlatform) {
  return platform === "desktop" ? "桌面端" : "移动端";
}

function openEditUser(user: SystemUserRecord) {
  activeUser.value = user;
  editForm.account = user.account;
  editForm.displayName = user.displayName;
  editModalVisible.value = true;
}

async function submitEditUser() {
  if (!activeUser.value) return;
  const account = editForm.account.trim();
  if (!account) {
    Message.warning("请输入账号");
    return;
  }

  actionLoading.value = true;
  try {
    const updated = await requestAPI<SystemUserRecord>(`/admin/users/${activeUser.value.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        account,
        displayName: editForm.displayName.trim(),
      }),
    });
    users.value = users.value.map((user) => (user.id === updated.id ? updated : user));
    editModalVisible.value = false;
    Message.success("用户信息已更新");
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    actionLoading.value = false;
  }
}

function openResetPassword(user: SystemUserRecord) {
  activeUser.value = user;
  passwordForm.password = "";
  passwordForm.confirmPassword = "";
  passwordModalVisible.value = true;
}

async function submitResetPassword() {
  if (!activeUser.value) return;
  if (passwordForm.password.length < 6) {
    Message.warning("密码至少 6 位");
    return;
  }
  if (passwordForm.password !== passwordForm.confirmPassword) {
    Message.warning("两次输入的密码不一致");
    return;
  }

  actionLoading.value = true;
  try {
    await requestAPI<{ ok: boolean }>(`/admin/users/${activeUser.value.id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password: passwordForm.password }),
    });
    passwordModalVisible.value = false;
    Message.success("密码已重置");
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    actionLoading.value = false;
  }
}

function openDeleteUser(user: SystemUserRecord) {
  activeUser.value = user;
  deleteModalVisible.value = true;
}

async function submitDeleteUser() {
  if (!activeUser.value) return;

  actionLoading.value = true;
  try {
    await requestAPI<{ ok: boolean }>(`/admin/users/${activeUser.value.id}`, {
      method: "DELETE",
    });
    users.value = users.value.filter((user) => user.id !== activeUser.value!.id);
    deleteModalVisible.value = false;
    Message.success("用户已删除");
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    actionLoading.value = false;
  }
}

async function toggleDisableUser(user: SystemUserRecord) {
  actionLoading.value = true;
  try {
    await requestAPI<{ ok: boolean }>(`/admin/users/${user.id}/toggle-disable`, {
      method: "PATCH",
      body: JSON.stringify({ disabled: !user.disabled }),
    });
    users.value = users.value.map((u) =>
      u.id === user.id ? { ...u, disabled: !u.disabled } : u
    );
    Message.success(user.disabled ? "用户已启用" : "用户已禁用");
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  } finally {
    actionLoading.value = false;
  }
}

async function openUserDrawer(user: SystemUserRecord) {
  activeUser.value = user;
  drawerVisible.value = true;
  devicesLoading.value = true;
  try {
    userDevices.value = await requestAPI<UserDevice[]>(`/admin/users/${user.id}/devices`);
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
    userDevices.value = [];
  } finally {
    devicesLoading.value = false;
  }
}

function startEditDeviceName(device: UserDevice) {
  editingDeviceId.value = device.id;
  editingDeviceName.value = device.name;
}

function cancelEditDeviceName() {
  editingDeviceId.value = null;
  editingDeviceName.value = "";
}

async function saveDeviceName(device: UserDevice) {
  const name = editingDeviceName.value.trim();
  if (!name) {
    Message.warning("设备名称不能为空");
    return;
  }
  if (name === device.name) {
    cancelEditDeviceName();
    return;
  }

  try {
    await requestAPI<{ ok: boolean }>(`/admin/devices/${device.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    userDevices.value = userDevices.value.map((d) =>
      d.id === device.id ? { ...d, name } : d
    );
    Message.success("设备名称已更新");
    cancelEditDeviceName();
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
  }
}

async function openDeviceSessions(device: UserDevice) {
  activeDevice.value = device;
  sessionsLoading.value = true;
  try {
    deviceSessions.value = await requestAPI<DeviceSession[]>(`/admin/devices/${device.id}/sessions`);
  } catch (error) {
    Message.error(error instanceof Error ? error.message : String(error));
    deviceSessions.value = [];
  } finally {
    sessionsLoading.value = false;
  }
}

function backToDevices() {
  activeDevice.value = null;
  deviceSessions.value = [];
}
</script>

<template>
  <main v-if="!isAuthenticated" class="login-page">
    <section class="login-brand-panel">
      <header class="login-brand-header">
        <div class="login-brand-mark"><icon-safe /></div>
        <strong>CodeHub AI</strong>
      </header>

      <div class="login-brand-hero">
        <h1>用户管理控制台</h1>
        <p>统一管理 AI 工作台用户、设备状态与客户端版本发布。</p>
      </div>

      <div class="login-features">
        <div class="login-feature">
          <icon-user-group />
          <div>
            <strong>用户与设备管理</strong>
            <span>集中查看桌面端和移动端用户及设备状态</span>
          </div>
        </div>
        <div class="login-feature">
          <icon-safe />
          <div>
            <strong>管理员专属访问</strong>
            <span>管理控制台仅允许授权管理员账号登录</span>
          </div>
        </div>
        <div class="login-feature">
          <icon-file />
          <div>
            <strong>客户端版本发布</strong>
            <span>统一维护桌面端与移动端发布信息</span>
          </div>
        </div>
      </div>
    </section>

    <section class="login-form-panel">
      <div class="login-form-container">
        <h2>登录</h2>
        <p class="login-form-subtitle">登录到用户管理控制台</p>
        <a-form class="login-form" layout="vertical" :model="loginForm" @submit="submitAuth">
          <a-form-item label="账号">
            <a-input v-model="loginForm.email" size="large" placeholder="请输入管理员账号">
              <template #prefix><icon-user /></template>
            </a-input>
          </a-form-item>
          <a-form-item label="密码">
            <a-input-password v-model="loginForm.password" size="large" placeholder="请输入密码">
              <template #prefix><icon-lock /></template>
            </a-input-password>
          </a-form-item>
          <a-button class="login-submit" type="primary" html-type="submit" long :loading="authLoading">
            登录
          </a-button>
        </a-form>
        <p class="login-hint">管理员账号密码登录。普通用户请使用桌面端或移动端验证码登录。</p>
      </div>
    </section>
  </main>

  <a-layout v-else class="admin-shell">
    <a-layout-sider class="admin-sidebar" :width="248">
      <div class="brand">
        <div class="brand-mark"><icon-user /></div>
        <div>
          <strong>用户管理系统</strong>
          <span>Workbench Users</span>
        </div>
      </div>

      <a-menu class="side-menu" :selected-keys="[activeSection]" @menu-item-click="switchSection">
        <a-menu-item key="users">
          <template #icon><icon-user /></template>
          用户管理
        </a-menu-item>
        <a-menu-item key="releases">
          <template #icon><icon-refresh /></template>
          版本发布
        </a-menu-item>
      </a-menu>
    </a-layout-sider>

    <a-layout>
      <a-layout-header class="admin-header">
        <div>
          <h1>{{ activeSection === "users" ? "用户管理" : "版本发布" }}</h1>
          <p>{{ activeSection === "users" ? "展示 AI 工作台真实账号，以及账号下绑定的桌面端和移动端使用情况。" : "配置桌面端和移动端最新版本，保存后通知在线客户端。" }}</p>
        </div>
        <a-space>
          <a-button v-if="activeSection === 'users'" @click="fetchUsers" :loading="pageLoading">
            <template #icon><icon-refresh /></template>
            刷新
          </a-button>
          <a-button v-if="activeSection === 'releases'" @click="fetchReleases" :loading="releasesLoading">
            <template #icon><icon-refresh /></template>
            刷新
          </a-button>
          <a-button v-if="activeSection === 'users'" @click="resetFilters">
            <template #icon><icon-refresh /></template>
            重置筛选
          </a-button>
          <a-button @click="logout">退出</a-button>
        </a-space>
      </a-layout-header>

      <a-layout-content class="admin-content">
        <a-card v-if="activeSection === 'users'" class="table-panel" :bordered="false">
          <div class="filter-bar">
            <a-input
              v-model="filters.keyword"
              allow-clear
              class="keyword-input"
              placeholder="搜索账号、显示名或用户 ID"
            >
              <template #prefix><icon-search /></template>
            </a-input>
          </div>

          <div class="table-toolbar">
            <span>共 {{ filteredUsers.length }} 个账号</span>
          </div>

          <a-table
            row-key="id"
            :columns="columns"
            :data="filteredUsers"
            :loading="pageLoading"
            :bordered="false"
            :pagination="{ pageSize: 8, showTotal: true, showJumper: true }"
            stripe
            @row-click="(record: any) => openUserDrawer(record as SystemUserRecord)"
          >
            <template #user="{ record }">
              <div class="user-cell">
                <a-avatar :size="36">{{ (record.displayName || record.account).slice(0, 1).toUpperCase() }}</a-avatar>
                <div>
                  <strong>{{ record.displayName || record.account }}</strong>
                  <span>{{ record.account }}</span>
                  <a-tag v-if="record.disabled" color="red" size="small" style="margin-left: 8px">已禁用</a-tag>
                </div>
              </div>
            </template>

            <template #authMode="{ record }">
              <a-tag>{{ authModeText(record.authMode) }}</a-tag>
            </template>

            <template #desktop="{ record }">
              <div class="device-cell">
                <icon-desktop />
                <span>{{ onlineCountText(record.onlineDesktopCount, record.desktopDeviceCount) }}</span>
                <small>最近：{{ formatDate(record.lastDesktopSeenAt) }}</small>
              </div>
            </template>

            <template #mobile="{ record }">
              <div class="device-cell">
                <icon-mobile />
                <span>{{ onlineCountText(record.onlineMobileCount, record.mobileDeviceCount) }}</span>
                <small>最近：{{ formatMobileLastSeen(record) }}</small>
              </div>
            </template>

            <template #status="{ record }">
              <a-tag :color="getStatusMeta(record.status).color">
                <template #icon>
                  <component :is="getStatusMeta(record.status).icon" />
                </template>
                {{ getStatusMeta(record.status).text }}
              </a-tag>
            </template>

            <template #latestSeenAt="{ record }">
              {{ formatDate(record.latestSeenAt) }}
            </template>

            <template #createdAt="{ record }">
              {{ formatDate(record.createdAt) }}
            </template>

            <template #id="{ record }">
              <span class="mono-id">{{ record.id }}</span>
            </template>

            <template #actions="{ record }">
              <a-space @click.stop>
                <a-button type="text" size="small" @click.stop="openEditUser(record)">
                  <template #icon><icon-edit /></template>
                  编辑
                </a-button>
                <a-button type="text" size="small" @click.stop="openResetPassword(record)">
                  <template #icon><icon-lock /></template>
                  重置密码
                </a-button>
                <a-button
                  type="text"
                  size="small"
                  :status="record.disabled ? 'success' : 'warning'"
                  @click.stop="toggleDisableUser(record)"
                >
                  {{ record.disabled ? "启用" : "禁用" }}
                </a-button>
                <a-button type="text" size="small" status="danger" @click.stop="openDeleteUser(record)">
                  删除
                </a-button>
              </a-space>
            </template>
          </a-table>
        </a-card>
        <div v-else class="release-grid">
          <a-card
            v-for="platform in releasePlatforms"
            :key="platform"
            class="release-card"
            :title="`${platformTitle(platform)}更新`"
            :bordered="false"
          >
            <template #extra>
              <a-space>
                <a-tag :color="releaseForms[platform].enabled ? 'green' : 'gray'">
                  {{ releaseForms[platform].enabled ? "已启用" : "未启用" }}
                </a-tag>
                <a-button size="small" :loading="releaseSaving[platform]" @click="importGithubRelease(platform)">
                  从 GitHub 读取
                </a-button>
              </a-space>
            </template>
            <a-form :model="releaseForms[platform]" layout="vertical">
              <a-form-item label="最新版本">
                <a-input v-model="releaseForms[platform].latestVersion" placeholder="例如 0.1.69" />
              </a-form-item>
              <a-form-item label="最低可用版本">
                <a-input v-model="releaseForms[platform].minSupportedVersion" placeholder="低于该版本视为不兼容，必须更新，可留空" />
              </a-form-item>
              <template v-if="platform === 'desktop'">
                <a-form-item label="Windows 下载地址">
                  <a-input v-model="releaseForms[platform].windowsDownloadUrl" placeholder="Windows 安装包下载地址，例如 .exe" />
                </a-form-item>
                <a-form-item label="Linux 下载地址">
                  <a-input v-model="releaseForms[platform].linuxDownloadUrl" placeholder="Linux 安装包下载地址，例如 .AppImage 或 .deb" />
                </a-form-item>
              </template>
              <a-form-item v-else label="APK 下载地址">
                <a-input v-model="releaseForms[platform].downloadUrl" placeholder="Android APK 下载地址" />
              </a-form-item>
              <a-form-item label="Release 页面">
                <a-input v-model="releaseForms[platform].releaseUrl" placeholder="GitHub Release 页面地址" />
              </a-form-item>
              <a-form-item label="更新说明">
                <a-textarea v-model="releaseForms[platform].releaseNotes" :auto-size="{ minRows: 4, maxRows: 8 }" placeholder="展示给用户看的更新说明" />
              </a-form-item>
              <a-space direction="vertical" fill>
                <a-checkbox v-model="releaseForms[platform].enabled">启用此配置</a-checkbox>
                <a-checkbox v-model="releaseForms[platform].force">强制更新提示</a-checkbox>
              </a-space>
              <div class="release-meta">
                <span>来源：{{ releases[platform].source || "manual" }}</span>
                <span>更新时间：{{ formatDate(releases[platform].updatedAt || null) }}</span>
              </div>
              <a-button
                type="primary"
                long
                :loading="releaseSaving[platform]"
                @click="saveRelease(platform)"
              >
                保存并通知在线{{ platformTitle(platform) }}
              </a-button>
            </a-form>
          </a-card>
        </div>
      </a-layout-content>
    </a-layout>

    <a-modal
      v-model:visible="editModalVisible"
      title="编辑用户"
      width="520px"
      :mask-closable="false"
      :ok-loading="actionLoading"
      @ok="submitEditUser"
    >
      <a-form :model="editForm" layout="vertical">
        <a-form-item label="账号" required>
          <a-input v-model="editForm.account" placeholder="请输入登录账号" />
        </a-form-item>
        <a-form-item label="显示名">
          <a-input v-model="editForm.displayName" placeholder="可填写用户昵称，账号密码用户可留空" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:visible="passwordModalVisible"
      title="重置密码"
      width="520px"
      :mask-closable="false"
      :ok-loading="actionLoading"
      @ok="submitResetPassword"
    >
      <a-alert
        v-if="activeUser"
        class="password-alert"
        type="warning"
        :content="`正在重置 ${activeUser.account} 的登录密码，保存后该用户需要使用新密码登录。`"
      />
      <a-form :model="passwordForm" layout="vertical">
        <a-form-item label="新密码" required>
          <a-input-password v-model="passwordForm.password" placeholder="至少 6 位" />
        </a-form-item>
        <a-form-item label="确认新密码" required>
          <a-input-password v-model="passwordForm.confirmPassword" placeholder="再次输入新密码" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:visible="deleteModalVisible"
      title="删除用户"
      width="420px"
      :mask-closable="false"
      :ok-loading="actionLoading"
      @ok="submitDeleteUser"
    >
      <a-alert
        v-if="activeUser"
        type="error"
        content="此操作不可恢复，删除后该用户的所有数据将被永久删除。"
      />
      <p v-if="activeUser" style="margin-top: 16px">
        确定要删除用户 <strong>{{ activeUser.account }}</strong> 吗？
      </p>
    </a-modal>

    <a-drawer
      v-model:visible="drawerVisible"
      :title="activeUser ? `${activeUser.account} 的设备` : '用户设备'"
      :width="960"
      :footer="false"
    >
      <template v-if="!activeDevice">
        <div style="margin-bottom: 16px; display: flex; justify-content: flex-end">
          <a-button size="small" @click="activeUser && openUserDrawer(activeUser)" :loading="devicesLoading">
            <template #icon><icon-refresh /></template>
            刷新设备
          </a-button>
        </div>
        <a-spin :loading="devicesLoading" style="width: 100%">
          <a-empty v-if="!devicesLoading && userDevices.length === 0" description="暂无设备" />
          <a-list v-else :bordered="false">
            <a-list-item v-for="device in userDevices" :key="device.id" @click="openDeviceSessions(device)" style="cursor: pointer">
              <a-list-item-meta>
                <template #title>
                  <a-space>
                    <icon-desktop />
                    <template v-if="editingDeviceId === device.id">
                      <a-input
                        v-model="editingDeviceName"
                        size="small"
                        style="width: 200px"
                        @keyup.enter="saveDeviceName(device)"
                        @keyup.escape="cancelEditDeviceName"
                        @click.stop
                      />
                      <a-button type="text" size="mini" status="success" @click.stop="saveDeviceName(device)">
                        保存
                      </a-button>
                      <a-button type="text" size="mini" @click.stop="cancelEditDeviceName">
                        取消
                      </a-button>
                    </template>
                    <template v-else>
                      <span>{{ device.name }}</span>
                      <a-button type="text" size="mini" @click.stop="startEditDeviceName(device)">
                        <template #icon><icon-edit /></template>
                      </a-button>
                    </template>
                    <a-tag :color="device.online ? 'green' : 'gray'" size="small">
                      {{ device.online ? "在线" : "离线" }}
                    </a-tag>
                  </a-space>
                </template>
                <template #description>
                  <a-space direction="vertical" :size="4">
                    <span>系统：{{ device.os }}</span>
                    <span>设备 ID：{{ device.id }}</span>
                    <span>最近活跃：{{ formatDate(device.lastSeenAt) }}</span>
                    <span>创建时间：{{ formatDate(device.createdAt) }}</span>
                  </a-space>
                </template>
              </a-list-item-meta>
            </a-list-item>
          </a-list>
        </a-spin>
      </template>

      <template v-else>
        <div style="margin-bottom: 16px; display: flex; align-items: center">
          <a-button type="text" @click="backToDevices">
            <template #icon><icon-refresh /></template>
            返回设备列表
          </a-button>
          <span style="margin-left: 12px; color: #4e5969; flex: 1">
            {{ activeDevice.name }} 的会话
          </span>
          <a-button size="small" @click="openDeviceSessions(activeDevice)" :loading="sessionsLoading">
            <template #icon><icon-refresh /></template>
            刷新会话
          </a-button>
        </div>
        <a-spin :loading="sessionsLoading" style="width: 100%">
          <a-empty v-if="!sessionsLoading && deviceSessions.length === 0" description="暂无会话" />
          <a-table
            v-else
            :data="deviceSessions"
            :bordered="false"
            :pagination="{ pageSize: 10, showTotal: true, showJumper: true }"
            :scroll="{ y: 500 }"
            stripe
          >
            <template #columns>
              <a-table-column title="会话标题" data-index="title" :width="240" />
              <a-table-column title="Provider" data-index="providerId" :width="100">
                <template #cell="{ record }">
                  <a-tag size="small">{{ record.providerId }}</a-tag>
                </template>
              </a-table-column>
              <a-table-column title="状态" data-index="status" :width="100">
                <template #cell="{ record }">
                  <a-tag :color="record.status === 'completed' ? 'green' : record.status === 'active' ? 'blue' : record.status === 'failed' ? 'red' : 'gray'" size="small">
                    {{ ({} as Record<string, string>)[record.status] || { completed: '已完成', active: '进行中', running: '运行中', failed: '失败', idle: '空闲' }[record.status as string] || record.status }}
                  </a-tag>
                </template>
              </a-table-column>
              <a-table-column title="创建时间" data-index="createdAt" :width="170">
                <template #cell="{ record }">
                  {{ formatDate(record.createdAt) }}
                </template>
              </a-table-column>
              <a-table-column title="更新时间" data-index="updatedAt" :width="170">
                <template #cell="{ record }">
                  {{ formatDate(record.updatedAt) }}
                </template>
              </a-table-column>
            </template>
          </a-table>
        </a-spin>
      </template>
    </a-drawer>
  </a-layout>
</template>

<style scoped>
.login-page,
.admin-shell {
  min-height: 100vh;
  background: #f5f7fb;
}

.login-page {
  display: flex;
  width: 100%;
  background: #ffffff;
  color: #1a1d26;
}

.login-brand-panel,
.login-form-panel {
  width: 50%;
  min-height: 100vh;
  padding: 40px 56px;
}

.login-brand-panel {
  display: flex;
  flex-direction: column;
  background: #ffffff;
}

.login-brand-header {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 16px;
}

.login-brand-mark {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 8px;
  background: #1a1d26;
  color: #ffffff;
  font-size: 18px;
}

.login-brand-hero {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
}

.login-brand-hero h1,
.login-brand-hero p,
.login-form-container h2,
.login-form-subtitle {
  margin: 0;
}

.login-brand-hero h1 {
  max-width: 460px;
  font-size: 32px;
  font-weight: 700;
  line-height: 1.3;
}

.login-brand-hero p {
  max-width: 460px;
  margin-top: 16px;
  color: #6b7280;
  font-size: 15px;
  line-height: 1.6;
}

.login-features {
  display: flex;
  flex-direction: column;
  gap: 20px;
  margin-bottom: 28px;
}

.login-feature {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  color: #4f46e5;
  font-size: 18px;
}

.login-feature div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.login-feature strong {
  color: #1a1d26;
  font-size: 14px;
  font-weight: 600;
}

.login-feature span {
  color: #9ca3af;
  font-size: 13px;
  line-height: 1.5;
}

.login-form-panel {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f8f9fb;
}

.login-form-container {
  width: 400px;
  max-width: 100%;
}

.login-form-container h2 {
  font-size: 24px;
  font-weight: 700;
}

.login-form-subtitle {
  margin-top: 8px;
  color: #6b7280;
  font-size: 14px;
}

.login-form {
  margin-top: 32px;
}

.login-form :deep(.arco-form-item) {
  margin-bottom: 16px;
}

.login-form :deep(.arco-form-item-label-col) {
  margin-bottom: 6px;
}

.login-form :deep(.arco-form-item-label) {
  color: #374151;
  font-size: 13px;
  font-weight: 500;
}

.login-form :deep(.arco-input-wrapper) {
  min-height: 44px;
  border: 1px solid #e2e5eb;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.login-form :deep(.arco-input-wrapper:hover) {
  border-color: #a5a9b3;
}

.login-form :deep(.arco-input-wrapper.arco-input-focus) {
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.login-form :deep(.arco-input-prefix) {
  color: #9ca3af;
}

.login-submit {
  height: 44px;
  margin-top: 8px;
  border-radius: 8px;
  background: #4f46e5;
  font-size: 15px;
  font-weight: 600;
}

.login-submit:hover {
  background: #4338ca;
}

.login-hint {
  width: 100%;
  margin-top: 16px;
  color: #9ca3af;
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

@media (max-width: 960px) {
  .login-brand-panel {
    display: none;
  }

  .login-form-panel {
    width: 100%;
    padding: 32px 24px;
  }
}

.admin-sidebar {
  border-right: 1px solid #e5e8ef;
  background: #ffffff;
  padding: 20px 12px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 10px 24px;
}

.brand-mark {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 8px;
  background: #165dff;
  color: #ffffff;
  font-size: 22px;
}

.brand strong,
.brand span {
  display: block;
}

.brand strong {
  color: #1d2129;
  font-size: 17px;
  font-weight: 700;
}

.brand span {
  margin-top: 3px;
  color: #86909c;
  font-size: 12px;
}

.side-menu {
  border-right: 0;
}

.admin-header {
  display: flex;
  height: 82px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e5e8ef;
  background: #ffffff;
  padding: 0 28px;
}

.admin-header h1,
.admin-header p,
.metric-card span,
.metric-card small,
.user-cell strong,
.user-cell span,
.device-cell span,
.device-cell small {
  margin: 0;
}

.admin-header h1 {
  color: #1d2129;
  font-size: 22px;
  font-weight: 750;
  line-height: 1.25;
}

.admin-header p {
  margin-top: 6px;
  color: #86909c;
  font-size: 13px;
}

.admin-content {
  padding: 22px 28px 28px;
}

.table-panel {
  border: 1px solid #edf0f5;
  border-radius: 8px;
  box-shadow: 0 8px 22px rgba(29, 33, 41, 0.05);
}

.release-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.release-card {
  border: 1px solid #edf0f5;
  border-radius: 8px;
  box-shadow: 0 8px 22px rgba(29, 33, 41, 0.05);
}

.release-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 14px 0;
  color: #86909c;
  font-size: 12px;
}

.filter-bar,
.table-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.filter-bar {
  margin-bottom: 14px;
}

.keyword-input {
  width: 360px;
}

.table-toolbar {
  justify-content: space-between;
  margin-bottom: 12px;
  color: #4e5969;
  font-size: 13px;
}

.user-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-cell strong,
.user-cell span,
.device-cell span,
.device-cell small {
  display: block;
}

.user-cell strong {
  color: #1d2129;
  font-size: 14px;
  font-weight: 650;
}

.user-cell span,
.device-cell small {
  margin-top: 3px;
  color: #86909c;
  font-size: 12px;
}

.device-cell {
  display: grid;
  grid-template-columns: 18px 1fr;
  align-items: center;
  column-gap: 8px;
}

.device-cell svg {
  color: #165dff;
}

.device-cell small {
  grid-column: 2;
}

.mono-id {
  color: #4e5969;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

:deep(.arco-table-tr) {
  cursor: pointer;
}

:deep(.arco-table-tr:hover) {
  background-color: #f2f3f5;
}

.session-output {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #86909c;
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.password-alert {
  margin-bottom: 16px;
}
</style>
