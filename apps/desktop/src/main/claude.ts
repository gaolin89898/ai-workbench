// Claude Code integration for the Electron main process.
// Spawns the `claude` CLI with `--output-format stream-json`, parses the
// streaming JSON output, and emits AiChatOutputEvent to the renderer.
// Mirrors the original Tauri Rust run_ai_chat implementation.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { RunAiChatRequest, AiChatOutputEvent } from "../services/desktop";
import { reportTokenUsage } from "./sync";

// Structural sender — WebContents / BrowserWindow satisfy this, and test
// stubs can be passed too.
type Sender = { send: (channel: string, ...args: unknown[]) => void };

// ---------- Constants ----------

const CLAUDE_TIMEOUT_MS = 120_000;
const CLI_INTERRUPT_FALLBACK_MS = 1500;
const activeClaudeRuns = new Map<string, { stop: () => void; sender: Sender }>();

function spawnClaude(args: string[], options?: { cwd?: string }): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", "claude.cmd", ...args], {
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn("claude", args, {
    cwd: options?.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ---------- System instructions ----------

function claudeDesktopPrompt(): string {
  return [
    "你是 AI Workbench 桌面端的编程助手。",
    "请严格遵守以下规则：",
    "1. 必须使用中文回复用户。",
    "2. 必须实际执行读取命令（如 ls / cat / grep / find）来了解项目结构和文件内容，不能仅凭推测回答。",
    "3. 在执行任何修改性命令前，先告知用户你打算做什么。",
    "4. 命令执行结果要如实地反馈给用户。",
  ].join("\n");
}

// ---------- Helpers ----------

function emit(sender: Sender, event: AiChatOutputEvent): void {
  sender.send("ai-chat-output", event);
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isUserStopError(err: unknown): boolean {
  return err instanceof Error && err.message === "AI chat stopped by user";
}

// Extract incremental text from a content_block_delta message.
//   { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
function extractDeltaText(message: Record<string, unknown>): string | undefined {
  const delta = message["delta"] as Record<string, unknown> | undefined;
  const text = delta?.["text"] ?? message["text"];
  return typeof text === "string" ? text : undefined;
}

// Extract full text from an assistant message.
//   { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
function extractAssistantText(message: Record<string, unknown>): string | undefined {
  const msg = message["message"] as Record<string, unknown> | undefined;
  const content = msg?.["content"];
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        texts.push(b["text"]);
      }
    }
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

// Extract session_id from a result message.
function extractSessionId(message: Record<string, unknown>): string | undefined {
  const sid = message["session_id"] ?? message["sessionId"];
  return typeof sid === "string" ? sid : undefined;
}

// Claude stream-json 的 result 消息原生带 usage：
// { usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } }
function reportClaudeTokenUsage(aiSessionId: string, message: Record<string, unknown>): void {
  try {
    const usage = message["usage"];
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    const inputTokens = numOrZero(u["input_tokens"]) + numOrZero(u["cache_read_input_tokens"]);
    const outputTokens = numOrZero(u["output_tokens"]);
    const total = inputTokens + outputTokens;
    if (total <= 0) return;
    void reportTokenUsage({
      aiSessionId,
      providerId: "claude",
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: total,
    });
  } catch {
    // best-effort
  }
}

function numOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return 0;
}

// ---------- Internal: single claude invocation ----------

/**
 * Spawn `claude` once, parse stream-json output, and emit events.
 * Returns the session_id from the result message.
 *
 * If `existingSessionId` is provided, `--resume` is used. On failure (non-zero
 * exit or error output), the error is marked with `resumeFailure: true` so the
 * caller can retry without `--resume`.
 */
function runClaudeOnce(
  req: RunAiChatRequest,
  sender: Sender,
  existingSessionId: string | null
): Promise<string> {
  const { aiSessionId, projectPath, prompt } = req;
  const imageNote = req.images?.length
    ? `\n\n[用户还粘贴了 ${req.images.length} 张图片；当前 Claude CLI 集成暂未直接传递图片二进制，请根据用户文字继续，并在需要时提示用户改用 Codex 或描述图片内容。]`
    : "";

  // Build CLI args
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "plan",
    "--append-system-prompt", claudeDesktopPrompt(),
  ];
  if (existingSessionId) {
    args.push("--resume", existingSessionId);
  }
  args.push(`${prompt}${imageNote}`);

  const child: ChildProcessWithoutNullStreams = spawnClaude(args, { cwd: projectPath });

  const rl: Interface = createInterface({
    input: child.stdout,
    terminal: false,
  });

  // Mutable state shared across event handlers
  let stderrBuffer = "";
  let sessionId = "";
  let closed = false;
  let hasReceivedDeltas = false;
  let errorEmitted = false;
  let resultReceived = false;

  // Emit initial status
  emit(sender, {
    aiSessionId,
    kind: "status",
    text: "running",
    segment: { type: "status", label: "Claude 正在思考", icon: "think" },
  });

  return new Promise<string>((resolve, reject) => {
    // ----- timeout -----
    const timeout = setTimeout(() => {
      if (closed) return;
      if (!errorEmitted) {
        errorEmitted = true;
        emit(sender, {
          aiSessionId,
          kind: "error",
          segment: { type: "error", message: "Claude 会话超时（120s）" },
        });
      }
      killChild();
      reject(new Error("timeout"));
    }, CLAUDE_TIMEOUT_MS);

    // ----- helper: mark resume failure -----
    function rejectWithError(
      message: string,
      opts?: { resumeFailure?: boolean }
    ): void {
      const err = new Error(message) as Error & {
        resumeFailure?: boolean;
      };
      if (opts?.resumeFailure) err.resumeFailure = true;
      reject(err);
    }

    // ----- helper: kill child -----
    function killChild(): void {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      activeClaudeRuns.delete(aiSessionId);
      try {
        rl.close();
      } catch {
        // ignore
      }
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
    }

    function interruptChild(): void {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      activeClaudeRuns.delete(aiSessionId);
      try {
        rl.close();
      } catch {
        // ignore
      }
      try {
        child.kill("SIGINT");
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (child.killed || child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.stdin.end();
        } catch {
          // ignore
        }
        try {
          child.kill();
        } catch {
          // ignore
        }
      }, CLI_INTERRUPT_FALLBACK_MS);
    }

    activeClaudeRuns.set(aiSessionId, {
      sender,
      stop: () => {
        interruptChild();
        reject(new Error("AI chat stopped by user"));
      },
    });

    // ----- stdout: parse stream-json lines -----
    rl.on("line", (line: string) => {
      if (closed) return; // session already ended — ignore stale lines
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        // non-JSON line — ignore
        return;
      }

      if (!message || typeof message !== "object") return;
      const msg = message as Record<string, unknown>;
      const type =
        typeof msg["type"] === "string" ? (msg["type"] as string) : "";

      switch (type) {
        case "content_block_delta": {
          const text = extractDeltaText(msg);
          if (text) {
            hasReceivedDeltas = true;
            emit(sender, {
              aiSessionId,
              kind: "delta",
              text,
              segment: { type: "text", text },
            });
          }
          break;
        }
        case "assistant": {
          // Only emit from assistant messages if we haven't received
          // incremental deltas (avoids duplicate text).
          if (!hasReceivedDeltas) {
            const text = extractAssistantText(msg);
            if (text) {
              hasReceivedDeltas = true;
              emit(sender, {
                aiSessionId,
                kind: "delta",
                text,
                segment: { type: "text", text },
              });
            }
          }
          break;
        }
        case "result": {
          resultReceived = true;
          clearTimeout(timeout);

          // Claude stream-json 的 result 消息原生带 usage 字段
          reportClaudeTokenUsage(aiSessionId, msg);

          const subtype = strOrUndef(msg["subtype"]);
          const isErrorFlag = msg["is_error"];

          if (subtype === "error" || isErrorFlag === true) {
            const errMsg =
              strOrUndef(msg["result"]) ?? "Claude 返回错误";
            if (!errorEmitted) {
              errorEmitted = true;
              emit(sender, {
                aiSessionId,
                kind: "error",
                segment: { type: "error", message: errMsg },
              });
            }
            killChild();
            rejectWithError(errMsg, {
              resumeFailure: !!existingSessionId,
            });
          } else {
            sessionId = extractSessionId(msg) ?? "";
            emit(sender, { aiSessionId, kind: "done" });
            killChild();
            resolve(sessionId);
          }
          break;
        }
        default:
          // system / message_start / message_delta / content_block_start /
          // content_block_stop / etc. — ignore
          break;
      }
    });

    // ----- stderr: accumulate for error reporting -----
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    // ----- stdin errors (e.g. EPIPE) — swallow -----
    child.stdin.on("error", () => {
      // best-effort; child probably already exited
    });

    // ----- child close (fires after stdio streams are closed) -----
    child.on("close", (code: number | null) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      activeClaudeRuns.delete(aiSessionId);

      if (resultReceived) return; // already resolved/rejected via result message

      if (code === 0) {
        // No result message but clean exit — resolve with whatever sessionId we have
        resolve(sessionId);
      } else {
        const detail =
          stderrBuffer.trim() || `exit code ${code}`;
        if (!errorEmitted) {
          errorEmitted = true;
          emit(sender, {
            aiSessionId,
            kind: "error",
            segment: {
              type: "error",
              message: `Claude 进程退出：${detail}`,
            },
          });
        }
        rejectWithError(`claude exited with code ${code}: ${detail}`, {
          resumeFailure: !!existingSessionId,
        });
      }
    });

    // ----- spawn error (e.g. ENOENT when claude is not installed) -----
    child.on("error", (err: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      activeClaudeRuns.delete(aiSessionId);

      const errno = err as NodeJS.ErrnoException;
      const message =
        errno.code === "ENOENT"
          ? "未找到 claude 命令，请先安装 Claude Code CLI"
          : `Claude 进程错误：${err.message}`;
      if (!errorEmitted) {
        errorEmitted = true;
        emit(sender, {
          aiSessionId,
          kind: "error",
          segment: { type: "error", message },
        });
      }
      reject(err);
    });
  });
}

