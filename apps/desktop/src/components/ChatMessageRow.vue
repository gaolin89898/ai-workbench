<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import ChatSegment from "./ChatSegment.vue";
import type { ChatMessage, ChatSegment as ChatSegmentType } from "../services/desktop";
import { assistantOutputToSegments, extractAssistantText, formatChatMessageText } from "../utils/chat";

const props = defineProps<{
  message: ChatMessage;
  aiSessionId?: string;
}>();
const activeMobileProcessGroupIndex = ref<number | null>(null);
const nowTick = ref(Date.now());
const processGroupOpenOverrides = ref<Record<string, boolean>>({});
const userToggledProcessGroups = new Set<string>();
// 缓存 runtime-status 的 startedAt，避免 trace flush 短暂丢失 segment 时计时闪动
const cachedRuntimeStartedAt = ref<number | null>(null);
const cachedRuntimeDurationMs = ref<number | null>(null);
let nowTimer: ReturnType<typeof window.setInterval> | null = null;

onMounted(() => {
  nowTimer = window.setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (nowTimer !== null) {
    window.clearInterval(nowTimer);
    nowTimer = null;
  }
});

const rawSegments = computed<ChatSegmentType[]>(() => {
  const sourceSegments = props.message.segments ?? [];
  const cleanedText = stripProcessTextFromFinalText(
    extractAssistantText(props.message.text ?? ""),
    sourceSegments,
  ).trim();
  const splitText = props.message.role === "assistant"
    ? splitHistoricalProcessPrefix(cleanedText, sourceSegments)
    : { processText: "", finalText: cleanedText };
  const messageText = splitText.finalText;
  if (props.message.segments?.length) {
    if (props.message.role !== "assistant" || !messageText) return props.message.segments;
    const filteredSegments = props.message.segments.filter((segment) => isProcessTextSegment(segment) || segment.type !== "text");
    const result: ChatSegmentType[] = [];
    // 如果从历史文本中分离出了过程叙述，将其插入到执行过程的开头
    if (splitText.processText) {
      // 找到第一个过程 segment 的位置
      const firstProcessIndex = filteredSegments.findIndex(isProcessGroupSegment);
      if (firstProcessIndex >= 0) {
        result.push(...filteredSegments.slice(0, firstProcessIndex));
        result.push({ type: "text", stepId: "process-text-historical-intro", text: splitText.processText });
        result.push(...filteredSegments.slice(firstProcessIndex));
      } else {
        result.push(...filteredSegments);
      }
    } else {
      result.push(...filteredSegments);
    }
    result.push({ type: "text", stepId: "final-answer", text: messageText });
    return result;
  }
  if (props.message.role === "assistant") {
    return assistantOutputToSegments(messageText, "");
  }
  return [{ type: "text", text: formatChatMessageText(props.message.text ?? "") }];
});

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
  // 如果已经有 process-text segments，说明不是历史消息，不需要分离
  const hasProcessTextSegments = sourceSegments.some(isProcessTextSegment);
  if (hasProcessTextSegments) {
    return { processText: "", finalText };
  }
  // 只对没有 process-text segments 的旧消息进行分离
  if (!finalText || !hasProcessHistory(sourceSegments) || !looksLikeProcessNarrative(finalText)) {
    return { processText: "", finalText };
  }
  const splitIndex = firstInstructionSectionIndex(finalText);
  const fallbackSplitIndex = splitIndex > 0 ? splitIndex : processNarrativeEndIndex(finalText);
  if (fallbackSplitIndex <= 0) return { processText: "", finalText };
  const processText = finalText.slice(0, fallbackSplitIndex).trim();
  const remainingText = finalText.slice(fallbackSplitIndex).trim();
  if (processText.length < 40 || remainingText.length < 20) return { processText: "", finalText };
  return { processText, finalText: remainingText };
}

