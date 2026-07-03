<script setup lang="ts">
import { computed, ref } from "vue";
import ChatSegment from "./ChatSegment.vue";
import type { ChatMessage, ChatSegment as ChatSegmentType } from "../services/desktop";
import { assistantOutputToSegments, extractAssistantText, formatChatMessageText } from "../utils/chat";

const props = defineProps<{
  message: ChatMessage;
  aiSessionId?: string;
}>();
const activeMobileProcessGroupIndex = ref<number | null>(null);

const rawSegments = computed<ChatSegmentType[]>(() => {
  const sourceSegments = props.message.segments ?? [];
  const cleanedText = stripProcessTextFromFinalText(
    extractAssistantText(props.message.text ?? ""),
    sourceSegments,
  ).trim();
  const splitText = props.message.role === "assistant"
    ? splitHistoricalProcessPrefix(cleanedText, sourceSegments)
    : { processText: "", finalText: cleanedText };
  const storedText = splitText.finalText;
  const promoted = props.message.role === "assistant"
    ? promoteFinalTextFromSegments(sourceSegments, storedText)
    : { text: storedText, promotedIndex: -1 };
  const messageText = promoted.text;
  if (props.message.segments?.length) {
    if (props.message.role !== "assistant" || !messageText) return props.message.segments;
    return [
      ...props.message.segments.filter((segment, index) => (
        index !== promoted.promotedIndex
        && (isProcessTextSegment(segment) || segment.type !== "text")
      )),
      ...(splitText.processText
        ? [{ type: "text" as const, stepId: "process-text-historical-prefix", text: splitText.processText }]
        : []),
      { type: "text", stepId: "final-answer", text: messageText },
    ];
  }
  if (props.message.role === "assistant") {
    return assistantOutputToSegments(messageText, "");
  }
  return [{ type: "text", text: formatChatMessageText(props.message.text ?? "") }];
});

function promoteFinalTextFromSegments(sourceSegments: ChatSegmentType[], fallbackText: string) {
  if (fallbackText || !sourceSegments.length) return { text: fallbackText, promotedIndex: -1 };
  for (let index = sourceSegments.length - 1; index >= 0; index -= 1) {
    const segment = sourceSegments[index];
    if (!isProcessTextSegment(segment) || !looksLikeFinalAssistantText(segment.text)) continue;
    return { text: segment.text.trim(), promotedIndex: index };
  }
  return { text: fallbackText, promotedIndex: -1 };
}

function looksLikeFinalAssistantText(text: string) {
  const normalized = text.trim();
  if (!normalized) return false;
  return /^(?:已按|我已|我会|结论|总结|这里|现在|可以|如果|这次|这样)/.test(normalized)
    || /(?:已完成|已处理|已修复|已实现|构建通过|验证通过|不会|可以|需要|建议)/.test(normalized);
}

function stripProcessTextFromFinalText(text: string, sourceSegments: ChatSegmentType[]) {
  let cleaned = text.trim();
  if (!cleaned) return cleaned;
  for (const segment of sourceSegments) {
    if (!isProcessTextSegment(segment)) continue;
    cleaned = removeTextBlock(cleaned, segment.text);
    if (!cleaned) break;
  }
  return cleaned.trim();
}

function removeTextBlock(text: string, block: string) {
  const target = block.trim();
  let source = text.trim();
  if (!target || !source) return source;
  if (source === target) return "";
  if (source.startsWith(target)) return source.slice(target.length).trimStart();
  const surrounded = `\n\n${target}\n\n`;
  const index = source.indexOf(surrounded);
  if (index >= 0) {
    source = `${source.slice(0, index)}\n\n${source.slice(index + surrounded.length)}`;
  }
  return source.trim();
}

