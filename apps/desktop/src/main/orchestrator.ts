import { randomUUID } from "node:crypto";
import type {
  AgentRole,
  PipelineTemplate,
  RunPipelineChatRequest,
  PipelineStepUpdateEvent,
  RunCodexChatRequest,
  RunAiChatRequest,
} from "../services/desktop";
import { runCodexChat } from "./codex";
import { runAiChat } from "./claude";
import { runOpenCodeChat } from "./acp";
import { runMimoChat } from "./mimo";
import * as db from "./db";

type Sender = { send: (channel: string, ...args: unknown[]) => void };

// ---------- 内置角色与流水线模板 ----------

export const BUILTIN_ROLES: Record<string, Omit<AgentRole, "providerId" | "chatOptions">> = {
  planner: {
    id: "planner",
    name: "规划师",
    description: "分析需求，拆解任务，输出执行计划",
    systemPrompt:
      "你是一名资深技术规划师。请分析用户需求，拆解为具体的执行步骤，识别关键风险与依赖，并输出一份清晰的执行计划。不要直接写代码。",
  },
  coder: {
    id: "coder",
    name: "编码师",
    description: "根据计划实现代码，遵循最佳实践",
    systemPrompt:
      "你是一名资深工程师。请根据上游提供的计划或上下文，实现高质量的代码。遵循项目既有风格与最佳实践，只做必要的改动。",
  },
  reviewer: {
    id: "reviewer",
    name: "审查师",
    description: "审查代码质量、安全性与一致性",
    systemPrompt:
      "你是一名严格的代码审查者。请审查上游提供的代码或方案，重点关注：正确性、安全性、性能、可维护性。给出具体、可操作的改进建议。",
  },
  tester: {
    id: "tester",
    name: "测试师",
    description: "编写测试用例并验证实现",
    systemPrompt:
      "你是一名测试工程师。请根据上游提供的实现，编写覆盖核心路径与边界场景的测试用例，并说明验证逻辑。",
  },
};

export function listPipelineTemplates(): PipelineTemplate[] {
  return BUILTIN_PIPELINE_TEMPLATES;
}

const BUILTIN_PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "plan-code-review",
    name: "规划 → 编码 → 审查",
    description: "经典三步流水线：先规划任务，再编码实现，最后审查代码质量",
    roles: [
      { ...BUILTIN_ROLES.planner, providerId: "claude", chatOptions: { claudeModel: null, claudeMode: "default" } },
      { ...BUILTIN_ROLES.coder, providerId: "codex", chatOptions: { codexModel: null, approvalMode: "custom" } },
      { ...BUILTIN_ROLES.reviewer, providerId: "claude", chatOptions: { claudeModel: null, claudeMode: "default" } },
    ],
  },
  {
    id: "plan-code-test",
    name: "规划 → 编码 → 测试",
    description: "三步流水线：规划任务、编码实现、编写并验证测试",
    roles: [
      { ...BUILTIN_ROLES.planner, providerId: "claude", chatOptions: { claudeMode: "default" } },
      { ...BUILTIN_ROLES.coder, providerId: "codex", chatOptions: { approvalMode: "custom" } },
      { ...BUILTIN_ROLES.tester, providerId: "claude", chatOptions: { claudeMode: "default" } },
    ],
  },
  {
    id: "code-review",
    name: "编码 → 审查",
    description: "轻量两步：先编码实现，再审查改进",
    roles: [
      { ...BUILTIN_ROLES.coder, providerId: "codex", chatOptions: { approvalMode: "custom" } },
      { ...BUILTIN_ROLES.reviewer, providerId: "claude", chatOptions: { claudeMode: "default" } },
    ],
  },
];

// ---------- 运行状态管理 ----------

interface PipelineRunState {
  aiSessionId: string;
  cancelled: boolean;
  activeStepAiSessionIds: Set<string>;
}

const activePipelineRuns = new Map<string, PipelineRunState>();

export function stopPipelineChat(aiSessionId: string): boolean {
  const run = activePipelineRuns.get(aiSessionId);
  if (!run) return false;
  run.cancelled = true;
  // 停止当前正在执行的子 agent 会话
  for (const stepSessionId of run.activeStepAiSessionIds) {
    void stopStepSession(stepSessionId);
  }
  return true;
}

export function hasLivePipelineChat(): boolean {
  return activePipelineRuns.size > 0;
}

async function stopStepSession(stepSessionId: string): Promise<void> {
  // 尝试所有 provider 的 stop，命中的会返回 true
  const { stopCodexChat } = await import("./codex");
  const { stopAiChat } = await import("./claude");
  const { stopOpenCodeChat } = await import("./acp");
  const { stopMimoChat } = await import("./mimo");
  if (await stopCodexChat(stepSessionId)) return;
  if (stopOpenCodeChat(stepSessionId)) return;
  if (stopMimoChat(stepSessionId)) return;
  stopAiChat(stepSessionId);
}

// ---------- 核心编排逻辑 ----------

