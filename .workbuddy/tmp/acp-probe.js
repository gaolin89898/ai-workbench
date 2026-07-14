// ACP 协议完整对话探针：initialize → session/new → session/prompt → 收 session/update
// 用法: node acp-probe.js <command> [args...]
// 例: node acp-probe.js opencode acp
//     node acp-probe.js mimo acp

const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

const cmd = process.argv[2] || "opencode";
const cmdArgs = process.argv.slice(3);
const cwd = process.argv[4] || "C:/Users/32891/Desktop/ai-workbench";

const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"], shell: true });
const rl = createInterface({ input: child.stdout, terminal: false });
const rlErr = createInterface({ input: child.stderr, terminal: false });

let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(msg);
    console.log(`\n>>> [req ${id}] ${method}`, JSON.stringify(params).slice(0, 200));
  });
}

function notify(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  child.stdin.write(msg);
  console.log(`\n>>> [notify] ${method}`, JSON.stringify(params).slice(0, 120));
}

const updateCount = { total: 0, byType: {} };

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { console.log("  (non-json line:", line.slice(0, 100), ")"); return; }

  // 响应（有 id）
  if (msg.id != null && (msg.result !== undefined || msg.error)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) {
        console.log(`\n<<< [resp ${msg.id}] ERROR`, JSON.stringify(msg.error).slice(0, 400));
        p.reject(new Error(msg.error.message));
      } else {
        console.log(`\n<<< [resp ${msg.id}] OK`, JSON.stringify(msg.result).slice(0, 500));
        p.resolve(msg.result);
      }
    }
    return;
  }

  // 通知 / server 请求（有 method 无 id 或有 id+method 是 server request）
  if (msg.method) {
    if (msg.id != null) {
      // server request（需要应答）
      console.log(`\n<<< [server-req ${msg.id}] ${msg.method}`, JSON.stringify(msg.params).slice(0, 300));
      // 自动应答 approval 类请求为 denied，避免挂起
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      return;
    }
    // 通知
    if (msg.method === "session/update") {
      updateCount.total++;
      const update = msg.params?.update;
      const utype = update?.type || update?.kind || "unknown";
      updateCount.byType[utype] = (updateCount.byType[utype] || 0) + 1;
      console.log(`\n<<< [update #${updateCount.total}] type=${utype}`, JSON.stringify(update).slice(0, 600));
    } else {
      console.log(`\n<<< [notify] ${msg.method}`, JSON.stringify(msg.params).slice(0, 300));
    }
  }
});

rlErr.on("line", (line) => {
  if (line.trim()) console.log(`  [stderr] ${line.slice(0, 200)}`);
});

async function main() {
  try {
    // 1. initialize
    await send("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "acp-probe", version: "0.1.0" },
    });

    // 2. session/new
    const session = await send("session/new", { cwd, mcpServers: [] });
    const sessionId = session?.sessionId;
    console.log(`\n=== sessionId: ${sessionId} ===`);

    // 3. session/prompt
    console.log("\n=== 发送 prompt，等待流式响应（最多 25s）===");
    send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "用一句话说你好，不要执行任何操作" }],
    }).then((resp) => {
      console.log(`\n=== PromptResponse ===`, JSON.stringify(resp));
      console.log(`\n=== 统计: 共 ${updateCount.total} 条 update ===`, JSON.stringify(updateCount.byType));
      child.kill();
      process.exit(0);
    }).catch((e) => {
      console.log(`\n=== prompt 失败: ${e.message} ===`);
      console.log(`\n=== 统计: 共 ${updateCount.total} 条 update ===`, JSON.stringify(updateCount.byType));
      child.kill();
      process.exit(1);
    });
  } catch (e) {
    console.log(`\n=== 流程失败: ${e.message} ===`);
    child.kill();
    process.exit(1);
  }
}

setTimeout(() => {
  console.log(`\n=== 超时（30s），强制结束 ===`);
  console.log(`=== 统计: 共 ${updateCount.total} 条 update ===`, JSON.stringify(updateCount.byType));
  child.kill();
  process.exit(2);
}, 30000);

main();
