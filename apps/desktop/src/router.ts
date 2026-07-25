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
      { path: "resources", name: "resources", redirect: (to) => ({ name: "settings", query: { panel: "resources", tab: to.query.tab || "mcp" } }) },
      { path: "settings", name: "settings", component: () => import("./components/SettingsView.vue") },
    ],
  },
  {
    path: "/session/:id",
    name: "sessionWindow",
    component: () => import("./components/SessionWindow.vue"),
  },
  { path: "/:pathMatch(.*)*", redirect: "/chat" },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
