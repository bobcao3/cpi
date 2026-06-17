/**
 * Shared cpi configuration loader.
 *
 * Reads from two JSON files, merged at load time:
 *
 *   ~/.pi/agent/cpi-config.json   (user-level, all projects)
 *   <cwd>/.pi/cpi-config.json     (project-level, overrides user)
 *
 * The merge is a recursive deep merge: for each key in both objects, if both
 * values are plain objects they are merged recursively; otherwise the project
 * value replaces the user value. Arrays are replaced wholesale (project wins).
 *
 * Each extension imports {@link loadCpiConfig} and reads its own section,
 * falling back to built-in defaults for any missing field. This keeps
 * extensions decoupled — they only know about their own config shape.
 *
 * Why a separate file (not pi's settings.json)?
 *   - pi's settings.json schema is owned by the pi framework; unknown keys
 *     may be rejected or silently dropped in future versions.
 *   - The provider-fallback extension already established the separate-file
 *     pattern (fallback-providers.json), so cpi-config.json is consistent.
 *   - Extensions load before pi's settings system is fully resolved in some
 *     code paths (e.g. provider registration in the factory body), so a
 *     standalone file read is more reliable.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── types ────────────────────────────────────────────────────────────────────

export interface ShellConfig {
  /** Seconds to wait before backgrounding a command (default: 5). */
  defaultWaitfor: number;
  /** Maximum allowed waitfor value; larger values error (default: 30). */
  maxWaitfor: number;
}

export interface CpiConfig {
  shell?: ShellConfig;
  // Future extensions add their sections here.
}

// ── defaults ─────────────────────────────────────────────────────────────────

export const DEFAULTS: CpiConfig = {
  shell: {
    defaultWaitfor: 5,
    maxWaitfor: 30,
  },
};

// ── loading & merging ────────────────────────────────────────────────────────

function loadConfigFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`[cpi-config] failed to parse ${path}: ${err}\n`);
    return null;
  }
}

/**
 * Recursive deep merge. For each key present in both `user` and `project`:
 *  - If both values are plain objects, merge them recursively.
 *  - Otherwise, project's value replaces user's.
 * Returns a new object; inputs are not mutated.
 */
function deepMerge<T>(user: T, project: Partial<T> | undefined): T {
  if (project === undefined) return user;
  if (typeof user !== "object" || user === null) return project as T;
  if (typeof project !== "object" || project === null) return project as T;
  if (Array.isArray(user) || Array.isArray(project)) return project as T;

  const merged: Record<string, unknown> = { ...(user as Record<string, unknown>) };
  for (const [key, projectVal] of Object.entries(project as Record<string, unknown>)) {
    const userVal = (user as Record<string, unknown>)[key];
    if (
      userVal !== undefined &&
      typeof userVal === "object" &&
      userVal !== null &&
      !Array.isArray(userVal) &&
      typeof projectVal === "object" &&
      projectVal !== null &&
      !Array.isArray(projectVal)
    ) {
      merged[key] = deepMerge(userVal, projectVal as Record<string, unknown>);
    } else {
      merged[key] = projectVal;
    }
  }
  return merged as T;
}

/**
 * Merge a user-level config section with a project-level one, then apply
 * built-in defaults for any missing fields.
 *
 * @param section  - The top-level config key (e.g. "shell").
 * @param defaults - The full defaults object for this section.
 * @param cwd      - The project working directory (for project-level config).
 */
export function loadCpiConfig(cwd: string = process.cwd()): CpiConfig {
  const userPath = join(process.env.HOME ?? "", ".pi", "agent", "cpi-config.json");
  const projectPath = join(cwd, ".pi", "cpi-config.json");

  const user = loadConfigFile(userPath);
  const project = loadConfigFile(projectPath);

  // Deep-merge user + project, then merge defaults under the result so that
  // any missing fields fall back to built-in defaults.
  const merged = deepMerge(user ?? {}, project ?? {});
  const config = deepMerge(DEFAULTS, merged);

  return config;
}

/**
 * Load and validate the shell section of the config.
 * Ensures numeric fields are sane and clamped to reasonable ranges.
 */
export function loadShellConfig(cwd: string = process.cwd()): ShellConfig {
  const config = loadCpiConfig(cwd);
  const shell = config.shell ?? DEFAULTS.shell!;

  const defaultWaitfor = Number(shell.defaultWaitfor);
  const maxWaitfor = Number(shell.maxWaitfor);

  return {
    defaultWaitfor:
      Number.isFinite(defaultWaitfor) && defaultWaitfor > 0
        ? defaultWaitfor
        : DEFAULTS.shell!.defaultWaitfor,
    maxWaitfor:
      Number.isFinite(maxWaitfor) && maxWaitfor > 0 ? maxWaitfor : DEFAULTS.shell!.maxWaitfor,
  };
}
