<script setup lang="ts">
import { computed, onMounted, reactive, ref, type Component } from "vue";
import {
  IconCheckCircle,
  IconClockCircle,
  IconDesktop,
  IconEdit,
  IconLock,
  IconMobile,
  IconRefresh,
  IconSearch,
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

const token = ref(localStorage.getItem("user-admin-token") ?? "");
const loginMode = ref<"login" | "register">("login");
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
  if (value === "dingtalk") return "钉钉";
  return value || "未知";
}

function resetFilters() {
  filters.keyword = "";
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
          用户管理
        </a-menu-item>
      </a-menu>
    </a-layout-sider>

    <a-layout>
      <a-layout-header class="admin-header">
        <div>
          <h1>用户管理</h1>
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

    <a-drawer
      v-model:visible="drawerVisible"
      :title="activeUser ? `${activeUser.account} 的设备` : '用户设备'"
      :width="960"
      :footer="false"
    >
      <template v-if="!activeDevice">
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
        <div style="margin-bottom: 16px">
          <a-button type="text" @click="backToDevices">
            <template #icon><icon-refresh /></template>
            返回设备列表
          </a-button>
          <span style="margin-left: 12px; color: #4e5969">
            {{ activeDevice.name }} 的会话
          </span>
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
