import type { ChatContextAttachment } from "../services/desktop";

function codeSource(context: Extract<ChatContextAttachment, { kind: "code" }>) {
  if (!context.startLine) return context.path;
  const endLine = context.endLine && context.endLine !== context.startLine ? `-${context.endLine}` : "";
  return `${context.path}:${context.startLine}${endLine}`;
}

export function formatChatContext(context: ChatContextAttachment) {
  if (context.kind === "file") return `引用文件路径：${context.path}`;
  if (context.kind === "folder") return `引用文件夹路径：${context.path}`;
  if (context.kind === "code") {
    return [`代码选区（${codeSource(context)}）：`, "<code_context>", context.content, "</code_context>"].join("\n");
  }
  return [`终端选区（${context.name}）：`, "<terminal_context>", context.content, "</terminal_context>"].join("\n");
}

export function appendChatContexts(prompt: string, contexts: ChatContextAttachment[] = []) {
  if (!contexts.length) return prompt;
  const contextText = contexts.map(formatChatContext).join("\n\n");
  return prompt ? `${prompt}\n\n以下是用户添加的上下文：\n${contextText}` : `请查看以下上下文：\n${contextText}`;
}
