<script setup lang="ts">
import { computed } from "vue";
import ChatSegment from "./ChatSegment.vue";
import type { ChatMessage, ChatSegment as ChatSegmentType } from "../services/desktop";
import { assistantOutputToSegments, extractAssistantText, formatChatMessageText } from "../utils/chat";

const props = defineProps<{
  message: ChatMessage;
}>();

const rawSegments = computed<ChatSegmentType[]>(() => {
  const messageText = extractAssistantText(props.message.text ?? "").trim();
  if (props.message.segments?.length) {
    if (props.message.role !== "assistant" || !messageText) return props.message.segments;
    const processOnlySegments = props.message.segments.filter((segment) => segment.type !== "text");
    return [...processOnlySegments, { type: "text", text: messageText }];
  }
  if (props.message.role === "assistant") {
    return assistantOutputToSegments(messageText, "");
  }
  return [{ type: "text", text: formatChatMessageText(props.message.text ?? "") }];
});

const segments = computed<ChatSegmentType[]>(() => normalizeHistoricalCommandOutputSegments(rawSegments.value));

const processSummary = computed(() => {
  return segments.value.find((segment) => segment.type === "status" && segment.stepId === "final-summary");
});

type RenderGroup =
  | { type: "segment"; segment: ChatSegmentType }
  | { type: "process"; segments: ChatSegmentType[] };

const visibleSegments = computed<ChatSegmentType[]>(() => {
  const isUserImageOnly = props.message.role === "user"
    && props.message.images?.length
    && isImageOnlyPromptText(props.message.text ?? "");
  return segments.value.filter((segment) => {
    if (segment.stepId === "runtime-status" || segment.stepId === "initial-thinking") return false;
    if (segment === processSummary.value) return false;
    if (isUserImageOnly && segment.type === "text" && isImageOnlyPromptText(segment.text)) return false;
    return true;
  });
});

const contentGroups = computed<RenderGroup[]>(() => {
  const groups: RenderGroup[] = [];
  let processRun: ChatSegmentType[] = [];
  for (const segment of visibleSegments.value) {
    if (isProcessSegment(segment)) {
      processRun.push(segment);
      continue;
    }
    if (processRun.length) {
      groups.push({ type: "process", segments: processRun });
      processRun = [];
    }
    groups.push({ type: "segment", segment });
  }
  if (processRun.length) groups.push({ type: "process", segments: processRun });
  return groups;
});

function isProcessSegment(segment: ChatSegmentType) {
  return segment.type === "tool" || segment.type === "status" || segment.type === "thought" || segment.type === "error";
}

function isImageOnlyPromptText(text: string) {
  return /^查看这\s*\d+\s*张图片$/.test(text.trim());
}

function collectAdjacentCommandOutput(sourceSegments: ChatSegmentType[], startIndex: number, command?: string) {
  const outputLines: string[] = [];
  let lastIndex = startIndex - 1;
  for (let index = startIndex; index < sourceSegments.length; index += 1) {
    const segment = sourceSegments[index];
    if (segment.type !== "text") break;
    const candidate = [...outputLines, segment.text].join("\n").trim();
    if (!isLikelyCommandOutputText(candidate, command)) {
      if (outputLines.length && isLikelyCommandOutputContinuation(segment.text)) {
        outputLines.push(segment.text.trim());
        lastIndex = index;
        continue;
      }
      break;
    }
    outputLines.push(segment.text.trim());
    lastIndex = index;
  }
  return {
    output: outputLines.join("\n").trim(),
    lastIndex,
  };
}

function normalizeLegacyToolTitleSegments(sourceSegments: ChatSegmentType[]) {
  const normalized: ChatSegmentType[] = [];
  for (let index = 0; index < sourceSegments.length; index += 1) {
    const segment = sourceSegments[index];
    const nextSegment = sourceSegments[index + 1];
    if (segment.type === "text" && nextSegment?.type === "text") {
      const command = parseLegacyRanCommand(segment.text);
      const outputMerge = command ? collectAdjacentCommandOutput(sourceSegments, index + 1, command) : { output: "", lastIndex: index };
      if (command && outputMerge.output) {
        normalized.push({
          type: "tool",
          toolName: "命令",
          command,
          status: "success",
          summary: "已执行本地命令",
          output: outputMerge.output,
        });
        index = outputMerge.lastIndex;
        continue;
      }
    }
    normalized.push(segment);
  }
  return normalized;
}

