import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectFilePreview, WorkspaceFileEntry } from "../services/desktop";
import { getWorkspaceProjectByPath } from "./db";

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024;

function projectRoot(projectPath: string): string {
  const project = getWorkspaceProjectByPath(projectPath);
  if (!project) throw new Error("project is not registered");
  return path.resolve(project.path);
}

function assertProjectChildPath(projectPath: string, targetPath: string): string {
  const root = projectRoot(projectPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("path is outside project");
  }
  return target;
}

function previewMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  return "";
}

function previewLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase().slice(1);
  const name = path.basename(filePath).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "package.json" || extension === "json") return "json";
  if (["ts", "tsx", "mts", "cts"].includes(extension)) return "typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "javascript";
  if (extension === "vue") return "vue";
  if (["css", "scss", "sass", "less"].includes(extension)) return "css";
  if (["md", "mdx"].includes(extension)) return "markdown";
  if (["yml", "yaml"].includes(extension)) return "yaml";
  if (["html", "xml", "svg"].includes(extension)) return extension;
  return extension || "text";
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

export async function listProjectFiles(
  projectPath: string,
  directoryPath?: string | null,
): Promise<WorkspaceFileEntry[]> {
  const root = projectRoot(projectPath);
  const target = directoryPath ? assertProjectChildPath(projectPath, directoryPath) : root;
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) throw new Error("target is not a directory");
  const entries = await readdir(target, { withFileTypes: true });
  const files = await Promise.all(
    entries.filter((entry) => entry.name !== ".git").map(async (entry) => {
      const fullPath = path.join(target, entry.name);
      const info = await stat(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      };
    }),
  );
  return files.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });
}

export async function readProjectFilePreview(
  projectPath: string,
  filePath: string,
): Promise<ProjectFilePreview> {
  const target = assertProjectChildPath(projectPath, filePath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("target is not a file");
  const mimeType = previewMimeType(target);
  const base = {
    name: path.basename(target),
    path: target,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
  if (mimeType.startsWith("image/")) {
    if (info.size > MAX_IMAGE_PREVIEW_BYTES) return { ...base, previewKind: "tooLarge", mimeType };
    const buffer = await readFile(target);
    return {
      ...base,
      previewKind: "image",
      mimeType,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    };
  }
  if (info.size > MAX_TEXT_PREVIEW_BYTES) return { ...base, previewKind: "tooLarge" };
  const buffer = await readFile(target);
  if (looksBinary(buffer)) return { ...base, previewKind: "binary" };
  return {
    ...base,
    previewKind: "text",
    content: buffer.toString("utf8"),
    language: previewLanguage(target),
  };
}
