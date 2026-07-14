// ACP 模型选择探针：打印完整 configOptions，测试 session/set_config_option
// 用法: node acp-model-probe.js <command> [args...]
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

const cmd = process.argv[2] || "opencode";
const cmdArgs = process.argv.slice(3);
const cwd = process.argv[4] || "C:/Users/32891/Desktop/ai-workbench";

const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"], shell: true });
const rl = createInterface({ input: child.stdout, terminal: false });
let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    console.log(`\n>>> [req ${id}] ${method}`);
  });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && (msg.result !== undefined || msg.error)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) { console.log(`<<< [resp ${msg.id}] ERROR`, JSON.stringify(msg.error)); p.reject(new Error(msg.error.message)); }
      else { console.log(`<<< [resp ${msg.id}] OK`); p.resolve(msg.result); }
    }
  } else if (msg.method && msg.id != null) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
  }
});

child.stderr.on("data", () => {});

async function main() {
  try {
    await send("initialize", { protocolVersion: 1, clientInfo: { name: "probe", version: "0.1.0" } });
    const session = await send("session/new", { cwd, mcpServers: [] });
    const sessionId = session?.sessionId;
    console.log(`\n=== sessionId: ${sessionId} ===`);

    // 完整打印 configOptions
    console.log(`\n=== 完整 configOptions ===`);
    console.log(JSON.stringify(session?.configOptions, null, 2));

    // 测试 session/set_config_option —— 尝试几种参数格式
    console.log(`\n=== 测试 set_config_option (格式 A: optionId+value) ===`);
    try {
      const r = await send("session/set_config_option", { sessionId, optionId: "model", value: session?.configOptions?.[0]?.currentValue });
      console.log("  结果:", JSON.stringify(r));
    } catch (e) { console.log("  失败:", e.message); }

    console.log(`\n=== 测试 set_config_option (格式 C: configId+value) ===`);
    try {
      const targetModel = session?.configOptions?.[0]?.options?.[1]?.value;
      console.log("  目标模型:", targetModel);
      const r = await send("session/set_config_option", { sessionId, configId: "model", value: targetModel });
      console.log("  结果:", JSON.stringify(r));
    } catch (e) { console.log("  失败:", e.message); }

    child.kill();
    process.exit(0);
  } catch (e) {
    console.log(`\n失败: ${e.message}`);
    child.kill();
    process.exit(1);
  }
}
setTimeout(() => { console.log("\n超时"); child.kill(); process.exit(2); }, 15000);
main();
