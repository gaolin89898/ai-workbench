<script setup lang="ts">
import { computed } from "vue";
import ChatSegment from "./ChatSegment.vue";
import type { ChatMessage, ChatSegment as ChatSegmentType } from "../services/tauri";
import { assistantOutputToSegments, formatChatMessageText } from "../utils/chat";

const props = defineProps<{
  message: ChatMessage;
}>();

const segments = computed<ChatSegmentType[]>(() => {
  if (props.message.segments?.length) return props.message.segments;
  if (props.message.role === "assistant") {
    return assistantOutputToSegments(props.message.text ?? "", "");
  }
  return [{ type: "text", text: formatChatMessageText(props.message.text ?? "") }];
});
</script>

<template>
  <div class="chat-message-row" :class="[message.role, { pending: message.pending }]">
    <div class="chat-message-body">
      <ChatSegment v-for="(segment, index) in segments" :key="index" :segment="segment" />
    </div>
  </div>
</template>