function splitHistoricalProcessPrefix(text: string, sourceSegments: ChatSegmentType[]) {
  const finalText = text.trim();
  if (!finalText || !hasProcessHistory(sourceSegments) || !looksLikeProcessNarrative(finalText)) {
    return { processText: "", finalText };
  }
  const splitIndex = firstInstructionSectionIndex(finalText);
  if (splitIndex <= 0) return { processText: "", finalText };
  const processText = finalText.slice(0, splitIndex).trim();
  const remainingText = finalText.slice(splitIndex).trim();
  if (processText.length < 80 || remainingText.length < 80) return { processText: "", finalText };
  return { processText, finalText: remainingText };
}

function hasProcessHistory(sourceSegments: ChatSegmentType[]) {
  return sourceSegments.some((segment) => (
    segment.type === "tool"
    || segment.type === "status"
    || segment.type === "thought"
    || segment.type === "approval"
    || segment.type === "error"
    || isProcessTextSegment(segment)
  ));
}

function looksLikeProcessNarrative(text: string) {
  return /^(?:项目看起来|我先|我继续|现在我|我会|我准备|我需要|我将|我来|先看|先检查|正在)/.test(text.trim());
}

function firstInstructionSectionIndex(text: string) {
  const markers = [
    "\n**后端启动**",
    "\n## 后端启动",
    "\n### 后端启动",
    "\n后端启动",
    "\n**桌面端启动**",
    "\n## 桌面端启动",
    "\n**最常用启动顺序**",
    "\n## 最常用启动顺序",
  ];
  return markers.reduce((best, marker) => {
    const index = text.indexOf(marker);
    if (index < 0) return best;
    return best < 0 ? index : Math.min(best, index);
  }, -1);
}

const segments = computed<ChatSegmentType[]>(() => {
  const normalized = normalizeProcessCommentarySegments(normalizeHistoricalCommandOutputSegments(rawSegments.value));
  return normalizeCompletedToolStatuses(normalized);
});

const processSummary = computed(() => {
  return segments.value.find((segment) => segment.type === "status" && segment.stepId === "final-summary");
});

type RenderGroup =
  | { type: "segment"; segment: ChatSegmentType }
  | { type: "process"; segments: ChatSegmentType[] };

type ProcessBodyItem =
  | { type: "segment"; segment: ChatSegmentType }
  | { type: "stage"; title: string; segments: ChatSegmentType[]; conclusion?: ChatSegmentType };

const visibleSegments = computed<ChatSegmentType[]>(() => {
  const isUserImageOnly = props.message.role === "user"
    && props.message.images?.length
    && isImageOnlyPromptText(props.message.text ?? "");
  return segments.value.filter((segment) => {
    if (segment.type === "approval") return false;
    if (segment.type === "text" && !segment.text?.trim()) return false;
    if (!props.message.pending && segment.stepId === "initial-thinking") return false;
    if (segment === processSummary.value) return false;
    if (isUserImageOnly && segment.type === "text" && isImageOnlyPromptText(segment.text)) return false;
    if (isProcessGroupSegment(segment) && !shouldShowProcessSegment(segment)) return false;
    return true;
  });
});

const contentGroups = computed<RenderGroup[]>(() => {
  const segments = visibleSegments.value;
  const firstProcessIndex = segments.findIndex(isProcessGroupSegment);
  if (firstProcessIndex < 0) {
    return segments.map((segment) => ({ type: "segment", segment }));
  }

  let lastProcessIndex = firstProcessIndex;
  for (let index = firstProcessIndex + 1; index < segments.length; index += 1) {
    if (isProcessGroupSegment(segments[index])) lastProcessIndex = index;
  }
  const processEndIndex = props.message.pending ? segments.length - 1 : completedProcessEndIndex(segments, lastProcessIndex);

  const groups: RenderGroup[] = [];
  for (const segment of segments.slice(0, firstProcessIndex)) {
    groups.push({ type: "segment", segment });
  }
  groups.push({ type: "process", segments: segments.slice(firstProcessIndex, processEndIndex + 1) });
  for (const segment of segments.slice(processEndIndex + 1)) {
    groups.push({ type: "segment", segment });
  }
  return groups;
});

