export type ProjectFileViewerKind = "document" | "code" | "image";

export type ProjectFileViewerFormat = {
  extension: string;
  mimeType: string;
  kind: ProjectFileViewerKind;
  maxBytes: number;
};

const MEBIBYTE = 1024 * 1024;
const DOCUMENT_MAX_BYTES = 50 * MEBIBYTE;
const IMAGE_MAX_BYTES = 20 * MEBIBYTE;
const CODE_MAX_BYTES = 2 * MEBIBYTE;

const documentMimeTypes: Record<string, string> = {
  pdf: "application/pdf",
  ofd: "application/ofd",
  doc: "application/msword",
  dot: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  dotm: "application/vnd.ms-word.template.macroEnabled.12",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  xls: "application/vnd.ms-excel",
  xlt: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  xltm: "application/vnd.ms-excel.template.macroEnabled.12",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  fods: "application/vnd.oasis.opendocument.spreadsheet-flat-xml",
  numbers: "application/vnd.apple.numbers",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  potm: "application/vnd.ms-powerpoint.template.macroEnabled.12",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ppsm: "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
  odp: "application/vnd.oasis.opendocument.presentation",
};

const imageMimeTypes: Record<string, string> = {
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  heic: "image/heic",
  heif: "image/heif",
  jxl: "image/jxl",
};

const codeExtensions = [
  "txt", "json", "jsonc", "json5", "ipynb", "js", "mjs", "cjs", "css", "java", "py",
  "html", "htm", "jsx", "ts", "tsx", "xml", "log", "vue", "yaml", "yml", "toml", "ini",
  "proto", "hcl", "tex", "gv", "http", "sh", "bash", "sql", "go", "rs", "rb", "swift", "kt",
  "react", "php", "c", "cpp", "cc", "h", "hpp", "cs", "diff", "patch", "bundle", "bdl",
] as const;

const codeMimeTypes: Record<string, string> = {
  json: "application/json",
  jsonc: "application/json",
  json5: "application/json5",
  ipynb: "application/x-ipynb+json",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  css: "text/css",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
};

const viewerFormats: Record<string, ProjectFileViewerFormat> = {};

function registerFormats(
  mimeTypes: Record<string, string>,
  kind: ProjectFileViewerKind,
  maxBytes: number,
) {
  for (const [extension, mimeType] of Object.entries(mimeTypes)) {
    viewerFormats[extension] = { extension, mimeType, kind, maxBytes };
  }
}

registerFormats(documentMimeTypes, "document", DOCUMENT_MAX_BYTES);
registerFormats(imageMimeTypes, "image", IMAGE_MAX_BYTES);
registerFormats(
  Object.fromEntries(codeExtensions.map((extension) => [extension, codeMimeTypes[extension] ?? "text/plain"])),
  "code",
  CODE_MAX_BYTES,
);

function fileExtension(filePath: string): string {
  const name = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < name.length - 1
    ? name.slice(dotIndex + 1).toLowerCase()
    : "";
}

export function projectFileViewerFormat(filePath: string): ProjectFileViewerFormat | null {
  return viewerFormats[fileExtension(filePath)] ?? null;
}

export function isProjectFileViewerSupported(filePath: string): boolean {
  return projectFileViewerFormat(filePath) !== null;
}
