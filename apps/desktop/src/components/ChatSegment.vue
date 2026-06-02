<script setup lang="ts">
import { computed } from "vue";
import type { ChatSegment as ChatSegmentType } from "../services/tauri";

const props = defineProps<{
  segment: ChatSegmentType;
}>();

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

function formatDuration(durationMs?: number) {
  if (!durationMs) return "";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function toolStatusText(status: "running" | "success" | "error") {
  const names = {
    running: "运行中",
    success: "完成",
    error: "失败",
  };
  return names[status];
}

function statusIcon(icon?: ChatSegmentType["icon"]) {
  const icons = {
    check: "✓",
    read: "▹",
    edit: "◇",
    search: "○",
    think: "·",
  };
  return icons[icon ?? "think"];
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

  <div v-else-if="segment.type === 'status'" class="chat-segment-status" :class="segment.icon">
    <span class="chat-segment-status-icon">{{ statusIcon(segment.icon) }}</span>
    <span>{{ segment.label }}</span>
    <strong v-if="segment.detail">{{ segment.detail }}</strong>
    <span v-if="segment.additions !== undefined" class="chat-segment-additions">+{{ segment.additions }}</span>
    <span v-if="segment.deletions !== undefined" class="chat-segment-deletions">-{{ segment.deletions }}</span>
  </div>

  <details
    v-else-if="segment.type === 'thought'"
    class="chat-segment-thought"
    :open="!(segment.collapsed ?? true)"
  >
    <summary>
      <span>{{ segment.title || "思考过程" }}</span>
      <small v-if="segment.durationMs">{{ formatDuration(segment.durationMs) }}</small>
    </summary>
    <div class="chat-segment-content">{{ segment.text }}</div>
  </details>

  <article v-else-if="segment.type === 'tool'" class="chat-segment-tool" :class="segment.status">
    <header>
      <span class="chat-segment-tool-icon" aria-hidden="true"></span>
      <div>
        <strong>{{ segment.summary || segment.toolName }}</strong>
        <code v-if="segment.command">{{ segment.command }}</code>
      </div>
      <small v-if="segment.status !== 'success'">
        {{ toolStatusText(segment.status) }}
        <template v-if="segment.durationMs"> · {{ formatDuration(segment.durationMs) }}</template>
      </small>
    </header>
    <p v-if="segment.additions !== undefined || segment.deletions !== undefined" class="chat-segment-change-counts">
      <span v-if="segment.additions !== undefined" class="chat-segment-additions">+{{ segment.additions }}</span>
      <span v-if="segment.deletions !== undefined" class="chat-segment-deletions">-{{ segment.deletions }}</span>
    </p>
    <details v-if="segment.input" class="chat-segment-detail">
      <summary>查看输入</summary>
      <pre>{{ segment.input }}</pre>
    </details>
    <details v-if="segment.output" class="chat-segment-detail">
      <summary>查看输出</summary>
      <pre>{{ segment.output }}</pre>
    </details>
  </article>

  <article v-else-if="segment.type === 'error'" class="chat-segment-error">
    <strong>{{ segment.title || "执行出错" }}</strong>
    <p>{{ segment.message }}</p>
    <details v-if="segment.detail" class="chat-segment-detail">
      <summary>查看详情</summary>
      <pre>{{ segment.detail }}</pre>
    </details>
  </article>
</template>
