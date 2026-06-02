import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/chat" },
  {
    path: "/",
    component: () => import("./AppShell.vue"),
    children: [
      { path: "chat", name: "aiSessions", component: () => import("./components/ChatView.vue") },
      { path: "workspace", name: "workspace", component: () => import("./components/WorkspaceView.vue") },
      { path: "projects", name: "projects", component: () => import("./components/ProjectsView.vue") },
      { path: "providers", name: "providers", component: () => import("./components/ProvidersView.vue") },
      { path: "pairing", name: "pairing", component: () => import("./components/PairingView.vue") },
      { path: "settings", name: "settings", component: () => import("./components/SettingsView.vue") },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: "/chat" },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
