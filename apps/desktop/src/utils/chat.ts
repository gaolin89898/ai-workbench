export function statusText(status: string) {
  const names: Record<string, string> = {
    running: "运行中",
    idle: "空闲",
    completed: "完成",
    failed: "失败",
    missing: "不存在",
  };
  return names[status] ?? status;
}

export function cleanAssistantOutput(output: string, prompt: string) {
  const normalizedPrompt = normalizeChatText(prompt);
  return output
    .split(/\r?\n/)
    .filter((line) => {
      const normalizedLine = normalizeChatText(line);
      return (
        normalizedLine &&
        normalizedLine !== normalizedPrompt &&
        normalizedLine !== `> ${normalizedPrompt}` &&
        !isTerminalStatusLine(normalizedLine)
      );
    })
    .join("\n")
    .trim();
}

export function formatChatMessageText(text: string) {
  const lines = text.split(/\r?\n/);
  const visibleLines = lines.filter((line) => !isToolTraceLine(normalizeChatText(line)));
  const hasToolTrace = visibleLines.length !== lines.length;
  const content = visibleLines.join("\n").trim();
  if (hasToolTrace && !content) return "思考中";
  if (hasToolTrace) return `${content}\n\n思考中`;
  return text;
}

function normalizeChatText(value: string) {
  return value.replace(/^[>›$❯❮┃|│\s]+/, "").trim();
}

function isTerminalStatusLine(value: string) {
  return (
    value.includes("Working") ||
    value.includes("esc to interrupt") ||
    value.startsWith("Use /skills") ||
    value.startsWith("/ for commands") ||
    value.startsWith("! for shell commands") ||
    value.startsWith("gpt-") ||
    value.startsWith("model:") ||
    value.startsWith("directory:") ||
    value.startsWith("Tip:")
  );
}

function isToolTraceLine(value: string) {
  return (
    value === "Explored" ||
    value.startsWith("Read ") ||
    value.startsWith("List ") ||
    value.startsWith("Bash ") ||
    value.startsWith("Edit ") ||
    value.startsWith("Search ") ||
    value.startsWith("Grep ") ||
    value.startsWith("Open ") ||
    value.startsWith("Run ") ||
    value.startsWith("└") ||
    value.startsWith("├") ||
    value.startsWith("│") ||
    value.startsWith("• Explored")
  );
}
