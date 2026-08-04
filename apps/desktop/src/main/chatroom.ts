import type {
  AgentRole,
  RunChatroomTurnRequest,
  ChatroomResponseEvent,
  RunCodexChatRequest,
  RunAiChatRequest,
  AiHistoryMessage,
} from "../services/desktop";
import { runCodexChat } from "./codex";
import { runAiChat } from "./claude";
import { runOpenCodeChat } from "./acp";
import { runMimoChat } from "./mimo";
import * as db from "./db";

type Sender = { send: (channel: string, ...args: unknown[]) => void };

// ---------- 内置角色 ----------

export const CHATROOM_ROLES: AgentRole[] = [
  {
    id: "planner",
    name: "规划师",
    description: "分析需求、拆解任务、制定方案",
    providerId: "claude",
    systemPrompt: "你是一名资深技术规划师，正在参与一个多角色聊天室讨论。请基于聊天室中的完整对话历史，从你的专业角度给出分析和建议。关注需求理解、任务拆解和方案设计。",
    chatOptions: { claudeMode: "default" },
  },
  {
    id: "coder",
    name: "编码师",
    description: "编写高质量代码、解决技术实现问题",
    providerId: "codex",
    systemPrompt: "你是一名资深工程师，正在参与一个多角色聊天室讨论。请基于聊天室中的完整对话历史，从代码实现的角度给出建议。关注代码质量、最佳实践和技术可行性。",
    chatOptions: { approvalMode: "custom" },
  },
  {
    id: "reviewer",
    name: "审查师",
    description: "审查代码质量、安全性和一致性",
    providerId: "claude",
    systemPrompt: "你是一名严格的代码审查者，正在参与一个多角色聊天室讨论。请基于聊天室中的完整对话历史，从审查的角度给出意见。关注正确性、安全性、性能和可维护性。",
    chatOptions: { claudeMode: "default" },
  },
  {
    id: "tester",
    name: "测试师",
    description: "编写测试用例、验证实现正确性",
    providerId: "claude",
    systemPrompt: "你是一名测试工程师，正在参与一个多角色聊天室讨论。请基于聊天室中的完整对话历史，从测试的角度给出建议。关注边界场景、测试覆盖和验证策略。",
    chatOptions: { claudeMode: "default" },
  },
];

export function listChatroomRoles(): AgentRole[] {
  return CHATROOM_ROLES;
}

// ---------- 运行状态管理 ----------

interface ChatroomRunState {
  aiSessionId: string;
  cancelled: boolean;
  activeStepSessionIds: Set<string>;
}

const activeChatroomRuns = new Map<string, ChatroomRunState>();

export function stopChatroomTurn(aiSessionId: string): boolean {
  const run = activeChatroomRuns.get(aiSessionId);
  if (!run) return false;
  run.cancelled = true;
  for (const stepSessionId of run.activeStepSessionIds) {
    void stopStepSession(stepSessionId);
  }
  return true;
}

export function hasLiveChatroom(): boolean {
  return activeChatroomRuns.size > 0;
}

async function stopStepSession(stepSessionId: string): Promise<void> {
  const { stopCodexChat } = await import("./codex");
  const { stopAiChat } = await import("./claude");
  const { stopOpenCodeChat } = await import("./acp");
  const { stopMimoChat } = await import("./mimo");
  if (await stopCodexChat(stepSessionId)) return;
  if (stopOpenCodeChat(stepSessionId)) return;
  if (stopMimoChat(stepSessionId)) return;
  stopAiChat(stepSessionId);
}

// ---------- @提及解析 ----------

/**
 * 从用户消息中解析出被 @提及的角色 ID。
 * 支持 @规划师 @coder 等形式（中文名和 ID 均可）。
 */
