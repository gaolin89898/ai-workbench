<script setup lang="ts">
import { computed } from "vue";
import ChatSegment from "./ChatSegment.vue";
import type { ChatMessage, ChatSegment as ChatSegmentType } from "../services/tauri";
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

const processSegments = computed(() => {
  if (!processSummary.value) return [];
  return segments.value.filter((segment) => (
    segment !== processSummary.value &&
    segment.type !== "text" &&
    segment.type !== "error" &&
    !isHiddenMessageProcessSegment(segment)
  ));
});

const contentSegments = computed(() => {
  if (!processSummary.value) return segments.value;
  return segments.value.filter((segment) => segment.type === "text" || segment.type === "error");
});

function isHiddenMessageProcessSegment(segment: ChatSegmentType) {
  if (segment.type === "tool") return isHiddenMessageType(segment.toolName) || isHiddenMessageType(segment.summary);
  if (segment.type === "status") return isHiddenMessageType(segment.label) || isHiddenMessageType(segment.detail);
  return false;
}

function isHiddenMessageType(value?: string) {
  return Boolean(value && /(?:^|[:\s])(agentMessage|assistantMessage|userMessage|agent_message|assistant_message|user_message)(?:$|[:\s])/i.test(value));
}
</script>

<template>
  <div class="chat-message-row" :class="[message.role, { pending: message.pending }]">
    <div class="chat-message-body">
      <details v-if="processSummary" class="chat-process-details" open>
        <summary>
          <span>{{ processSummary.label }}</span>
          <svg class="chat-process-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5 8 9.5l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </summary>
        <div v-if="processSegments.length" class="chat-process-body">
          <ChatSegment v-for="(segment, index) in processSegments" :key="index" :segment="segment" />
        </div>
      </details>
      <ChatSegment v-for="(segment, index) in contentSegments" :key="index" :segment="segment" />
    </div>
  </div>
</template>
