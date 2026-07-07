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
  IconSettings,
  IconUser,
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

const token = ref(localStorage.getItem("user-admin-token") ?? "");
const loginMode = ref<"login" | "register">("login");
const authLoading = ref(false);
const pageLoading = ref(false);
const actionLoading = ref(false);
const editModalVisible = ref(false);
const passwordModalVisible = ref(false);
const deleteModalVisible = ref(false);
const activeUser = ref<SystemUserRecord | null>(null);
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

const filters = reactive({
  keyword: "",
  status: "",
  clientType: "",
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
const totalCount = computed(() => users.value.length);
const onlineCount = computed(() => users.value.filter((user) => user.status === "online").length);
const desktopUserCount = computed(
  () => users.value.filter((user) => user.desktopDeviceCount > 0).length
);
const mobileUserCount = computed(
  () => users.value.filter((user) => user.mobileDeviceCount > 0 || user.onlineMobileCount > 0).length
);
const onlineDesktopCount = computed(() =>
  users.value.reduce((sum, user) => sum + user.onlineDesktopCount, 0)
);
const onlineMobileCount = computed(() =>
  users.value.reduce((sum, user) => sum + user.onlineMobileCount, 0)
);

const filteredUsers = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase();
  return users.value.filter((user) => {
    const hitKeyword =
      !keyword ||
      [user.account, user.email, user.displayName, user.id].some((value) =>
        (value || "").toLowerCase().includes(keyword)
      );
    const hitStatus = !filters.status || user.status === filters.status;
    const hitClientType =
      !filters.clientType ||
      (filters.clientType === "desktop" && user.desktopDeviceCount > 0) ||
      (filters.clientType === "mobile" &&
        (user.mobileDeviceCount > 0 || user.onlineMobileCount > 0)) ||
      (filters.clientType === "both" &&
        user.desktopDeviceCount > 0 &&
        (user.mobileDeviceCount > 0 || user.onlineMobileCount > 0));
    return hitKeyword && hitStatus && hitClientType;
  });
});