const showPendingThinking = computed(() => {
  if (!props.message.pending || props.message.role !== "assistant") return false;
  const hasVisibleContent = visibleSegments.value.some((segment) => {
    if (isProcessGroupSegment(segment)) return true;
    return segment.type !== "text" || Boolean(segment.text?.trim());
  });
  return !hasVisibleContent && !props.message.images?.length;
});

const activeMobileProcessGroup = computed(() => {
  const index = activeMobileProcessGroupIndex.value;
  if (index === null) return null;
  const group = contentGroups.value[index];
  return group?.type === "process" ? { group, index } : null;
});

function isProcessSegment(segment: ChatSegmentType) {
  return segment.type === "tool" || segment.type === "status" || segment.type === "thought" || segment.type === "approval" || segment.type === "error";
}

function isProcessGroupSegment(segment: ChatSegmentType) {
  return isProcessSegment(segment) || isProcessTextSegment(segment);
}

function isProcessTextSegment(segment: ChatSegmentType) {
  return segment.type === "text" && isProcessTextStepId(segment.stepId);
}

function shouldShowProcessSegment(segment: ChatSegmentType) {
  if (segment.stepId === "initial-thinking") return false;
  if (segment.type !== "status") return true;
  if (segment.stepId === "final-summary") return false;
  const label = (segment.label ?? segment.text ?? "").trim();
  if (!label) return false;
  return !new Set([
    "完成",
    "已完成",
  ]).has(label);
}

function isProcessTextStepId(stepId?: string) {
  return Boolean(stepId && /^(?:process-text|thought|commentary)-/.test(stepId));
}

function completedProcessEndIndex(segments: ChatSegmentType[], lastProcessIndex: number) {
  const lastIndex = segments.length - 1;
  if (lastIndex > lastProcessIndex && segments[lastIndex]?.type === "text" && Boolean(segments[lastIndex].text?.trim())) {
    return Math.max(lastProcessIndex, lastIndex - 1);
  }
  return lastProcessIndex;
}

function processGroupHasFinalText(groupIndex: number) {
  return contentGroups.value.slice(groupIndex + 1).some((group) => {
    return group.type === "segment" && group.segment.type === "text" && Boolean(group.segment.text?.trim());
  });
}

function processGroupTitle(group: Extract<RenderGroup, { type: "process" }>, groupIndex: number) {
  const duration = processGroupDurationMs(group.segments);
  const prefix = props.message.pending && !processGroupHasFinalText(groupIndex) ? "正在处理" : "已处理";
  return duration ? `${prefix} ${formatCompactDuration(duration)}` : prefix;
}

function processGroupOpen(groupIndex: number) {
  return Boolean(props.message.pending && !processGroupHasFinalText(groupIndex));
}

function processGroupDurationMs(segments: ChatSegmentType[]) {
  if (processSummary.value?.durationMs) return processSummary.value.durationMs;
  const groupDuration = segments.reduce((max, segment) => {
    if (segment.type !== "tool" && segment.type !== "thought") return max;
    return Math.max(max, segment.durationMs ?? 0);
  }, 0);
  return groupDuration;
}

function onProcessSummaryClick(event: MouseEvent, group: Extract<RenderGroup, { type: "process" }>, groupIndex: number) {
  if (!isMobileProcessSheetViewport()) return;
  event.preventDefault();
  activeMobileProcessGroupIndex.value = groupIndex;
}

function closeMobileProcessSheet() {
  activeMobileProcessGroupIndex.value = null;
}

