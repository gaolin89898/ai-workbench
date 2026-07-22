/**
 * Ensures child CLI processes (Codex, Claude Code, OpenCode, MiMo) inherit a
 * UTF-8 friendly environment, especially on Windows where the default console
 * code page may be GBK (936) on Chinese systems and cause mojibake in CLI
 * stdout/stderr.
 *
 * Adapted from pi-gui's windows-utf8-env.ts, simplified for this project
 * (no managed Python runtime or packaged node proxy yet).
 *
 * Usage: call `applyUtf8ProcessEnv()` once at main process startup (before any
 * provider session or shell command is spawned). All subsequent child processes
 * that inherit `process.env` will pick up the UTF-8 settings automatically.
 */

/**
 * UTF-8 environment variables that should be merged into every child process env.
 *
 * - `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`: forces Python-based tools to use
 *   UTF-8 for stdin/stdout/stderr regardless of the console code page.
 * - `LANG=C.UTF-8` / `LC_ALL=C.UTF-8` (Windows only): tells locale-aware tools
 *   ported from Unix to use UTF-8 instead of falling back to the system code page.
 *
 * Call this when building a custom env object for `spawn()`:
 * ```ts
 * const env = { ...process.env, ...utf8EnvOverrides(), MY_VAR: "x" };
 * ```
 */
export function utf8EnvOverrides(): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };

  if (process.platform === "win32") {
    overrides.LANG = "C.UTF-8";
    overrides.LC_ALL = "C.UTF-8";
  }

  return overrides;
}

/**
 * Applies UTF-8 environment variables to `process.env` in-place so that all
 * subsequently spawned child processes inherit them. Also ensures PATHEXT on
 * Windows contains the standard executable extensions.
 *
 * Call once at main process startup, before any provider session or shell
 * command is spawned.
 */
export function applyUtf8ProcessEnv(): void {
  Object.assign(process.env, utf8EnvOverrides());

  if (process.platform === "win32") {
    ensureWindowsPathExt();
  }
}

/**
 * Ensures `PATHEXT` contains the standard Windows executable extensions.
 *
 * Some minimal or customized Windows environments may have a truncated PATHEXT,
 * causing `where`/`spawn` to miss `.cmd`/`.exe` files when resolving commands
 * like `codex`, `claude`, or `opencode`.
 */
function ensureWindowsPathExt(): void {
  const pathExtKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "pathext") ?? "PATHEXT";
  const currentEntries = (process.env[pathExtKey] ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set(currentEntries.map((entry) => entry.toUpperCase()));

  for (const extension of [".COM", ".EXE", ".BAT", ".CMD"]) {
    if (!seen.has(extension)) {
      currentEntries.push(extension);
      seen.add(extension);
    }
  }

  process.env[pathExtKey] = currentEntries.join(";");
}