onMounted(() => {
  if (token.value) {
    void fetchUsers();
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

function getStatusMeta(status: UserStatus) {
  return statusMeta[status] ?? statusMeta.offline;
}

function authModeText(value: string) {
  if (value === "password") return "账号密码";
  if (value === "dingtalk") return "钉钉";
  return value || "未知";
}

function resetFilters() {
  filters.keyword = "";
  filters.status = "";
  filters.clientType = "";
}

async function submitAuth() {
  authLoading.value = true;
  try {
    const result = await requestAPI<{ accessToken: string }>(`/auth/${loginMode.value}`, {
      method: "POST",
      body: JSON.stringify({
        email: loginForm.email.trim(),
        password: loginForm.password,
      }),
    });
    token.value = result.accessToken;
    localStorage.setItem("user-admin-token", result.accessToken);
    Message.success(loginMode.value === "login" ? "登录成功" : "注册成功");
    await fetchUsers();
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
</script>

<template>
  <main v-if="!isAuthenticated" class="login-page">
    <a-card class="login-card" :bordered="false">
      <div class="login-brand">
        <div class="brand-mark"><icon-user /></div>
        <h1>用户管理系统</h1>
        <p>管理 AI 工作台真实桌面端和移动端用户。</p>
      </div>
      <a-form layout="vertical" :model="loginForm" @submit.prevent="submitAuth">
        <a-form-item label="账号">
          <a-input v-model="loginForm.email" placeholder="admin" />
        </a-form-item>
        <a-form-item label="密码">
          <a-input-password v-model="loginForm.password" placeholder="请输入密码" />
        </a-form-item>
        <a-button type="primary" long :loading="authLoading" @click="submitAuth">
          {{ loginMode === "login" ? "登录" : "注册并登录" }}
        </a-button>
      </a-form>
      <button class="login-switch" type="button" @click="loginMode = loginMode === 'login' ? 'register' : 'login'">
        {{ loginMode === "login" ? "没有账号？切换到注册" : "已有账号？切换到登录" }}
      </button>
    </a-card>
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

      <a-menu class="side-menu" :default-selected-keys="['users']">
        <a-menu-item key="users">
          <template #icon><icon-user /></template>
          桌面端 / 移动端用户
        </a-menu-item>
        <a-menu-item key="devices">
          <template #icon><icon-desktop /></template>
          设备概览
        </a-menu-item>
        <a-menu-item key="logs">
          <template #icon><icon-file /></template>
          操作日志
        </a-menu-item>
        <a-menu-item key="settings">
          <template #icon><icon-settings /></template>
          系统设置
        </a-menu-item>
      </a-menu>
    </a-layout-sider>

    <a-layout>
      <a-layout-header class="admin-header">
        <div>
          <h1>桌面端 / 移动端用户</h1>
          <p>展示 AI 工作台真实账号，以及账号下绑定的桌面端和移动端使用情况。</p>
        </div>
        <a-space>
          <a-button @click="fetchUsers" :loading="pageLoading">
            <template #icon><icon-refresh /></template>
            刷新
          </a-button>
          <a-button @click="resetFilters">
            <template #icon><icon-refresh /></template>
            重置筛选
          </a-button>
          <a-button @click="logout">退出</a-button>
        </a-space>
      </a-layout-header>

      <a-layout-content class="admin-content">
        <section class="metrics-grid">
          <a-card class="metric-card" :bordered="false">
            <span>系统账号</span>
            <strong>{{ totalCount }}</strong>
            <small>后端 users 表账号数</small>
          </a-card>
          <a-card class="metric-card" :bordered="false">
            <span>在线账号</span>
            <strong>{{ onlineCount }}</strong>
            <small>桌面端或移动端在线</small>
          </a-card>
          <a-card class="metric-card" :bordered="false">
            <span>桌面端用户</span>
            <strong>{{ desktopUserCount }}</strong>
            <small>至少绑定 1 台桌面端</small>
          </a-card>
          <a-card class="metric-card" :bordered="false">
            <span>移动端用户</span>
            <strong>{{ mobileUserCount }}</strong>
            <small>有移动端记录或在线连接</small>
          </a-card>
          <a-card class="metric-card warning" :bordered="false">
            <span>在线连接</span>
            <strong>{{ onlineDesktopCount + onlineMobileCount }}</strong>
            <small>桌面 {{ onlineDesktopCount }} / 移动 {{ onlineMobileCount }}</small>
          </a-card>
        </section>

        <a-card class="table-panel" :bordered="false">
          <div class="filter-bar">
            <a-input
              v-model="filters.keyword"
              allow-clear
              class="keyword-input"
              placeholder="搜索账号、显示名或用户 ID"
            >
              <template #prefix><icon-search /></template>
            </a-input>
            <a-select v-model="filters.status" allow-clear placeholder="在线状态" class="filter-select">
              <a-option value="online">在线</a-option>
              <a-option value="offline">离线</a-option>
            </a-select>
            <a-select v-model="filters.clientType" allow-clear placeholder="客户端类型" class="filter-select">
              <a-option value="desktop">桌面端用户</a-option>
              <a-option value="mobile">移动端用户</a-option>
              <a-option value="both">同时使用</a-option>
            </a-select>
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
                <span>{{ record.onlineDesktopCount }} / {{ record.desktopDeviceCount }} 在线</span>
                <small>最近：{{ formatDate(record.lastDesktopSeenAt) }}</small>
              </div>
            </template>

            <template #mobile="{ record }">
              <div class="device-cell">
                <icon-mobile />
                <span>{{ record.onlineMobileCount }} / {{ record.mobileDeviceCount }} 在线</span>
                <small>最近：{{ formatDate(record.lastMobileSeenAt) }}</small>
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
              <a-space>
                <a-button type="text" size="small" @click="openEditUser(record)">
                  <template #icon><icon-edit /></template>
                  编辑
                </a-button>
                <a-button type="text" size="small" @click="openResetPassword(record)">
                  <template #icon><icon-lock /></template>
                  重置密码
                </a-button>
                <a-button
                  type="text"
                  size="small"
                  :status="record.disabled ? 'success' : 'warning'"
                  @click="toggleDisableUser(record)"
                >
                  {{ record.disabled ? "启用" : "禁用" }}
                </a-button>
                <a-button type="text" size="small" status="danger" @click="openDeleteUser(record)">
                  删除
                </a-button>
              </a-space>
            </template>
          </a-table>
        </a-card>
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
          <a-input v-model="editForm.displayName" placeholder="钉钉用户可显示昵称，账号密码用户可留空" />
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
  </a-layout>
</template>

<style scoped>
.login-page,
.admin-shell {
  min-height: 100vh;
  background: #f5f7fb;
}

.login-page {
  display: grid;
  place-items: center;
  padding: 32px;
}

.login-card {
  width: 420px;
  border: 1px solid #edf0f5;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(29, 33, 41, 0.08);
}

.login-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 26px;
  text-align: center;
}

.login-brand h1,
.login-brand p {
  margin: 0;
}

.login-brand h1 {
  margin-top: 12px;
  color: #1d2129;
  font-size: 22px;
  font-weight: 760;
}

.login-brand p {
  margin-top: 6px;
  color: #86909c;
  font-size: 13px;
}

.login-switch {
  width: 100%;
  margin-top: 16px;
  border: 0;
  background: transparent;
  color: #165dff;
  cursor: pointer;
  font-size: 13px;
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

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(150px, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}

.metric-card {
  min-height: 112px;
  border: 1px solid #edf0f5;
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(29, 33, 41, 0.04);
}

.metric-card :deep(.arco-card-body) {
  display: flex;
  height: 100%;
  flex-direction: column;
  justify-content: center;
  padding: 18px;
}

.metric-card span {
  color: #4e5969;
  font-size: 13px;
  font-weight: 600;
}

.metric-card strong {
  margin-top: 8px;
  color: #1d2129;
  font-size: 28px;
  font-weight: 760;
  line-height: 1;
}

.metric-card small {
  margin-top: 10px;
  color: #86909c;
  font-size: 12px;
}

.metric-card.warning strong {
  color: #f53f3f;
}

.table-panel {
  border: 1px solid #edf0f5;
  border-radius: 8px;
  box-shadow: 0 8px 22px rgba(29, 33, 41, 0.05);
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

.filter-select {
  width: 160px;
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

.password-alert {
  margin-bottom: 16px;
}
</style>