function isMobileProcessSheetViewport() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function formatCompactDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs}ms`;
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (!totalMinutes) return `${seconds}秒`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (!hours) return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
  return seconds ? `${hours}时${minutes}分${seconds}秒` : `${hours}时${minutes}分`;
}

function processBodyItems(group: Extract<RenderGroup, { type: "process" }>): ProcessBodyItem[] {
  const items: ProcessBodyItem[] = [];
  let stageRun: ChatSegmentType[] = [];
  let conclusion: ChatSegmentType | undefined;

  const flushStageRun = () => {
    if (!stageRun.length) {
      if (conclusion) {
        items.push({ type: "segment", segment: conclusion });
        conclusion = undefined;
      }
      return;
    }
    items.push({
      type: "stage",
      title: processStageTitle(stageRun),
      segments: stageRun,
      conclusion,
    });
    stageRun = [];
    conclusion = undefined;
  };

  for (const segment of group.segments) {
    if (isProcessConclusionSegment(segment)) {
      conclusion = segment;
      flushStageRun();
      continue;
    }
    if (isProcessStageSegment(segment)) {
      stageRun.push(segment);
      continue;
    }
    flushStageRun();
    items.push({ type: "segment", segment });
  }
  flushStageRun();
  return items;
}

function isProcessStageSegment(segment: ChatSegmentType) {
  return segment.type === "thought" || segment.type === "status" || segment.type === "tool" || segment.type === "approval" || segment.type === "error";
}

function isProcessConclusionSegment(segment: ChatSegmentType) {
  return segment.type === "text" && isProcessTextStepId(segment.stepId);
}

function processStageTitle(segments: ChatSegmentType[]) {
  const runningTool = segments.find((segment) => segment.type === "tool" && segment.status === "running");
  if (runningTool?.type === "tool") return toolStageTitle(runningTool);
  const pendingApproval = segments.find((segment) => segment.type === "approval" && segment.status === "pending");
  if (pendingApproval?.type === "approval") return pendingApproval.approvalKind === "fileChange" ? "正在修改文件" : "正在等待命令确认";
  const latestStatus = [...segments].reverse().find((segment) => segment.type === "status");
  if (latestStatus?.type === "status") return latestStatus.label;
  const hasThought = segments.some((segment) => segment.type === "thought");
  if (hasThought) return props.message.pending ? "正在思考" : "已思考";
  const erroredTool = segments.find((segment) => segment.type === "tool" && segment.status === "error");
  if (erroredTool?.type === "tool") return "处理失败";
  return props.message.pending ? "正在处理" : "已处理";
}

function toolStageTitle(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  if (segment.toolName.includes("修改") || segment.toolName.includes("文件")) return "正在修改文件";
  if (segment.toolName.includes("扫描")) return "正在扫描项目";
  if (segment.toolName.includes("命令") || segment.command) return "正在运行命令";
  return segment.summary || `正在处理 ${segment.toolName}`;
}

function processStageDurationMs(segments: ChatSegmentType[]) {
  return segments.reduce((total, segment) => total + ("durationMs" in segment ? segment.durationMs ?? 0 : 0), 0);
}

function processStageRunning(segments: ChatSegmentType[]) {
  return segments.some((segment) => {
    return segment.type === "tool" && segment.status === "running"
      || segment.type === "approval" && segment.status === "pending";
  });
}

function isImageOnlyPromptText(text: string) {
  return /^查看这\s*\d+\s*张图片$/.test(text.trim());
}

function normalizeProcessCommentarySegments(sourceSegments: ChatSegmentType[]) {
  const normalized: ChatSegmentType[] = [];
  for (let index = 0; index < sourceSegments.length; index += 1) {
    const segment = sourceSegments[index];
    if (!isProcessCommentaryThought(segment)) {
      normalized.push(segment);
      continue;
    }

    const next = sourceSegments[index + 1];
    normalized.push({ type: "text", stepId: `process-text-${segment.stepId ?? index}`, text: segment.text });
    if (next?.type === "tool") {
      normalized.push(next);
      index += 1;
    }
  }
  return normalized;
}

function isProcessCommentaryThought(segment: ChatSegmentType) {
  return segment.type === "thought" && (segment.title === "执行说明" || segment.title === "中间结论");
}

function normalizeCompletedToolStatuses(sourceSegments: ChatSegmentType[]) {
  if (props.message.pending) return sourceSegments;
  return sourceSegments.map((segment) => {
    if (segment.type !== "tool" || segment.status !== "running") return segment;
    return { ...segment, status: "success" };
  });
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
        <ChatSegment v-if="group.type === 'segment'" :segment="group.segment" :ai-session-id="aiSessionId" />
        <details v-else class="chat-process-group" :open="processGroupOpen(index)">
          <summary class="chat-process-group-summary" @click="onProcessSummaryClick($event, group, index)">
            <span class="chat-process-group-icon" :class="{ running: message.pending }" aria-hidden="true"></span>
            <span>{{ processGroupTitle(group, index) }}</span>
            <svg class="chat-process-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </summary>
          <div class="chat-process-group-body">
            <template v-for="(item, itemIndex) in processBodyItems(group)" :key="itemIndex">
              <ChatSegment v-if="item.type === 'segment'" :segment="item.segment" :ai-session-id="aiSessionId" />
              <section v-else class="chat-process-stage">
                <header class="chat-process-stage-header">
                  <span class="chat-process-stage-dot" :class="{ running: processStageRunning(item.segments) }" aria-hidden="true"></span>
                  <strong>{{ item.title }}</strong>
                  <small v-if="processStageDurationMs(item.segments)">{{ formatCompactDuration(processStageDurationMs(item.segments)) }}</small>
                </header>
                <div class="chat-process-stage-body">
                  <ChatSegment
                    v-for="(segment, segmentIndex) in item.segments"
                    :key="segmentIndex"
                    :segment="segment"
                    :ai-session-id="aiSessionId"
                  />
                  <div v-if="item.conclusion" class="chat-process-stage-conclusion">
                    <ChatSegment :segment="item.conclusion" :ai-session-id="aiSessionId" />
                  </div>
                </div>
              </section>
            </template>
          </div>
        </details>
      </template>
      <div v-if="showPendingThinking" class="chat-pending-line">
        <span>正在思考</span>
        <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
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
    <Teleport to="body">
      <div
        v-if="activeMobileProcessGroup"
        class="chat-process-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="执行过程"
        @click.self="closeMobileProcessSheet"
      >
        <section class="chat-process-sheet-panel">
          <header class="chat-process-sheet-header">
            <div>
              <small>执行过程</small>
              <strong>{{ processGroupTitle(activeMobileProcessGroup.group, activeMobileProcessGroup.index) }}</strong>
            </div>
            <button type="button" aria-label="关闭执行过程" @click="closeMobileProcessSheet">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
          </header>
          <div class="chat-process-sheet-body">
            <template v-for="(item, itemIndex) in processBodyItems(activeMobileProcessGroup.group)" :key="itemIndex">
              <ChatSegment v-if="item.type === 'segment'" :segment="item.segment" :ai-session-id="aiSessionId" />
              <section v-else class="chat-process-stage">
                <header class="chat-process-stage-header">
                  <span class="chat-process-stage-dot" :class="{ running: processStageRunning(item.segments) }" aria-hidden="true"></span>
                  <strong>{{ item.title }}</strong>
                  <small v-if="processStageDurationMs(item.segments)">{{ formatCompactDuration(processStageDurationMs(item.segments)) }}</small>
                </header>
                <div class="chat-process-stage-body">
                  <ChatSegment
                    v-for="(segment, segmentIndex) in item.segments"
                    :key="segmentIndex"
                    :segment="segment"
                    :ai-session-id="aiSessionId"
                  />
                  <div v-if="item.conclusion" class="chat-process-stage-conclusion">
                    <ChatSegment :segment="item.conclusion" :ai-session-id="aiSessionId" />
                  </div>
                </div>
              </section>
            </template>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
