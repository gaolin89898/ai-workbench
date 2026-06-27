<script setup lang="ts">
import { computed } from "vue";
import ChatSegment from "./ChatSegment.vue";
import type { ChatMessage, ChatSegment as ChatSegmentType } from "../services/desktop";
import { assistantOutputToSegments, extractAssistantText, formatChatMessageText } from "../utils/chat";

const props = defineProps<{
  message: ChatMessage;
}>();

const segments = computed<ChatSegmentType[]>(() => {
  if (props.message.segments?.length) return props.message.segments;
  if (props.message.role === "assistant") {
    return assistantOutputToSegments(extractAssistantText(props.message.text ?? ""), "");
  }
  return [{ type: "text", text: formatChatMessageText(props.message.text ?? "") }];
});

const processSummary = computed(() => {
  return segments.value.find((segment) => segment.type === "status" && segment.stepId === "final-summary");
});

const hasProcessSegments = computed(() => segments.value.some((segment) => (
  segment !== processSummary.value && isProcessSegment(segment)
)));

const shouldShowStepContainer = computed(() => {
  return props.message.role === "assistant" && (Boolean(processSummary.value) || hasProcessSegments.value);
});

const stepTitle = computed(() => processSummary.value?.label ?? "正在处理");

type SegmentGroup =
  | { type: "segment"; segment: ChatSegmentType }
  | { type: "process"; segments: ChatSegmentType[] };

const finalContentStartIndex = computed(() => {
  if (!shouldShowStepContainer.value) return 0;
  for (let index = segments.value.length - 1; index >= 0; index -= 1) {
    const segment = segments.value[index];
    if (segment === processSummary.value) continue;
    if (segment.type === "text" || segment.type === "error") return index;
  }
  return segments.value.length;
});

const stepGroups = computed(() => {
  if (!shouldShowStepContainer.value) return [];
  return groupSegments(segments.value.slice(0, finalContentStartIndex.value));
});

const contentGroups = computed(() => {
  if (!shouldShowStepContainer.value) return groupSegments(segments.value);
  return groupSegments(segments.value.slice(finalContentStartIndex.value));
});

function groupSegments(sourceSegments: ChatSegmentType[]) {
  const groups: SegmentGroup[] = [];
  let processRun: ChatSegmentType[] = [];

  function flushProcessRun() {
    if (!processRun.length) return;
    if (processRun.length === 1) {
      groups.push({ type: "segment", segment: processRun[0] });
    } else {
      groups.push({ type: "process", segments: processRun });
    }
    processRun = [];
  }

  for (const segment of sourceSegments) {
    if (segment === processSummary.value) continue;
    if (isProcessSegment(segment)) {
      processRun.push(segment);
      continue;
    }
    flushProcessRun();
    groups.push({ type: "segment", segment });
  }
  flushProcessRun();
  return groups;
}

function isProcessSegment(segment: ChatSegmentType) {
  return segment.type === "tool" || segment.type === "status" || segment.type === "thought";
}

function processGroupTitle(count: number) {
  return `执行了 ${count} 个步骤`;
}
</script>

<template>
  <div class="chat-message-row" :class="[message.role, { pending: message.pending }]">
    <div class="chat-message-body">
      <details v-if="shouldShowStepContainer && stepGroups.length" class="chat-process-details" :open="message.pending">
        <summary>
          <span>{{ stepTitle }}</span>
          <svg class="chat-process-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </summary>
        <div class="chat-process-body">
          <template v-for="(group, index) in stepGroups" :key="index">
            <ChatSegment v-if="group.type === 'segment'" :segment="group.segment" />
            <details v-else class="chat-process-group">
              <summary>
                <span>{{ processGroupTitle(group.segments.length) }}</span>
                <svg class="chat-process-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </summary>
              <div class="chat-process-group-body">
                <ChatSegment v-for="(segment, segmentIndex) in group.segments" :key="segmentIndex" :segment="segment" />
              </div>
            </details>
          </template>
        </div>
      </details>
      <template v-for="(group, index) in contentGroups" :key="index">
        <ChatSegment v-if="group.type === 'segment'" :segment="group.segment" />
        <details v-else class="chat-process-group">
          <summary>
            <span>{{ processGroupTitle(group.segments.length) }}</span>
            <svg class="chat-process-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </summary>
          <div class="chat-process-group-body">
            <ChatSegment v-for="(segment, segmentIndex) in group.segments" :key="segmentIndex" :segment="segment" />
          </div>
        </details>
      </template>
    </div>
  </div>
</template>
