import { createRouter, createWebHashHistory } from "vue-router";
import { h } from "vue";

const routeStub = { render: () => h("span") };

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/workspace", name: "workspace", component: routeStub },
    { path: "/projects", name: "projects", component: routeStub },
    { path: "/chat", name: "aiSessions", component: routeStub },
    { path: "/providers", name: "providers", component: routeStub },
    { path: "/pairing", name: "pairing", component: routeStub },
    { path: "/settings", name: "settings", component: routeStub },
    { path: "/:pathMatch(.*)*", redirect: "/chat" },
  ],
});

export default router;
