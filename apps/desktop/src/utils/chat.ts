import type { ChatSegment } from "../services/tauri";

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
  return assistantDisplayLines(output, prompt)
    .join("\n")
    .trim();
}

export function assistantOutputToSegments(output: string, prompt: string): ChatSegment[] {
  const lines = assistantDisplayLines(output, prompt);
  if (!lines.length) return [];
  const segments: ChatSegment[] = [];
  let textLines: string[] = [];
  let index = 0;

  const flushText = () => {
    const text = textLines.join("\n").trim();
    if (text) segments.push({ type: "text", text });
    textLines = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const normalized = normalizeChatText(line);
    const status = parseStatusLine(normalized);
    if (status) {
      flushText();
      segments.push(status);
      index += 1;
      continue;
    }
    const tool = parseToolStart(normalized);
    if (!tool) {
      const displayLine = line.replace(/^\s*[└├│]\s?/, "").trimEnd();
      if (displayLine.trim()) textLines.push(displayLine);
      index += 1;
      continue;
    }

    flushText();
    const outputLines: string[] = [];
    index += 1;
    while (index < lines.length) {
      const nextNormalized = normalizeChatText(lines[index]);
      if (parseToolStart(nextNormalized)) break;
      if (isLikelyNarrativeLine(nextNormalized)) break;
      const outputLine = lines[index].replace(/^\s*[└├│]\s?/, "").trimEnd();
      if (outputLine.trim()) outputLines.push(outputLine);
      index += 1;
    }

    segments.push({
      type: "tool",
      toolName: tool.toolName,
      command: tool.command,
      status: "success",
      summary: tool.summary,
      output: outputLines.length ? outputLines.join("\n") : undefined,
    });
  }

  flushText();
  return segments.length ? segments : [{ type: "text", text: cleanedOutput }];
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
  return value.replace(/^[>›$❯❮┃|│•\s]+/, "").trim();
}

function stripAssistantDisplayPrefix(value: string) {
  return value.replace(/^\s*•\s?/, "");
}

function assistantDisplayLines(output: string, prompt: string) {
  const normalizedPrompt = normalizeChatText(prompt);
  const lines = output
    .split(/\r?\n/)
    .map((line) => cleanupAssistantLine(stripAssistantDisplayPrefix(line)))
    .filter((line) => shouldKeepAssistantLine(normalizeChatText(line), normalizedPrompt));
  return dedupeAdjacentLines(lines);
}

function cleanupAssistantLine(value: string) {
  return value
    .replace(/0;.*?(?=gpt-[\w.-]+|\s+•\s+~\/|$)/gi, "")
    .replace(/\??gpt-[\w.-]+(?:\s+\w+)?\s+•\s+~\/.*$/i, "")
    .replace(/^0;.*$/i, "")
    .trimEnd();
}

function dedupeAdjacentLines(lines: string[]) {
  const deduped: string[] = [];
  for (const line of lines) {
    const normalized = normalizeChatText(line);
    const previous = normalizeChatText(deduped[deduped.length - 1] ?? "");
    if (normalized && normalized === previous) continue;
    deduped.push(line);
  }
  return deduped;
}

function shouldKeepAssistantLine(normalizedLine: string, normalizedPrompt: string) {
  return (
    normalizedLine &&
    normalizedLine !== ">" &&
    normalizedLine !== normalizedPrompt &&
    normalizedLine !== `> ${normalizedPrompt}` &&
    !isPromptEchoLine(normalizedLine, normalizedPrompt) &&
    !isTerminalStatusLine(normalizedLine)
  );
}

function isPromptEchoLine(normalizedLine: string, normalizedPrompt: string) {
  if (!normalizedPrompt || !normalizedLine.includes(normalizedPrompt)) return false;
  return normalizedLine.includes("gpt-") || normalizedLine.includes("~/") || normalizedLine.startsWith(">");
}

