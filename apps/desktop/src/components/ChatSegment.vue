<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspace } from "../composables/useWorkspace";
import { desktopApi } from "../services/desktop";
import type { ChatSegment as ChatSegmentType } from "../services/desktop";
import { extractAssistantText } from "../utils/chat";

const props = defineProps<{
  segment: ChatSegmentType;
  aiSessionId?: string;
}>();
const ws = useWorkspace();
const clipboardIcon = new URL("../assets/icons/clipboard.svg", import.meta.url).href;

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string }
  | { type: "quote"; text: string }
  | { type: "rule" }
  | { type: "table"; rows: string[][]; header: boolean };

const renderedTextBlocks = computed(() => {
  if (props.segment.type !== "text") return [];
  return parseMarkdownBlocks(props.segment.text);
});

type DiffLine = {
  type: "add" | "delete" | "context";
  text: string;
  lineNumber?: number;
};

const toolDiffLines = computed<DiffLine[]>(() => {
  if (props.segment.type !== "tool") return [];
  const diff = toolDiffText(props.segment);
  return diff ? parseDiffLines(diff) : [];
});
const toolHasDiff = computed(() => props.segment.type === "tool" && toolDiffLines.value.length > 0);
const toolDiffInfo = computed(() => {
  if (props.segment.type !== "tool") return null;
  const diff = toolDiffText(props.segment);
  const files = patchFileList(diff);
  const stats = diffStats(diff);
  const name = files.length === 1
    ? files[0].split(/[\\/]/).pop() || files[0]
    : files.length > 1 ? `${files.length} 个文件` : "代码更改";
  return { name, ...stats };
});
const copiedDiff = ref(false);

async function copyToolDiff() {
  if (props.segment.type !== "tool") return;
  const code = toolDiffLines.value.map((line) => {
    const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
    return `${prefix}${line.text}`;
  }).join("\n");
  await navigator.clipboard.writeText(code);
  copiedDiff.value = true;
  window.setTimeout(() => {
    copiedDiff.value = false;
  }, 1200);
}

const approvalBusy = computed(() => props.segment.type === "approval" && props.segment.status !== "pending");
const statusDisplay = computed(() => {
  if (props.segment.type !== "status") return null;
  if (isContextCompactionStatus(props.segment.rawItemType, props.segment.label)) {
    return {
      label: props.segment.status === "completed" ? "已压缩上下文" : "正在压缩上下文",
      detail: props.segment.detail || "正在整理较长会话内容，保留关键上下文。",
      icon: "compact",
    };
  }
  return {
    label: isUserStoppedStatus(props.segment) ? "用户主动停止" : props.segment.label,
    detail: props.segment.detail,
    icon: props.segment.icon,
  };
});
const statusClasses = computed(() => {
  if (props.segment.type !== "status") return [];
  return [
    statusDisplay.value?.icon,
    isUserStoppedStatus(props.segment) ? "danger" : "",
  ].filter(Boolean);
});

function isContextCompactionStatus(rawItemType?: string | null, label?: string) {
  return /^(?:contextCompaction|context_compaction)$/i.test(rawItemType ?? "")
    || /contextCompaction|context_compaction/i.test(label ?? "");
}

function isUserStoppedStatus(segment: Extract<ChatSegmentType, { type: "status" }>) {
  return segment.stepId === "interrupted"
    || segment.status === "canceled"
    || segment.label === "用户主动停止"
    || segment.label === "已中断";
}

