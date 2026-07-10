<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { FileViewer, type FileViewerOptions, type FileViewerThemeMode } from "@file-viewer/vue3";
import { liteRenderers } from "@file-viewer/preset-lite";
import { officeRenderers } from "@file-viewer/preset-office";
import "@file-viewer/vue3/dist/file-viewer3.css";

defineProps<{
  file: File;
}>();

const viewerTheme = ref<FileViewerThemeMode>("light");
let themeObserver: MutationObserver | null = null;

function syncViewerTheme() {
  viewerTheme.value = document.documentElement.classList.contains("theme-dark") ? "dark" : "light";
}

const viewerOptions = computed<FileViewerOptions>(() => ({
  theme: viewerTheme.value,
  locale: "zh-CN",
  autoRenderers: false,
  builtinRenderers: "none",
  rendererMode: "replace",
  preset: [officeRenderers, liteRenderers],
  ui: { density: "compact" },
  toolbar: {
    position: "bottom-right",
    download: false,
    print: false,
    exportHtml: false,
    zoom: true,
    search: true,
  },
  fit: {
    mode: "width",
    resize: "until-interaction",
    padding: 12,
  },
  pdf: {
    defaultNavigationVisible: false,
  },
  spreadsheet: {
    resizableColumns: true,
  },
}));

onMounted(() => {
  syncViewerTheme();
  themeObserver = new MutationObserver(syncViewerTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  themeObserver = null;
});
</script>

<template>
  <div class="project-file-viewer">
    <FileViewer :file="file" :filename="file.name" :options="viewerOptions" />
  </div>
</template>

<style scoped>
.project-file-viewer {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
</style>