function parseStatusLine(value: string): ChatSegment | null {
  const processed = value.match(/^Processed\s+(.+)$/i);
  if (processed) {
    return { type: "status", label: "已处理", detail: processed[1].trim(), icon: "check" };
  }

  const thinking = value.match(/^(?:Thinking|正在思考|思考中)(?:\s+(.+))?$/i);
  if (thinking) {
    return { type: "status", label: "正在思考", detail: thinking[1]?.trim(), icon: "think" };
  }

  const read = value.match(/^(?:Read|Open)\s+(.+)$/i);
  if (read) {
    return { type: "status", label: "正在读取", detail: read[1].trim(), icon: "read" };
  }

  const search = value.match(/^(?:Search|Grep|List)\s+(.+)$/i);
  if (search) {
    return { type: "status", label: "正在搜索", detail: search[1].trim(), icon: "search" };
  }

  const editedCount = value.match(/^Edited\s+(\d+)\s+file(?:s)?$/i);
  if (editedCount) {
    return { type: "status", label: "已编辑", detail: `${editedCount[1]} 个文件`, icon: "edit" };
  }

  const edited = value.match(/^Edited\s+(.+)$/i);
  if (edited) {
    return { type: "status", label: "已编辑", detail: edited[1].trim(), icon: "edit" };
  }

  const edit = value.match(/^(?:Edit|Write)\s+(.+?)(?:\s+([+-]\d+)\s+([+-]\d+))?$/i);
  if (edit) {
    return {
      type: "status",
      label: "正在编辑",
      detail: edit[1].trim(),
      icon: "edit",
      additions: edit[2] ? Math.abs(Number(edit[2])) : undefined,
      deletions: edit[3] ? Math.abs(Number(edit[3])) : undefined,
    };
  }

  return null;
}

function parseToolStart(value: string): { toolName: string; command?: string; summary?: string } | null {
  const ran = value.match(/^Ran\s+(.+)$/i);
  if (ran) {
    return { toolName: "命令", command: ran[1].trim(), summary: "已执行本地命令" };
  }
  const read = value.match(/^(?:Read|Open)\s+(.+)$/i);
  if (read) {
    return { toolName: "读取文件", command: read[1].trim(), summary: "已读取文件内容" };
  }
  const list = value.match(/^(?:List|Search|Grep)\s+(.+)$/i);
  if (list) {
    return { toolName: "浏览项目", command: list[1].trim(), summary: "已查看项目结构" };
  }
  if (value === "Explored") {
    return { toolName: "浏览项目", summary: "已探索项目目录" };
  }
  return null;
}

function isLikelyNarrativeLine(value: string) {
  if (!value) return false;
  if (value.startsWith("我") || value.startsWith("这个") || value.startsWith("目录") || value.startsWith("项目")) return true;
  if (/[\u4e00-\u9fff]/.test(value) && !/^[A-Z?]{1,2}\s/.test(value)) return true;
  return false;
}

function isTerminalStatusLine(value: string) {
  return (
    isBoxDrawingLine(value) ||
    /^0;/.test(value) ||
    value.startsWith("_ OpenAI Codex") ||
    value.startsWith("OpenAI Codex") ||
    value.includes("OpenAI Codex (") ||
    value.includes("Working") ||
    /^W(?:o|or|ork|orki|orkin)?\s*[•·.]?$/i.test(value) ||
    value.includes("tab to queue message") ||
    value.includes("context left") ||
    value.includes("esc to interrupt") ||
    value.startsWith("Use /skills") ||
    value.startsWith("/ for commands") ||
    value.startsWith("! for shell commands") ||
    value.startsWith("gpt-") ||
    value.includes("gpt-5") ||
    value.includes("~/") ||
    value.startsWith("model:") ||
    value.startsWith("directory:") ||
    value.startsWith("Tip:")
  );
}

function isBoxDrawingLine(value: string) {
  return /^[╭╮╰╯─│\s_]+$/.test(value);
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