export function parseMentions(text: string, roles: AgentRole[]): string[] {
  const mentioned = new Set<string>();
  for (const role of roles) {
    // 匹配 @角色名 或 @角色ID（中英文）
    const namePattern = `@${role.name}`;
    const idPattern = `@${role.id}`;
    const regex = new RegExp(`@${escapeRegExp(role.name)}|@${escapeRegExp(role.id)}`, "gi");
    if (regex.test(text)) {
      mentioned.add(role.id);
    }
    void namePattern;
    void idPattern;
  }
  return Array.from(mentioned);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- 共享历史组装 ----------

function buildSharedHistoryPrompt(
  history: AiHistoryMessage[],
  currentUserPrompt: string,
  targetRole: AgentRole,
): string {
  const lines: string[] = [];

  lines.push("# 角色设定");
  lines.push(targetRole.systemPrompt);
  lines.push("");
  lines.push("# 聊天室对话历史");
  lines.push("以下是聊天室中所有参与者的对话记录，请基于完整上下文回答用户最新消息：");
  lines.push("");

  for (const msg of history) {
    if (msg.role === "user") {
      lines.push(`【用户】: ${extractPlainText(msg.content)}`);
    } else if (msg.role === "assistant") {
      const roleName = msg.agentRole ?? "助手";
      lines.push(`【${roleName}】: ${extractPlainText(msg.content)}`);
    } else if (msg.role === "system") {
      lines.push(`【系统】: ${extractPlainText(msg.content)}`);
    }
    lines.push("");
  }

  lines.push("# 用户最新消息");
  lines.push(currentUserPrompt);
  lines.push("");
  lines.push(`# 你的任务`);
  lines.push(`你是「${targetRole.name}」，请基于以上聊天室对话历史，从你的专业角度回答用户的最新消息。`);

  return lines.join("\n");
}

function extractPlainText(content: string): string {
  const PREFIX = "__AI_WORKBENCH_MESSAGE_V1__";
  if (content.startsWith(PREFIX)) {
    try {
      const parsed = JSON.parse(content.slice(PREFIX.length));
      return typeof parsed.text === "string" ? parsed.text : content;
    } catch {
      return content;
    }
  }
  return content;
}

// ---------- 核心编排逻辑 ----------

export async function runChatroomTurn(
  req: RunChatroomTurnRequest,
  sender: Sender,
): Promise<void> {
  const { aiSessionId, projectPath, prompt, images = [], attachments = [], contexts = [], config } = req;
  // 同一会话不允许重复启动聊天室轮次，避免运行状态相互覆盖。
  if (activeChatroomRuns.has(aiSessionId)) {
    throw new Error("该聊天室会话正在运行，请等待完成或先停止。");
  }

  const runState: ChatroomRunState = {
    aiSessionId,
    cancelled: false,
    activeStepSessionIds: new Set(),
  };
  activeChatroomRuns.set(aiSessionId, runState);

  try {
    // 1. 解析 @提及，确定响应角色
    let responderIds = parseMentions(prompt, config.roles);
    if (responderIds.length === 0) {
      // 没有 @提及时，使用默认响应者
      responderIds = config.defaultResponderRoleIds;
    }
    if (responderIds.length === 0) {
      // 仍然没有响应者，让所有角色响应
      responderIds = config.roles.map((r) => r.id);
    }

    const responders = config.roles.filter((r) => responderIds.includes(r.id));

    // 2. 获取完整聊天历史
    const history = db.listLocalAiHistory(aiSessionId);

    // 3. 依次让每个被提及的角色响应
    for (const role of responders) {
      if (runState.cancelled) break;

      const stepSessionId = `${aiSessionId}__chat_${role.id}_${Date.now()}`;
      runState.activeStepSessionIds.add(stepSessionId);

      // 为这一步创建独立内部会话
      db.createLocalAiSession({
        id: stepSessionId,
        providerId: role.providerId,
        title: `[${role.name}] 聊天室响应`,
        status: "running",
        projectPath: projectPath ?? null,
      });

      emitResponse(sender, {
        aiSessionId,
        roleId: role.id,
        roleName: role.name,
        providerId: role.providerId,
        status: "running",
      });

      // 构建包含完整历史的 prompt
      const sharedPrompt = buildSharedHistoryPrompt(history, prompt, role);

      try {
        const output = await runSingleResponse(
          role,
          {
            aiSessionId: stepSessionId,
            projectPath,
            prompt: sharedPrompt,
            images: [],
            attachments: [],
            contexts: [],
          },
          sender,
        );

        if (runState.cancelled) {
          emitResponse(sender, {
            aiSessionId, roleId: role.id, roleName: role.name, providerId: role.providerId, status: "skipped",
          });
          break;
        }

        // 将角色的回复存入主会话，标注角色
        const storedOutput = output || "(该角色未返回文本内容)";
        db.appendLocalAiMessage(
          aiSessionId,
          "assistant",
          `__AI_WORKBENCH_MESSAGE_V1__${JSON.stringify({ text: storedOutput, agentRole: role.id })}`,
          role.id,
        );

        emitResponse(sender, {
          aiSessionId, roleId: role.id, roleName: role.name, providerId: role.providerId,
          status: "completed", output: storedOutput,
        });

        // 将这一步的回复加入历史，供下一个角色参考
        history.push({
          role: "assistant",
          content: storedOutput,
          createdAt: new Date().toISOString(),
          agentRole: role.id,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        emitResponse(sender, {
          aiSessionId, roleId: role.id, roleName: role.name, providerId: role.providerId,
          status: "failed", error: errorMsg,
        });
        db.appendLocalAiMessage(aiSessionId, "error", `角色「${role.name}」响应失败: ${errorMsg}`, role.id);
        // 继续让下一个角色响应，不中断
      } finally {
        runState.activeStepSessionIds.delete(stepSessionId);
        try { db.deleteLocalAiSession(stepSessionId); } catch { /* 忽略 */ }
      }
    }
  } finally {
    activeChatroomRuns.delete(aiSessionId);
  }
}

async function runSingleResponse(
  role: AgentRole,
  params: {
    aiSessionId: string;
    projectPath?: string | null;
    prompt: string;
    images?: RunCodexChatRequest["images"];
    attachments?: RunCodexChatRequest["attachments"];
    contexts?: RunCodexChatRequest["contexts"];
  },
  sender: Sender,
): Promise<string> {
  const { aiSessionId, projectPath, prompt, images, attachments, contexts } = params;
  const providerId = role.providerId;

  if (providerId === "codex") {
    const req: RunCodexChatRequest = {
      ...(role.chatOptions as RunCodexChatRequest),
      aiSessionId,
      projectPath: projectPath ?? null,
      prompt,
      images,
      attachments,
      contexts,
    };
    await runCodexChat(req, sender);
  } else {
    const req: RunAiChatRequest = {
      ...(role.chatOptions as RunAiChatRequest),
      aiSessionId,
      projectPath: projectPath ?? null,
      prompt,
      images,
      attachments,
      contexts,
    };
    if (providerId === "opencode") {
      await runOpenCodeChat(req, sender, null);
    } else if (providerId === "mimo") {
      await runMimoChat(req, sender, null);
    } else {
      await runAiChat(req, sender, null);
    }
  }

  const trace = db.getLocalAiTrace(aiSessionId, providerId === "codex" ? "codex" : providerId);
  return trace?.finalText ?? "";
}

function emitResponse(sender: Sender, event: ChatroomResponseEvent): void {
  sender.send("chatroom-response", event);
}