function normalizeHistoricalCommandOutputSegments(sourceSegments: ChatSegmentType[]) {
  const titleNormalized = normalizeLegacyToolTitleSegments(sourceSegments);
  const normalized: ChatSegmentType[] = [];
  for (let index = 0; index < titleNormalized.length; index += 1) {
    const segment = titleNormalized[index];
    if (segment.type === "tool" && isCommandLikeTool(segment)) {
      const outputMerge = collectAdjacentCommandOutput(titleNormalized, index + 1, segment.command);
      if (outputMerge.output) {
        normalized.push({
          ...segment,
          output: joinToolOutput(segment.output, outputMerge.output),
          summary: segment.summary ?? "已执行本地命令",
        });
        index = outputMerge.lastIndex;
        continue;
      }
    }
    normalized.push(segment);
  }
  return normalized;
}

function parseLegacyRanCommand(text: string) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return "";
  const match = lines[0].match(/^(?:已运行|Ran)\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function isCommandLikeTool(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  const name = segment.toolName.toLowerCase();
  return Boolean(segment.command) || name.includes("命令") || name.includes("bash") || name.includes("shell");
}

function joinToolOutput(currentOutput: string | undefined, nextOutput: string) {
  const current = currentOutput?.trim();
  const next = nextOutput.trim();
  if (!current) return next;
  if (!next) return current;
  return `${current}\n${next}`;
}

function isLikelyCommandOutputText(text: string, command?: string) {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (looksLikeNarrativeText(cleaned)) return false;
  if (command && cleaned.startsWith(command.trim())) return true;
  return countCommandOutputSignals(cleaned) >= 2;
}

function isLikelyCommandOutputContinuation(text: string) {
  const cleaned = text.trim();
  if (!cleaned || looksLikeNarrativeText(cleaned)) return false;
  return countCommandOutputSignals(cleaned) >= 1 || /^[\w./-]+\s+\d+(?:\.\d+)?\s?kB\b/im.test(cleaned);
}

function looksLikeNarrativeText(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  if (lines.length > 3) return false;
  return lines.every((line) => /^[\u4e00-\u9fff]/.test(line) || /[。！？]$/.test(line));
}

function countCommandOutputSignals(text: string) {
  const signals = [
    /^(?:>\s*)?(?:[\w@./-]+)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]+/im,
    /^(?:>\s*)?[\w@./-]+@\d+(?:\.\d+){1,2}\s+[\w:-]+(?:\s|$)/im,
    /\b(?:vite|rollup|webpack|esbuild|tsc|electron-vite)\s+v?\d/im,
    /\b(?:transforming|rendering chunks|computing gzip size|modules transformed|built in)\b/im,
    /(?:^|\s)(?:dist|out|build|coverage)\/[\w./-]+/im,
    /(?:^|\s)[\w./-]+\.(?:js|css|html|mjs|cjs|map)\s+\d+(?:\.\d+)?\s?kB/im,
    /(?:^|\n)\s*(?:✓|✔|Done|Completed|Success|Error|WARN|WARNING|FAIL|ELIFECYCLE)\b/im,
    /\b(?:ERR!|ELIFECYCLE|Command failed|error during build|failed to load config)\b/im,
    /\b(?:node_modules|package\.json|vite\.config|tsconfig|lockfile)\b/im,
    /\b(?:stdout|stderr|exit code|Exited with code)\b/im,
  ];
  return signals.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}
</script>

<template>
  <div class="chat-message-row" :class="[message.role, { pending: message.pending }]">
    <span v-if="message.role === 'assistant'" class="chat-ai-avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
        <path d="M5 3v4" />
        <path d="M19 17v4" />
        <path d="M3 5h4" />
        <path d="M17 19h4" />
      </svg>
    </span>
    <div class="chat-message-body">
      <template v-for="(group, index) in contentGroups" :key="index">
        <ChatSegment v-if="group.type === 'segment'" :segment="group.segment" />
        <details v-else class="chat-process-group" :open="message.pending">
          <summary class="chat-process-group-summary">
            <span class="chat-process-group-icon" :class="{ running: message.pending }" aria-hidden="true"></span>
            <span>执行过程 · {{ group.segments.length }} 步</span>
            <svg class="chat-process-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </summary>
          <div class="chat-process-group-body">
            <ChatSegment v-for="(segment, segmentIndex) in group.segments" :key="segmentIndex" :segment="segment" />
          </div>
        </details>
      </template>
      <div v-if="message.images?.length" class="chat-message-images" :aria-label="`已附 ${message.images.length} 张图片`">
        <button
          v-for="image in message.images"
          :key="image.id"
          class="chat-message-image"
          type="button"
          :title="image.name"
        >
          <img :src="image.dataUrl" :alt="image.name" />
        </button>
      </div>
    </div>
  </div>
</template>