// ---------- Public API ----------

/**
 * Run a Claude Code chat turn. Spawns `claude --print --output-format
 * stream-json`, parses the streaming output, and emits AiChatOutputEvent.
 *
 * If `existingSessionId` is provided, `--resume` is used; on failure a fresh
 * session is started automatically.
 *
 * Returns the session_id (providerSessionId).
 */
export async function runAiChat(
  req: RunAiChatRequest,
  sender: Sender,
  existingSessionId?: string | null
): Promise<string> {
  const sessionId = existingSessionId ?? null;

  if (sessionId) {
    try {
      return await runClaudeOnce(req, sender, sessionId);
    } catch (err) {
      if (isUserStopError(err)) return sessionId;
      // Retry without --resume only for resume-specific failures
      if (
        err &&
        typeof err === "object" &&
        "resumeFailure" in err &&
        (err as { resumeFailure: boolean }).resumeFailure
      ) {
        emit(sender, {
          aiSessionId: req.aiSessionId,
          kind: "status",
          text: "running",
          segment: {
            type: "status",
            label: "正在启动新会话",
            icon: "think",
          },
        });
        return await runClaudeOnce(req, sender, null);
      }
      throw err;
    }
  }

  try {
    return await runClaudeOnce(req, sender, null);
  } catch (err) {
    if (isUserStopError(err)) return "";
    throw err;
  }
}

export function stopAiChat(aiSessionId: string): boolean {
  const run = activeClaudeRuns.get(aiSessionId);
  if (!run) return false;
  emit(run.sender, {
    aiSessionId,
    kind: "done",
    text: "",
    segment: {
      type: "status",
      stepId: "interrupted",
      label: "已中断",
      icon: "warn",
    },
  });
  run.stop();
  return true;
}

/**
 * Pre-warm a Claude session. Claude's session_id is only generated after the
 * first real conversation, so warmup simply verifies the CLI is available
 * and returns an empty providerSessionId.
 *
 * Best-effort: always resolves, never rejects.
 */
export async function warmupAiSession(
  aiSessionId: string,
  _sender: Sender
): Promise<{ providerSessionId: string }> {
  return new Promise((resolve) => {
    const child = spawnClaude(["--version"]);

    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ providerSessionId: "" });
    }, 10_000);

    child.on("exit", () => {
      clearTimeout(timeout);
      resolve({ providerSessionId: "" });
    });

    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ providerSessionId: "" });
    });
  });
}