export async function runPipelineChat(
  req: RunPipelineChatRequest,
  sender: Sender,
): Promise<void> {
  const { aiSessionId, projectPath, prompt, images = [], attachments = [], contexts = [], pipeline } = req;
  const totalSteps = pipeline.roles.length;

  const runState: PipelineRunState = {
    aiSessionId,
    cancelled: false,
    activeStepAiSessionIds: new Set(),
  };
  activePipelineRuns.set(aiSessionId, runState);

  try {
    let accumulatedContext = prompt;

    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
      if (runState.cancelled) break;

      const role = pipeline.roles[stepIndex];
      const stepSessionId = `${aiSessionId}__step_${stepIndex}_${role.id}`;
      runState.activeStepAiSessionIds.add(stepSessionId);

      // 为这一步创建一个独立的内部 AI 会话记录
      db.createLocalAiSession({
        id: stepSessionId,
        providerId: role.providerId,
        title: `[${role.name}] 流水线步骤 ${stepIndex + 1}/${totalSteps}`,
        status: "running",
        projectPath: projectPath ?? null,
      });

      // 发送步骤开始事件
      emitStepUpdate(sender, {
        aiSessionId,
        stepIndex,
        totalSteps,
        roleId: role.id,
        roleName: role.name,
        providerId: role.providerId,
        status: "running",
      });

      // 构建这一步的 prompt：系统提示 + 上游上下文
      const stepPrompt = buildStepPrompt(role, accumulatedContext, stepIndex, totalSteps);

      try {
        const output = await runSingleStep(
          role,
          {
            aiSessionId: stepSessionId,
            projectPath,
            prompt: stepPrompt,
            images: stepIndex === 0 ? images : [],
            attachments: stepIndex === 0 ? attachments : [],
            contexts: stepIndex === 0 ? contexts : [],
          },
          sender,
        );

        if (runState.cancelled) {
          emitStepUpdate(sender, {
            aiSessionId, stepIndex, totalSteps, roleId: role.id, roleName: role.name, providerId: role.providerId, status: "skipped",
          });
          break;
        }

        // 将这一步的输出存入主会话的消息记录，并标注角色
        const storedOutput = output || "(该角色未返回文本内容)";
        db.appendLocalAiMessage(aiSessionId, "assistant", `__AI_WORKBENCH_MESSAGE_V1__${JSON.stringify({ text: storedOutput, agentRole: role.id })}`, role.id);

        accumulatedContext = output || accumulatedContext;

        emitStepUpdate(sender, {
          aiSessionId, stepIndex, totalSteps, roleId: role.id, roleName: role.name, providerId: role.providerId,
          status: "completed", output: storedOutput,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        emitStepUpdate(sender, {
          aiSessionId, stepIndex, totalSteps, roleId: role.id, roleName: role.name, providerId: role.providerId,
          status: "failed", error: errorMsg,
        });
        db.appendLocalAiMessage(aiSessionId, "error", `步骤 ${stepIndex + 1} (${role.name}) 执行失败: ${errorMsg}`, role.id);
        break;
      } finally {
        runState.activeStepAiSessionIds.delete(stepSessionId);
        // 清理步骤会话记录（避免污染会话列表）
        try { db.deleteLocalAiSession(stepSessionId); } catch { /* 忽略 */ }
      }
    }
  } finally {
    activePipelineRuns.delete(aiSessionId);
  }
}

function buildStepPrompt(role: AgentRole, accumulatedContext: string, stepIndex: number, totalSteps: number): string {
  const header = [
    `# 角色设定`,
    role.systemPrompt,
    ``,
    `# 流水线上下文`,
    `你正在一个多角色流水线中执行，当前是第 ${stepIndex + 1}/${totalSteps} 步，你的角色是「${role.name}」。`,
    ``,
  ];
  if (stepIndex === 0) {
    return [...header, `# 用户原始需求`, accumulatedContext].join("\n");
  }
  return [...header, `# 上游角色的输出`, accumulatedContext, ``, `# 你的任务`, `请基于以上内容，以「${role.name}」的职责完成你的工作。`].join("\n");
}

async function runSingleStep(
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
      aiSessionId,
      projectPath: projectPath ?? null,
      prompt,
      images,
      attachments,
      contexts,
      ...(role.chatOptions as RunCodexChatRequest),
    };
    await runCodexChat(req, sender);
  } else {
    const req: RunAiChatRequest = {
      aiSessionId,
      projectPath: projectPath ?? null,
      prompt,
      images,
      attachments,
      contexts,
      ...(role.chatOptions as RunAiChatRequest),
    };
    if (providerId === "opencode") {
      await runOpenCodeChat(req, sender, null);
    } else if (providerId === "mimo") {
      await runMimoChat(req, sender, null);
    } else {
      await runAiChat(req, sender, null);
    }
  }

  // 从 trace 中提取最终文本
  const trace = db.getLocalAiTrace(aiSessionId, providerId === "codex" ? "codex" : providerId);
  return trace?.finalText ?? "";
}

function emitStepUpdate(sender: Sender, event: PipelineStepUpdateEvent): void {
  sender.send("pipeline-step-update", event);
}