function processNarrativeEndIndex(text: string) {
  const match = text.match(/(?:已读取项目|没有修改任何文件|没有修改文件|没有改动任何文件|没有改动文件|未修改任何文件|没改文件)[。.!！]?\s+/);
  if (!match || match.index === undefined) return -1;
  return match.index + match[0].length;
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
    "\n这个仓库是一个",
    "\n这个项目是一个",
    "\n这是一个",
    "\n整体来看",
    "\n关键链路",
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
  // 只查找 runtime-status（进行中的会话），completed 状态已绑定到各个执行步骤
  const summary = segments.value.find((segment) => segment.type === "status" && segment.stepId === "runtime-status");
  // 缓存 startedAt，避免 trace flush 短暂丢失 segment 时计时闪动
  if (summary?.type === "status" && summary.startedAt) {
    const parsed = Date.parse(summary.startedAt);
    if (Number.isFinite(parsed)) cachedRuntimeStartedAt.value = parsed;
  }
  if (summary?.type === "status" && summary.durationMs && summary.durationMs > 0) {
    cachedRuntimeDurationMs.value = summary.durationMs;
  }
  return summary;
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
    // pending 且无 process segment 时，强制创建空 process group 占位（显示"正在思考..."）
    if (props.message.pending && props.message.role === "assistant" && !props.message.images?.length) {
      return [{ type: "process", segments: [] as ChatSegmentType[] }];
    }
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

function isProcessConclusionTextSegment(segment: ChatSegmentType) {
  return segment.type === "text" && Boolean(segment.stepId?.startsWith("process-text-conclusion-"));
}

function isUserMessageRawItemType(rawItemType?: string | null) {
  return /^(?:userMessage|user_message)$/i.test(rawItemType ?? "");
}
function isCompletedThinkingStatusSegment(segment: Extract<ChatSegmentType, { type: "status" }>) {
  return isThinkingRawItemType(segment.rawItemType) && segment.status !== "running";
}

function isThinkingRawItemType(rawItemType?: string | null) {
  return /^(?:reasoning|thinking)$/i.test(rawItemType ?? "");
}

function isThinkingStatusSegment(segment: ChatSegmentType) {
  return segment.type === "status" && isThinkingRawItemType(segment.rawItemType);
}

function isExecutionStageSegment(segment: ChatSegmentType) {
  return segment.type === "tool"
    || segment.type === "approval"
    || segment.type === "error"
    || (segment.type === "status" && !isThinkingStatusSegment(segment));
}

function shouldShowProcessSegment(segment: ChatSegmentType) {
  if (segment.stepId === "initial-thinking") return false;
  if (segment.type !== "status") return true;
  if (isUserMessageRawItemType(segment.rawItemType)) return false;
  if (isCompletedThinkingStatusSegment(segment)) return false;
  // 移除了 final-summary 检查，completed 状态已绑定到各个执行步骤
  const label = (segment.label ?? segment.text ?? "").trim();
  if (!label) return false;
  return !new Set([
    "完成",
    "已完成",
    "执行 fileChange",
    "执行 file_change",
    "执行 fileEdit",
    "执行 file_edit",
  ]).has(label);
}

function isProcessTextStepId(stepId?: string) {
  return Boolean(stepId && /^(?:process-text|thought|commentary)-/.test(stepId));
}

function completedProcessEndIndex(segments: ChatSegmentType[], lastProcessIndex: number) {
  const lastIndex = segments.length - 1;
  const lastSegment = segments[lastIndex];
  // 如果最后一个 segment 是 text（无论 stepId 是什么），排除它
  // 因为它很可能是最终回答，不应该在 process group 里
  if (lastIndex > lastProcessIndex
      && lastSegment?.type === "text"
      && Boolean(lastSegment.text?.trim())) {
    return lastIndex - 1;
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

function processGroupKey(groupIndex: number) {
  return `process-${groupIndex}`;
}

function processGroupIsThinkingOnly(group: Extract<RenderGroup, { type: "process" }>) {
  return !group.segments.length || group.segments.every(isThinkingStageSegment);
}

function processGroupStaticTitle(group: Extract<RenderGroup, { type: "process" }>, groupIndex: number) {
  if (!processGroupIsThinkingOnly(group)) return processGroupTitle(group, groupIndex);
  const thinkingStage = processBodyItems(group).find((item): item is Extract<ProcessBodyItem, { type: "stage" }> => item.type === "stage");
  return thinkingStage?.title ?? "正在思考...";
}

function processGroupDefaultOpen(group: Extract<RenderGroup, { type: "process" }>, groupIndex: number) {
  if (!props.message.pending || processGroupHasFinalText(groupIndex)) return false;
  return group.segments.some((segment) => !isThinkingStageSegment(segment));
}

function processGroupOpen(group: Extract<RenderGroup, { type: "process" }>, groupIndex: number) {
  const key = processGroupKey(groupIndex);
  return processGroupOpenOverrides.value[key] ?? processGroupDefaultOpen(group, groupIndex);
}

function onProcessGroupToggle(event: Event, groupIndex: number) {
  const key = processGroupKey(groupIndex);
  if (!userToggledProcessGroups.has(key)) return;
  userToggledProcessGroups.delete(key);
  const target = event.currentTarget;
  if (!(target instanceof HTMLDetailsElement)) return;
  const next = { ...processGroupOpenOverrides.value };
  next[key] = target.open;
  processGroupOpenOverrides.value = next;
}

function processGroupDurationMs(segments: ChatSegmentType[]) {
  const summary = processSummary.value;
  if (props.message.pending) {
    // 优先用 summary.startedAt，其次用缓存的 startedAt（防止 trace flush 短暂丢失）
    const startedAtRaw = summary?.type === "status" ? summary.startedAt : null;
    const startedAt = startedAtRaw ? Date.parse(startedAtRaw) : cachedRuntimeStartedAt.value;
    if (Number.isFinite(startedAt)) {
      const duration = Math.max(0, nowTick.value - (startedAt as number));
      cachedRuntimeDurationMs.value = duration;
      return duration;
    }
  }
  if (summary?.durationMs) return summary.durationMs;
  if (summary?.type === "status" && summary.startedAt && summary.completedAt) {
    const startedAt = Date.parse(summary.startedAt);
    const completedAt = Date.parse(summary.completedAt);
    if (Number.isFinite(startedAt) && Number.isFinite(completedAt)) {
      return Math.max(0, completedAt - startedAt);
    }
  }
  if (cachedRuntimeDurationMs.value && cachedRuntimeDurationMs.value > 0) return cachedRuntimeDurationMs.value;
  const groupDuration = segments.reduce((total, segment) => {
    if (segment.type !== "tool" && segment.type !== "thought") return total;
    return total + (segment.durationMs ?? 0);
  }, 0);
  return groupDuration;
}

function onProcessSummaryClick(event: MouseEvent, group: Extract<RenderGroup, { type: "process" }>, groupIndex: number) {
  if (!isMobileProcessSheetViewport()) {
    userToggledProcessGroups.add(processGroupKey(groupIndex));
    return;
  }
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
  let stageKind: "thinking" | "execution" | null = null;
  const hasExecution = group.segments.some(isExecutionStageSegment);
  const flushStageRun = () => {
    if (!stageRun.length) return;
    items.push({
      type: "stage",
      title: processStageTitle(stageRun),
      segments: stageRun,
    });
    stageRun = [];
    stageKind = null;
  };
  const attachConclusion = (segment: ChatSegmentType) => {
    const latest = items[items.length - 1];
    if (latest?.type === "stage") {
      latest.conclusion = segment;
      return;
    }
    items.push({ type: "segment", segment });
  };

  for (const segment of group.segments) {
    if (isProcessConclusionSegment(segment)) {
      flushStageRun();
      attachConclusion(segment);
      continue;
    }
    if (isExecutionConclusionSegment(segment)) {
      flushStageRun();
      attachConclusion(segment);
      continue;
    }
    if (isProcessStageSegment(segment)) {
      if (hasExecution && isCompletedThinkingSegment(segment)) continue;
      const nextKind = isThinkingStageSegment(segment) ? "thinking" : "execution";
      if (stageKind && stageKind !== nextKind) flushStageRun();
      stageKind = nextKind;
      stageRun.push(segment);
      continue;
    }
    flushStageRun();
    items.push({ type: "segment", segment });
  }
  flushStageRun();
  // pending 且最后一个 stage 无 running item 时，追加"正在思考..."占位 stage
  // 对应 Codex turn/started 后、下一个 item/started 前的空档期
  if (props.message.pending) {
    const lastItem = items[items.length - 1];
    const lastStageHasRunning = lastItem?.type === "stage" && lastItem.segments.some((s) =>
      (("status" in s && s.status === "running") || (s.type === "tool" && s.status === "running") || (s.type === "approval" && s.status === "pending"))
    );
    if (!lastStageHasRunning) {
      items.push({
        type: "stage",
        title: "正在思考...",
        segments: [{
          type: "status",
          stepId: "pending-thinking-placeholder",
          label: "正在思考",
          icon: "think",
          status: "running",
          startedAt: new Date().toISOString(),
          rawItemType: "reasoning",
        }],
      });
    }
  }
  return items;
}

function isProcessStageSegment(segment: ChatSegmentType) {
  return segment.type === "thought" || segment.type === "status" || segment.type === "tool" || segment.type === "approval" || segment.type === "error";
}

function isExecutionConclusionSegment(segment: ChatSegmentType) {
  return segment.type === "thought" && (segment.stepId ?? "").startsWith("agent-message-");
}

function isCompletedThinkingSegment(segment: ChatSegmentType) {
  return isThinkingStatusSegment(segment) && segment.status !== "running";
}

function isThinkingStageSegment(segment: ChatSegmentType) {
  return (segment.type === "thought" && !isExecutionConclusionSegment(segment)) || isThinkingStatusSegment(segment);
}

function isProcessConclusionSegment(segment: ChatSegmentType) {
  return segment.type === "text" && isProcessTextStepId(segment.stepId);
}

function processStageTitle(segments: ChatSegmentType[]) {
  const runningThinking = segments.find((segment) => isThinkingStatusSegment(segment) && segment.status === "running");
  if (runningThinking) return "正在思考...";
  const toolSegments = segments.filter((segment): segment is Extract<ChatSegmentType, { type: "tool" }> => segment.type === "tool");
  const aggregateTitle = aggregateToolStageTitle(toolSegments);
  if (aggregateTitle) return aggregateTitle;
  const runningTool = toolSegments.find((segment) => segment.status === "running");
  if (runningTool) return toolStageTitle(runningTool);
  const pendingApproval = segments.find((segment) => segment.type === "approval" && segment.status === "pending");
  if (pendingApproval?.type === "approval") return pendingApproval.approvalKind === "fileChange" ? "正在修改文件" : "正在等待命令确认";
  const erroredTool = toolSegments.find((segment) => segment.status === "error");
  if (erroredTool) return toolStageTitle(erroredTool);
  const latestTool = [...toolSegments].reverse()[0];
  if (latestTool) return toolStageTitle(latestTool);
  const latestStatus = [...segments].reverse().find((segment) => segment.type === "status");
  if (latestStatus?.type === "status") return latestStatus.label;
  const hasThought = segments.some((segment) => segment.type === "thought");
  if (hasThought) return "正在思考...";
  return props.message.pending ? "正在处理" : "已处理";
}

function aggregateToolStageTitle(segments: Extract<ChatSegmentType, { type: "tool" }>[]) {
  if (!segments.length) return "";
  const counts = { read: 0, search: 0, edit: 0, command: 0 };
  let hasRunning = false;
  let hasError = false;
  for (const segment of segments) {
    if (segment.status === "running") hasRunning = true;
    if (segment.status === "error") hasError = true;
    const kind = toolOperationKind(segment);
    counts[kind] += 1;
  }
  const parts = [
    counts.read ? `读取 ${counts.read} 个文件` : "",
    counts.search ? `搜索 ${counts.search} 次文件` : "",
    counts.edit ? `修改 ${counts.edit} 个文件` : "",
    counts.command ? `运行 ${counts.command} 条命令` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  const prefix = hasError ? "部分失败：" : hasRunning ? "正在" : "已";
  return `${prefix}${parts.join("，")}`;
}

function toolOperationKind(segment: Extract<ChatSegmentType, { type: "tool" }>): "read" | "search" | "edit" | "command" {
  const command = normalizeCommandForTitle(segment.command ?? "");
  const fileChanges = segment.diff ? extractFileChangePaths(segment.diff) : null;
  if (segment.toolName.includes("修改") || fileChanges?.length) return "edit";
  if (/^(?:Get-Content|cat|type|head|tail|sed\b|Select-String\b)/i.test(command)) return "read";
  if (/^(?:rg|grep|findstr|fd|find\b|Get-ChildItem|ls\b|dir\b)/i.test(command)) return "search";
  if (/\b(?:Get-Content|cat|type)\b/i.test(command)) return "read";
  if (/\b(?:rg|grep|findstr|Get-ChildItem)\b/i.test(command)) return "search";
  return "command";
}

function toolStageTitle(segment: Extract<ChatSegmentType, { type: "tool" }>) {
  const verb = segment.status === "running" ? "正在" : "已";
  const commandText = normalizeCommandForTitle(segment.command ?? "");
  const fileChanges = segment.diff ? extractFileChangePaths(segment.diff) : null;
  if (segment.toolName.includes("修改") || fileChanges) {
    if (segment.status === "error") return "修改文件失败";
    const filePath = fileChanges?.[0];
    if (filePath) {
      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      return `${verb}修改 ${fileName}`;
    }
    return `${verb}修改文件`;
  }
  if (segment.toolName.includes("扫描")) {
    if (segment.status === "error") return "扫描项目失败";
    return `${verb}扫描项目`;
  }
  if (segment.toolName.includes("命令") || commandText) {
    if (segment.status === "error") return "运行命令失败";
    if (commandText) return `${verb}${toolOperationTitleVerb(toolOperationKind(segment))} ${commandText}`;
    return `${verb}运行命令`;
  }
  if (segment.status === "error") return segment.summary || `处理失败 ${segment.toolName}`;
  return segment.summary || `${verb}处理 ${segment.toolName}`;
}

function toolOperationTitleVerb(kind: ReturnType<typeof toolOperationKind>) {
  if (kind === "read") return "读取";
  if (kind === "search") return "搜索";
  if (kind === "edit") return "修改";
  return "运行";
}

function normalizeCommandForTitle(command: string) {
  const cleaned = unquoteCommand(command
    .replace(/^\/usr\/bin\/(?:bash|sh)\s+-lc\s+/, "")
    .replace(/^bash\s+-lc\s+/, "")
    .trim());
  const powershell = cleaned.match(/^(?:"?[^"]*\\powershell(?:\.exe)?"?\s+)?-Command\s+([\s\S]+)$/i);
  return unquoteCommand((powershell ? powershell[1] : cleaned).trim());
}

function unquoteCommand(command: string) {
  return command.replace(/^["'](.+)["']$/, "$1");
}

function extractFileChangePaths(diff: string): string[] | null {
  const lines = diff.split("\n");
  const paths: string[] = [];
  for (const line of lines) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      paths.push(match[2]);
      continue;
    }
    const patchMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (patchMatch) {
      paths.push(patchMatch[1]);
    }
  }
  return paths.length ? paths : null;
}

function processStageDurationMs(segments: ChatSegmentType[]) {
  if (isThinkingStage(segments)) return 0;
  return segments.reduce((total, segment) => total + ("durationMs" in segment ? segment.durationMs ?? 0 : 0), 0);
}

function isThinkingStage(segments: ChatSegmentType[]) {
  return segments.length > 0 && segments.every(isThinkingStageSegment);
}
function visibleStageSegments(segments: ChatSegmentType[]) {
  return isThinkingStage(segments) ? [] : segments;
}

function conclusionText(segment: ChatSegmentType) {
  if (segment.type === "thought" || segment.type === "text") return segment.text;
  if (segment.type === "error") return segment.message;
  return "";
}

function processStageRunning(segments: ChatSegmentType[]) {
  return segments.some((segment) => {
    return segment.type === "tool" && segment.status === "running"
      || segment.type === "approval" && segment.status === "pending"
      || isThinkingStatusSegment(segment) && segment.status === "running";
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
    // 如果下一个是 tool，先添加 tool，再添加结论
    if (next?.type === "tool") {
      normalized.push(next);
      normalized.push({ type: "text", stepId: `process-text-${segment.stepId ?? index}`, text: segment.text });
      index += 1;
    } else {
      // 否则只添加结论
      normalized.push({ type: "text", stepId: `process-text-${segment.stepId ?? index}`, text: segment.text });
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
        <div v-else-if="processGroupIsThinkingOnly(group)" class="chat-process-group thinking-only">
          <div class="chat-process-group-summary static">
            <span class="chat-process-group-icon" :class="{ running: message.pending }" aria-hidden="true"></span>
            <span>{{ processGroupStaticTitle(group, index) }}</span>
          </div>
        </div>
        <details v-else class="chat-process-group" :open="processGroupOpen(group, index)" @toggle="onProcessGroupToggle($event, index)">
          <summary class="chat-process-group-summary" @click="onProcessSummaryClick($event, group, index)">
            <span class="chat-process-group-icon" :class="{ running: message.pending }" aria-hidden="true"></span>
            <span>{{ processGroupTitle(group, index) }}</span>
            <svg class="chat-process-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </summary>
          <div class="chat-process-group-body">
            <div v-if="!processBodyItems(group).length" class="chat-pending-line">
              <span>正在思考</span>
              <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            </div>
            <template v-else v-for="(item, itemIndex) in processBodyItems(group)" :key="itemIndex">
              <ChatSegment v-if="item.type === 'segment'" :segment="item.segment" :ai-session-id="aiSessionId" />
              <div v-else-if="isThinkingStage(item.segments)" class="chat-process-stage thinking-only">
                <div class="chat-process-stage-header static">
                  <span class="chat-process-stage-dot" :class="{ running: processStageRunning(item.segments) }" aria-hidden="true"></span>
                  <strong>{{ item.title }}</strong>
                </div>
              </div>
              <details v-else class="chat-process-stage" open>
                <summary class="chat-process-stage-header">
                  <span class="chat-process-stage-dot" :class="{ running: processStageRunning(item.segments) }" aria-hidden="true"></span>
                  <strong>{{ item.title }}</strong>
                  <svg class="chat-process-stage-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </summary>
                <div class="chat-process-stage-body">
                  <ChatSegment
                    v-for="(segment, segmentIndex) in visibleStageSegments(item.segments)"
                    :key="segmentIndex"
                    :segment="segment"
                    :ai-session-id="aiSessionId"
                  />
                </div>
              </details>
              <div v-if="item.conclusion" class="chat-process-stage-conclusion">
                {{ conclusionText(item.conclusion) }}
              </div>
            </template>
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
              <div v-else-if="isThinkingStage(item.segments)" class="chat-process-stage thinking-only">
                <div class="chat-process-stage-header static">
                  <span class="chat-process-stage-dot" :class="{ running: processStageRunning(item.segments) }" aria-hidden="true"></span>
                  <strong>{{ item.title }}</strong>
                </div>
              </div>
              <details v-else class="chat-process-stage" open>
                <summary class="chat-process-stage-header">
                  <span class="chat-process-stage-dot" :class="{ running: processStageRunning(item.segments) }" aria-hidden="true"></span>
                  <strong>{{ item.title }}</strong>
                  <svg class="chat-process-stage-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </summary>
                <div class="chat-process-stage-body">
                  <ChatSegment
                    v-for="(segment, segmentIndex) in visibleStageSegments(item.segments)"
                    :key="segmentIndex"
                    :segment="segment"
                    :ai-session-id="aiSessionId"
                  />
                </div>
              </details>
              <div v-if="item.conclusion" class="chat-process-stage-conclusion">
                {{ conclusionText(item.conclusion) }}
              </div>
            </template>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
