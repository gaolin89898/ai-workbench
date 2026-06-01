import "./style.css";

const appRoot = document.querySelector("#app");

if (appRoot) {
  appRoot.innerHTML = `<div class="boot-loading">正在启动 AI 工作台...</div>`;
}

async function bootstrap() {
  const [{ createApp }, { default: App }, { default: router }] = await Promise.all([
    import("vue"),
    import("./App.vue"),
    import("./router"),
  ]);
  createApp(App).use(router).mount("#app");
}

bootstrap().catch((error) => {
  if (appRoot) {
    appRoot.innerHTML = `<pre class="boot-error">前端启动失败：${error instanceof Error ? error.stack || error.message : String(error)}</pre>`;
  }
  console.error(error);
});