function formatDuration(durationMs?: number) {
  if (!durationMs) return "";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function toolLineTitle(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  const patchFiles = patchFileList(toolDiffText(segment));
  const command = normalizeCommand(segment.command).replace(/\s+/g, " ").trim();
  const displayCommand = patchFiles.length ? shortFileList(patchFiles) : commandDisplayText(segment.command);
  const statusVerb = segment.status === "running" ? "正在" : "已";
  if (isStdinContinuationSegment(segment)) {
    if (segment.status === "error") return "读取命令输出失败";
    return segment.status === "running" ? "正在读取命令输出" : "已读取命令输出";
  }
  if (isUserMessageSegment(segment)) {
    if (segment.status === "error") return "处理失败";
    return segment.status === "running" ? "正在处理" : "已处理";
  }
  if (segment.toolName.includes("扫描")) {
    if (segment.status === "error") return "扫描项目失败";
    return segment.status === "running" ? "正在扫描项目" : "已扫描项目";
  }
  if (segment.toolName.includes("修改") || segment.toolName.includes("文件")) {
    if (segment.status === "error") return displayCommand ? `修改 ${displayCommand} 失败` : "修改文件失败";
    return displayCommand
      ? `${segment.status === "running" ? "正在修改" : "已修改"} ${displayCommand}`
      : (segment.status === "running" ? "正在处理文件修改" : "已处理文件修改");
  }
  if (segment.toolName.includes("命令") || segment.command) {
    const operation = commandOperationTitle(command, segment.status);
    if (operation) return operation;
    if (segment.status === "error") return displayCommand ? `运行失败 ${displayCommand}` : "运行命令失败";
    return displayCommand ? `${statusVerb}运行 ${displayCommand}` : `${statusVerb}运行命令`;
  }
  if (segment.status === "error") return `处理失败 ${segment.toolName}`;
  return `${statusVerb}处理 ${segment.toolName}`;
}

function toolLineMeta(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  const parts: Array<{ kind: "add" | "delete" | "error" | "duration"; text: string }> = [];
  const stats = diffStats(toolDiffText(segment));
  const additions = segment.additions ?? stats.additions;
  const deletions = segment.deletions ?? stats.deletions;
  if (additions !== undefined) parts.push({ kind: "add", text: `+${additions}` });
  if (deletions !== undefined) parts.push({ kind: "delete", text: `-${deletions}` });
  if (segment.status === "error") parts.push({ kind: "error", text: "失败" });
  if (segment.durationMs !== undefined) {
    const duration = formatDuration(segment.durationMs);
    if (duration) parts.push({ kind: "duration", text: duration });
  }
  return parts;
}

function toolHasDetails(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  return Boolean(segment.command || segment.summary || toolVisibleInput(segment) || toolVisibleOutput(segment) || toolDiffText(segment));
}

function toolShowCommand(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  return !toolDiffText(segment) && Boolean(segment.command);
}

function toolShowSummary(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  return !toolDiffText(segment) && Boolean(segment.summary);
}

function toolShowInput(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  return !toolDiffText(segment) && Boolean(toolVisibleInput(segment));
}

function toolShowOutput(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  return !toolDiffText(segment) && Boolean(toolVisibleOutput(segment));
}

function toolDetailText(segment: Extract<ChatSegmentType, { type: "tool" }>, value?: string) {
  const text = extractAssistantText(value ?? "");
  if (isUserMessageSegment(segment)) return extractUserRequest(text);
  return text;
}

function isUserMessageSegment(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  return /(?:^|[:\s])(?:userMessage|user_message)(?:$|[:\s])/i.test(segment.toolName)
    || /(?:^|[:\s])(?:userMessage|user_message)(?:$|[:\s])/i.test(segment.summary ?? "");
}

function isStdinContinuationSegment(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  const input = segment.input ?? "";
  return segment.toolName === "文件修改"
    && input.includes("\"session_id\"")
    && input.includes("\"yield_time_ms\"")
    && input.includes("\"max_output_tokens\"");
}

function extractUserRequest(text: string) {
  const match = text.match(/用户请求[：:]\s*([\s\S]*)$/);
  return (match?.[1] ?? text).trim();
}

function commandDisplayText(command?: string) {
  if (!command) return "";
  const unquoted = normalizeCommand(command).replace(/\s+/g, " ").trim();
  const display = isPowerShellCommand(command) ? `PowerShell: ${unquoted}` : unquoted;
  return display;
}

function normalizeCommand(command?: string) {
  if (!command) return "";
  const cleaned = unquoteCommand(command
    .replace(/^\/usr\/bin\/(?:bash|sh)\s+-lc\s+/, "")
    .replace(/^bash\s+-lc\s+/, "")
    .trim());
  const powershell = cleaned.match(/^(?:"?[^"]*\\powershell(?:\.exe)?"?\s+)?-Command\s+([\s\S]+)$/i);
  return unquoteCommand((powershell ? powershell[1] : cleaned).trim());
}

function isPowerShellCommand(command?: string) {
  return /(?:^|\\)powershell(?:\.exe)?"?\s+-Command/i.test(command ?? "");
}

function commandOperationTitle(command: string, status: string) {
  const verb = status === "running" ? "正在" : "已";
  if (/^(?:Get-Content|cat|type|head|tail|sed\b|Select-String\b)/i.test(command)) {
    if (status === "error") return `读取失败 ${command}`;
    return `${verb}读取 ${command}`;
  }
  if (/^(?:rg|grep|findstr|fd|find\b|Get-ChildItem|ls\b|dir\b)/i.test(command)) {
    if (status === "error") return `搜索失败 ${command}`;
    return `${verb}搜索 ${command}`;
  }
  if (/\b(?:Get-Content|cat|type)\b/i.test(command)) {
    if (status === "error") return `读取失败 ${command}`;
    return `${verb}读取 ${command}`;
  }
  if (/\b(?:rg|grep|findstr|Get-ChildItem)\b/i.test(command)) {
    if (status === "error") return `搜索失败 ${command}`;
    return `${verb}搜索 ${command}`;
  }
  return "";
}

function unquoteCommand(command: string) {
  return command.replace(/^["'](.+)["']$/, "$1");
}

function toolDiffText(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  if (segment.diff?.trim()) return segment.diff;
  const input = segment.input?.trim() ?? "";
  return input.startsWith("*** Begin Patch") ? input : "";
}

function toolVisibleInput(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  return toolDiffText(segment) ? "" : segment.input;
}

function toolVisibleOutput(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  return cleanToolOutput(segment.output ?? "");
}

function cleanToolOutput(output: string) {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const outputIndex = lines.findIndex((line) => line.trim() === "Output:");
  const visibleLines = (outputIndex >= 0 ? lines.slice(outputIndex + 1) : lines).filter((line) => {
    const trimmed = line.trim();
    if (/^(Chunk ID|Wall time|Process exited with code|Original token count):/.test(trimmed)) return false;
    if (trimmed === "Output:") return false;
    if (trimmed === "Failed to create stream fd: Operation not permitted") return false;
    return true;
  });
  return visibleLines.join("\n").trim();
}

function patchFileList(diff: string) {
  const files: string[] = [];
  const seen = new Set<string>();
  const pushFile = (value?: string) => {
    const file = cleanDiffFilePath(value ?? "");
    if (!file || seen.has(file)) return;
    seen.add(file);
    files.push(file);
  };
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    const patchFile = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (patchFile) {
      pushFile(patchFile[1]);
      continue;
    }
    const gitFile = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
    if (gitFile) {
      pushFile(gitFile[2] || gitFile[1]);
      continue;
    }
    const newFile = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (newFile) pushFile(newFile[1]);
  }
  return files;
}

function cleanDiffFilePath(path: string) {
  const cleaned = path.trim().replace(/^"|"$/g, "");
  if (!cleaned || cleaned === "/dev/null") return "";
  return cleaned.replace(/^[ab]\//, "");
}

function shortFileList(files: string[]) {
  if (files.length <= 2) return files.join(", ");
  return `${files.slice(0, 2).join(", ")} 等 ${files.length} 个`;
}

function diffStats(diff: string): { additions?: number; deletions?: number } {
  if (!diff.trim()) return {};
  let additions = 0;
  let deletions = 0;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function parseDiffLines(diff: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let inHunk = false;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (isPatchWrapperLine(line) || line.startsWith("\\ No newline at end of file")) continue;
    if (/^\*\*\* (?:Add|Update|Delete) File: /.test(line) || line.startsWith("diff ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("index ")
      || line.startsWith("---")
      || line.startsWith("+++")) continue;
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) {
      oldLine = undefined;
      newLine = undefined;
      inHunk = true;
      continue;
    }
    if (!inHunk && !line.startsWith("+") && !line.startsWith("-")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({ type: "add", text: line.slice(1), lineNumber: newLine });
      if (newLine !== undefined) newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      result.push({ type: "delete", text: line.slice(1), lineNumber: oldLine });
      if (oldLine !== undefined) oldLine += 1;
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    result.push({ type: "context", text, lineNumber: newLine });
    if (oldLine !== undefined) oldLine += 1;
    if (newLine !== undefined) newLine += 1;
  }
  return result;
}

function isPatchWrapperLine(line: string) {
  return line.startsWith("*** Begin Patch")
    || line.startsWith("*** End Patch");
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let codeLines: string[] = [];
  let quoteLines: string[] = [];
  let tableRows: string[][] = [];
  let inCode = false;

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;
    blocks.push({ type: "list", ordered: listOrdered, items: listItems });
    listItems = [];
  }

  function flushQuote() {
    if (!quoteLines.length) return;
    blocks.push({ type: "quote", text: quoteLines.join("\n").trim() });
    quoteLines = [];
  }

  function flushTable() {
    if (!tableRows.length) return;
    const hasDivider = tableRows.length > 1 && tableRows[1].every((cell) => /^:?-{3,}:?$/.test(cell));
    blocks.push({
      type: "table",
      rows: hasDivider ? [tableRows[0], ...tableRows.slice(2)] : tableRows,
      header: hasDivider,
    });
    tableRows = [];
  }

  function flushAllInlineBlocks() {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  }

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        blocks.push({ type: "code", text: codeLines.join("\n") });
        codeLines = [];
        inCode = false;
      } else {
        flushAllInlineBlocks();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushAllInlineBlocks();
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      flushAllInlineBlocks();
      blocks.push({ type: "rule" });
      continue;
    }
    const hashHeading = trimmed.match(/^(#{2,3})\s+(.+)$/);
    if (hashHeading) {
      flushAllInlineBlocks();
      blocks.push({ type: "heading", level: hashHeading[1].length as 2 | 3, text: hashHeading[2] });
      continue;
    }
    const heading = trimmed.match(/^\*\*(.+)\*\*$/);
    if (heading) {
      flushAllInlineBlocks();
      blocks.push({ type: "heading", level: 3, text: heading[1] });
      continue;
    }
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      flushTable();
      quoteLines.push(quote[1]);
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushParagraph();
      flushList();
      flushQuote();
      tableRows.push(trimmed.slice(1, -1).split("|").map((cell) => cell.trim()));
      continue;
    }
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      flushTable();
      const isOrdered = Boolean(ordered);
      if (listItems.length && listOrdered !== isOrdered) flushList();
      listOrdered = isOrdered;
      listItems.push((ordered?.[1] ?? unordered?.[1] ?? "").trim());
      continue;
    }
    flushList();
    flushQuote();
    flushTable();
    paragraph.push(line);
  }
  flushAllInlineBlocks();
  if (inCode) blocks.push({ type: "code", text: codeLines.join("\n") });
  return blocks;
}

function inlineParts(text: string) {
  const parts: Array<{ code?: boolean; strong?: boolean; text: string }> = [];
  const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) parts.push({ code: false, text: text.slice(lastIndex, match.index) });
    if (match[2]) {
      parts.push({ code: true, text: match[2] });
    } else if (match[4]) {
      parts.push({ strong: true, text: match[4] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ code: false, text: text.slice(lastIndex) });
  return parts;
}

function approvalMeta(segment: Extract<ChatSegmentType, { type: "approval" }>) {
  const parts: string[] = [];
  if (segment.cwd) parts.push(`目录 ${segment.cwd}`);
  if (segment.grantRoot) parts.push(`授权目录 ${segment.grantRoot}`);
  if (segment.fileChanges?.length) parts.push(`${segment.fileChanges.length} 个文件`);
  return parts.join(" · ");
}

function approvalStatusLabel(segment: Extract<ChatSegmentType, { type: "approval" }>) {
  if (segment.status === "approved") return "已同意";
  if (segment.status === "denied") return "已拒绝";
  if (segment.status === "expired") return "已过期";
  if (segment.status === "failed") return "审批失败";
  return "待审批";
}

function approvalKindLabel(segment: Extract<ChatSegmentType, { type: "approval" }>) {
  if (segment.approvalKind === "fileChange") return "文件修改";
  if (segment.approvalKind === "command") return "命令执行";
  return "工具操作";
}

function approvalProviderLabel(segment: Extract<ChatSegmentType, { type: "approval" }>) {
  if (segment.providerId === "mimo") return "MiMo Code";
  if (segment.providerId === "opencode") return "OpenCode";
  if (segment.providerId === "claude") return "Claude";
  return "Codex";
}

async function respondApproval(decision: "approved" | "denied") {
  if (props.segment.type !== "approval" || !props.aiSessionId || props.segment.status !== "pending") return;
  try {
    const handled = await desktopApi.respondAiApproval({
      aiSessionId: props.aiSessionId,
      approvalId: props.segment.approvalId,
      decision,
    });
    if (!handled) {
      ws.expirePendingApproval(props.aiSessionId, props.segment.approvalId);
    }
  } catch {
    ws.expirePendingApproval(props.aiSessionId, props.segment.approvalId);
  }
}
</script>

<template>
  <article v-if="segment.type === 'text'" class="chat-segment-text chat-markdown">
    <template v-for="(block, blockIndex) in renderedTextBlocks" :key="blockIndex">
      <h2 v-if="block.type === 'heading' && block.level === 2">
        <template v-for="(part, partIndex) in inlineParts(block.text)" :key="partIndex">
          <code v-if="part.code">{{ part.text }}</code>
          <strong v-else-if="part.strong">{{ part.text }}</strong>
          <span v-else>{{ part.text }}</span>
        </template>
      </h2>
      <h3 v-else-if="block.type === 'heading'">
        <template v-for="(part, partIndex) in inlineParts(block.text)" :key="partIndex">
          <code v-if="part.code">{{ part.text }}</code>
          <strong v-else-if="part.strong">{{ part.text }}</strong>
          <span v-else>{{ part.text }}</span>
        </template>
      </h3>
      <p v-else-if="block.type === 'paragraph'">
        <template v-for="(part, partIndex) in inlineParts(block.text)" :key="partIndex">
          <code v-if="part.code">{{ part.text }}</code>
          <strong v-else-if="part.strong">{{ part.text }}</strong>
          <span v-else>{{ part.text }}</span>
        </template>
      </p>
      <pre v-else-if="block.type === 'code'"><code>{{ block.text }}</code></pre>
      <blockquote v-else-if="block.type === 'quote'">
        <template v-for="(part, partIndex) in inlineParts(block.text)" :key="partIndex">
          <code v-if="part.code">{{ part.text }}</code>
          <strong v-else-if="part.strong">{{ part.text }}</strong>
          <span v-else>{{ part.text }}</span>
        </template>
      </blockquote>
      <hr v-else-if="block.type === 'rule'" />
      <div v-else-if="block.type === 'table'" class="chat-markdown-table-wrap">
        <table>
          <thead v-if="block.header && block.rows[0]">
            <tr>
              <th v-for="(cell, cellIndex) in block.rows[0]" :key="cellIndex">
                <template v-for="(part, partIndex) in inlineParts(cell)" :key="partIndex">
                  <code v-if="part.code">{{ part.text }}</code>
                  <strong v-else-if="part.strong">{{ part.text }}</strong>
                  <span v-else>{{ part.text }}</span>
                </template>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in (block.header ? block.rows.slice(1) : block.rows)" :key="rowIndex">
              <td v-for="(cell, cellIndex) in row" :key="cellIndex">
                <template v-for="(part, partIndex) in inlineParts(cell)" :key="partIndex">
                  <code v-if="part.code">{{ part.text }}</code>
                  <strong v-else-if="part.strong">{{ part.text }}</strong>
                  <span v-else>{{ part.text }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ol v-else-if="block.ordered">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <template v-for="(part, partIndex) in inlineParts(item)" :key="partIndex">
            <code v-if="part.code">{{ part.text }}</code>
            <strong v-else-if="part.strong">{{ part.text }}</strong>
            <span v-else>{{ part.text }}</span>
          </template>
        </li>
      </ol>
      <ul v-else>
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <template v-for="(part, partIndex) in inlineParts(item)" :key="partIndex">
            <code v-if="part.code">{{ part.text }}</code>
            <strong v-else-if="part.strong">{{ part.text }}</strong>
            <span v-else>{{ part.text }}</span>
          </template>
        </li>
      </ul>
    </template>
  </article>

  <div v-else-if="segment.type === 'status'" class="chat-segment-status" :class="statusClasses">
    <span>{{ statusDisplay?.label }}</span>
    <strong v-if="statusDisplay?.detail">{{ statusDisplay.detail }}</strong>
    <span v-if="segment.additions !== undefined" class="chat-segment-additions">+{{ segment.additions }}</span>
    <span v-if="segment.deletions !== undefined" class="chat-segment-deletions">-{{ segment.deletions }}</span>
  </div>

  <details
    v-else-if="segment.type === 'thought' && segment.title"
    class="chat-segment-thought"
    :open="!(segment.collapsed ?? true)"
  >
    <summary>
      <span>{{ segment.title }}</span>
      <small v-if="segment.durationMs">{{ formatDuration(segment.durationMs) }}</small>
    </summary>
    <div class="chat-segment-content">{{ segment.text }}</div>
  </details>

  <div v-else-if="segment.type === 'thought'" class="chat-segment-thought untitled">
    <div class="chat-segment-content">{{ segment.text }}</div>
  </div>

  <div v-else-if="segment.type === 'goal'" class="chat-segment-goal">
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.35" />
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.35" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
    </svg>
    <span>目标: {{ segment.objective }}</span>
  </div>

  <article v-else-if="segment.type === 'plan'" class="chat-segment-plan">
    <header class="chat-segment-plan-header">
      <div class="chat-segment-plan-kicker">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.25 2.75h5.5L12.5 5.5v7.75h-8.25V2.75Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
          <path d="M9.75 2.75V5.5h2.75M6.25 8h4M6.25 10.5h4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>计划</span>
      </div>
    </header>
    <div class="chat-segment-plan-body">
      <h3>{{ segment.title }}</h3>
      <section v-if="segment.summary">
        <strong>SUMMARY</strong>
        <p>{{ segment.summary }}</p>
      </section>
      <section>
        <strong>KEY CHANGES</strong>
        <ul>
          <li v-for="(step, index) in segment.steps" :key="index" :class="`status-${step.status}`">
            <span>{{ step.step }}</span>
          </li>
        </ul>
      </section>
    </div>
  </article>

  <template v-else-if="segment.type === 'tool'">
    <article v-if="toolHasDiff" class="chat-segment-tool-diff-only">
      <header class="chat-segment-diff-header">
        <strong>{{ toolDiffInfo?.name }}</strong>
        <span v-if="toolDiffInfo?.additions !== undefined" class="chat-segment-additions">+{{ toolDiffInfo.additions }}</span>
        <span v-if="toolDiffInfo?.deletions !== undefined" class="chat-segment-deletions">-{{ toolDiffInfo.deletions }}</span>
        <button type="button" :title="copiedDiff ? '已复制' : '复制代码更改'" :aria-label="copiedDiff ? '已复制代码更改' : '复制代码更改'" @click="copyToolDiff">
          <img :src="clipboardIcon" alt="" />
        </button>
      </header>
      <div class="chat-segment-diff">
        <div
          v-for="(line, lineIndex) in toolDiffLines"
          :key="lineIndex"
          class="chat-segment-diff-line"
          :class="line.type"
        >
          <span class="chat-segment-diff-line-number">{{ line.lineNumber ?? "" }}</span>
          <span class="chat-segment-diff-marker">{{ line.type === "add" ? "+" : line.type === "delete" ? "-" : " " }}</span>
          <code>{{ line.text || " " }}</code>
        </div>
      </div>
    </article>
    <details
      v-else-if="toolHasDetails(segment)"
      class="chat-segment-tool expandable"
      :class="segment.status"
    >
      <summary class="chat-segment-tool-line">
        <span class="chat-segment-tool-copy" :class="{ shimmer: segment.status === 'running' }">
          <strong :title="toolLineTitle(segment)">{{ toolLineTitle(segment) }}</strong>
          <small v-if="toolLineMeta(segment).length" class="chat-segment-tool-meta">
            <span
              v-for="(item, itemIndex) in toolLineMeta(segment)"
              :key="itemIndex"
              :class="`meta-${item.kind}`"
            >{{ item.text }}</span>
          </small>
        </span>
        <svg class="chat-segment-tool-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </summary>
      <div class="chat-segment-tool-details">
        <section v-if="toolShowCommand(segment)" class="chat-segment-output-block">
          <strong>命令</strong>
          <pre>{{ segment.command }}</pre>
        </section>
        <section v-if="toolShowSummary(segment)" class="chat-segment-output-block">
          <strong>说明</strong>
          <pre>{{ segment.summary }}</pre>
        </section>
        <section v-if="toolShowInput(segment)" class="chat-segment-output-block">
          <strong>输入</strong>
          <pre>{{ toolDetailText(segment, toolVisibleInput(segment)) }}</pre>
        </section>
        <section v-if="toolShowOutput(segment)" class="chat-segment-output-block">
          <strong>输出</strong>
          <pre>{{ toolDetailText(segment, toolVisibleOutput(segment)) }}</pre>
        </section>
      </div>
    </details>
    <div v-else class="chat-segment-tool" :class="segment.status">
      <div class="chat-segment-tool-line">
        <span class="chat-segment-tool-copy" :class="{ shimmer: segment.status === 'running' }">
          <strong :title="toolLineTitle(segment)">{{ toolLineTitle(segment) }}</strong>
          <small v-if="toolLineMeta(segment).length" class="chat-segment-tool-meta">
            <span
              v-for="(item, itemIndex) in toolLineMeta(segment)"
              :key="itemIndex"
              :class="`meta-${item.kind}`"
            >{{ item.text }}</span>
          </small>
        </span>
      </div>
    </div>
  </template>

  <article v-else-if="segment.type === 'error'" class="chat-segment-error">
    <strong>{{ segment.title || "执行出错" }}</strong>
    <p>{{ segment.message }}</p>
    <details v-if="segment.detail" class="chat-segment-detail">
      <summary>查看详情</summary>
      <pre>{{ segment.detail }}</pre>
    </details>
  </article>

  <article v-else-if="segment.type === 'approval'" class="chat-segment-approval" :class="segment.status">
    <div class="chat-segment-approval-accent" aria-hidden="true"></div>
    <div class="chat-segment-approval-header">
      <div class="chat-segment-approval-title-row">
        <span class="chat-segment-approval-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M8 1.8 13.2 4v3.8c0 3.1-2.1 5.4-5.2 6.4-3.1-1-5.2-3.3-5.2-6.4V4L8 1.8Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            <path d="M5.6 8.3 7.1 9.8 10.5 6.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <div class="chat-segment-approval-copy">
          <div class="chat-segment-approval-meta-row">
            <span class="chat-segment-approval-badge">{{ approvalStatusLabel(segment) }}</span>
            <small>审批期间输入框已锁定，处理后恢复发送。</small>
          </div>
          <strong>{{ segment.title || "需要确认 AI 工具操作" }}</strong>
          <span class="chat-segment-approval-subtitle">{{ approvalProviderLabel(segment) }} · {{ approvalKindLabel(segment) }} · 本次会话</span>
        </div>
      </div>
      <svg class="chat-segment-approval-corner" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.8 13.2 4v3.8c0 3.1-2.1 5.4-5.2 6.4-3.1-1-5.2-3.3-5.2-6.4V4L8 1.8Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        <path d="M8 5.1v3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path d="M8 11.1h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    </div>
    <p v-if="segment.reason" class="chat-segment-approval-reason">{{ segment.reason }}</p>
    <p v-else class="chat-segment-approval-reason">AI 工具准备执行可能影响项目的操作，请确认是否允许本次操作。</p>
    <div class="chat-segment-approval-body">
      <div v-if="segment.command" class="chat-segment-approval-panel command">
        <div class="chat-segment-approval-panel-head">
          <span>command</span>
        </div>
        <code>{{ segment.command }}</code>
      </div>
      <div v-if="segment.fileChanges?.length" class="chat-segment-approval-panel files">
        <div class="chat-segment-approval-panel-head">
          <span>可能影响文件</span>
        </div>
        <ul>
          <li v-for="file in segment.fileChanges.slice(0, 6)" :key="file">{{ file }}</li>
        </ul>
      </div>
    </div>
    <p v-if="segment.detail" class="chat-segment-approval-detail">{{ segment.detail }}</p>
    <div class="chat-segment-approval-actions">
      <button type="button" class="button secondary" :disabled="approvalBusy || !aiSessionId" @click="respondApproval('denied')">拒绝</button>
      <button type="button" class="button primary" :disabled="approvalBusy || !aiSessionId" @click="respondApproval('approved')">允许执行</button>
    </div>
  </article>
</template>
