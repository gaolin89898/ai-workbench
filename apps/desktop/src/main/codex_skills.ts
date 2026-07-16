import { app } from "electron";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { CodexSkill, CodexSkillsSnapshot } from "../services/desktop";

const SKILLS_EXTRA_ROOTS_FILE = "codex-skills-extra-roots.json";
const SKILLS_STATE_FILE = "codex-skills-state.json";

function storagePath(): string {
  return path.join(app.getPath("userData"), SKILLS_EXTRA_ROOTS_FILE);
}

function statePath(): string { return path.join(app.getPath("userData"), SKILLS_STATE_FILE); }

function normalizeRoots(values: string[]): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const root = path.resolve(trimmed);
    const key = process.platform === "win32" ? root.toLocaleLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

export async function getCodexSkillsExtraRoots(): Promise<string[]> {
  try {
    const raw = await readFile(storagePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeRoots(parsed.filter((value): value is string => typeof value === "string")) : [];
  } catch {
    return [];
  }
}

export async function saveCodexSkillsExtraRoots(values: string[]): Promise<string[]> {
  const roots = normalizeRoots(values);
  for (const root of roots) {
    let info;
    try {
      info = await stat(root);
    } catch {
      throw new Error(`额外 Skills 目录不存在：${root}`);
    }
    if (!info.isDirectory()) throw new Error(`额外 Skills 路径不是目录：${root}`);
  }
  const target = storagePath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(roots, null, 2), "utf8");
  return roots;
}

async function readEnabledStates(): Promise<Record<string, boolean>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, boolean> : {};
  } catch { return {}; }
}

export async function saveCodexSkillEnabledState(skillPath: string, enabled: boolean): Promise<void> {
  const states = await readEnabledStates();
  states[skillPath] = enabled;
  await mkdir(path.dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(states, null, 2), "utf8");
}

function frontMatterValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}:\\s*[\"']?([^\\n\"']+)[\"']?\\s*$`, "m"));
  return match?.[1]?.trim() || null;
}

export async function listLocalCodexSkills(): Promise<CodexSkillsSnapshot> {
  const extraRoots = await getCodexSkillsExtraRoots();
  const home = os.homedir();
  const roots = [path.join(home, ".codex", "skills"), path.join(home, ".codex", "plugins", "cache"), ...extraRoots];
  const states = await readEnabledStates();
  const seen = new Set<string>();
  const skills: CodexSkill[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const root of roots) {
    try {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name !== "SKILL.md") continue;
        const skillPath = path.join(entry.parentPath, entry.name);
        const directory = path.dirname(skillPath);
        if (seen.has(directory)) continue;
        seen.add(directory);
        try {
          const text = await readFile(skillPath, "utf8");
          const name = frontMatterValue(text, "name") ?? path.basename(directory);
          skills.push({ name, description: frontMatterValue(text, "description") ?? "", path: directory, scope: directory.startsWith(path.join(home, ".codex", "skills")) ? "user" : "system", enabled: states[directory] !== false });
        } catch (error) { errors.push({ path: directory, message: error instanceof Error ? error.message : String(error) }); }
      }
    } catch { /* An optional root may not exist. */ }
  }
  skills.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return { entries: [{ cwd: "", skills, errors }], extraRoots };
}
