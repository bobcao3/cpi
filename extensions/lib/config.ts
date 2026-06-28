/**
 * Shared cpi configuration loader.
 *
 * Reads from three JSON files, deep-merged at load time (later layers win):
 *
 *   cpi-config.default.json       (shipped defaults — the documented base)
 *   ~/.pi/agent/cpi-config.json   (user-level, all projects)
 *   <cwd>/.pi/cpi-config.json     (project-level, overrides user)
 *
 * The merge is a recursive deep merge: for each key in both objects, if both
 * values are plain objects they are merged recursively; otherwise the project
 * value replaces the user value. Arrays are replaced wholesale (project wins).
 *
 * Each extension imports {@link loadCpiConfig} and reads its own section,
 * falling back to the shipped default config for any missing field. This keeps
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
import { fileURLToPath } from "node:url";

// ── types ────────────────────────────────────────────────────────────────────

export interface ShellConfig {
  /** Seconds to wait before backgrounding a command (default: 5). */
  defaultWaitfor: number;
  /** Maximum allowed waitfor value; larger values error (default: 30). */
  maxWaitfor: number;
  /**
   * Maximum lines of agent-facing command output kept by the tail preview (default:
   * 500). Independent of the TUI's folded preview (tailLines).
   */
  maxPreviewLines: number;
  /** Maximum bytes of agent-facing output kept by the tail preview (default: 32768). */
  previewMaxBytes: number;
  /** Max bytes accumulated in memory per shell before trimming (default: 4194304). */
  maxAcc: number;
  /** Minimum ms between streaming partial updates; 0 disables throttling (default: 200). */
  updateMs: number;
  /** TUI folded-preview line count, independent of agent output truncation (default: 5). */
  tailLines: number;
  /** Max chars of the `describe` summary shown in the UI (default: 48). */
  describeMax: number;
}

export interface CavemanConfig {
  /** Appended to the system prompt each turn when caveman is enabled. */
  system_prompt: string;
  /** User message injected when caveman is toggled ON mid-conversation. */
  mid_convo_nudge_positive: string;
  /** User message injected when caveman is toggled OFF mid-conversation. */
  mid_convo_nudge_negative: string;
}

export interface EditorChainRule {
  /** Raw JavaScript RegExp source applied to the main model id; bare `(...)` captures, `|` alternation. */
  search: string;
  /** Replacement producing the candidate model id via `mainId.replace(search, replace)`. Supports `$1`..`$9` backrefs and `$&` (whole match). */
  replace: string;
}

export interface EditorConfig {
  /** Model id for the Viewer/Editor subagents (e.g. "claude-sonnet-4-5-20250929"). Omit to derive from the main model. */
  model?: string;
  /** Provider for the editor model; inferred from the model id when absent. */
  provider?: string;
  /** Max file size (bytes) read/edited before refusing (default 262144). */
  maxFileBytes?: number;
  /** Hard kill timeout for a subagent pi call, in ms (default 120000). */
  subagentTimeoutMs?: number;
  /** Directory for persisted subagent transcripts (default ~/.pi/agent/cpi-editor). */
  transcriptDir?: string;
  /** Max transcript files retained; oldest rotated (default 200). */
  maxTranscripts?: number;
  /** Aider-style fuzzy SEARCH/REPLACE fallback (uniform-indent tolerance + `...` elision) when an exact SEARCH misses. Default true. */
  fuzzyMatch?: boolean;
  /** Ordered {search,replace} rules producing candidate editor model ids from the main model id. Shipped defaults are a cost+recency ladder: a ≤0.6x-cost (primary ~0.2x) model that is also ≤6 months old, then a fallback, then implicit identity (fall-through = "if not available"). Stale/retired models are never targets. */
  chain?: EditorChainRule[];
}

export interface ResolvedEditorConfig {
  /** Model id for the Viewer/Editor subagents; undefined when derived from the main model. */
  model?: string;
  /** Provider for the editor model; inferred from the model id when absent. */
  provider?: string;
  /** Max file size (bytes) read/edited before refusing. Always set by loadEditorConfig. */
  maxFileBytes: number;
  /** Hard kill timeout for a subagent pi call, in ms. Always set by loadEditorConfig. */
  subagentTimeoutMs: number;
  /** Directory for persisted subagent transcripts. Always set by loadEditorConfig ("" if unset). */
  transcriptDir: string;
  /** Max transcript files retained; oldest rotated. Always set by loadEditorConfig. */
  maxTranscripts: number;
  /** Aider-style fuzzy SEARCH/REPLACE fallback. Always set by loadEditorConfig. */
  fuzzyMatch: boolean;
  /** Ordered {search,replace} rules producing candidate editor model ids. Always set (possibly empty). */
  chain: EditorChainRule[];
}

export interface LspTypescriptServerConfig {
  package: string;
  version: string;
  tsVersion: string;
}
export interface LspPythonServerConfig {
  package: string;
  version: string;
}
export interface LspShellServerConfig {
  enabled: boolean;
}
export interface LspServersConfig {
  typescript: LspTypescriptServerConfig;
  python: LspPythonServerConfig;
  shell: LspShellServerConfig;
}
export interface LspUvToolConfig {
  version: string;
  repo: string;
  verify: string;
}
export interface LspToolsConfig {
  uv: LspUvToolConfig;
}
export interface LspConfig {
  startupTimeoutMs: number;
  lintTimeoutMs: number;
  installTimeoutMs: number;
  discoveryMaxDepth: number;
  servers: LspServersConfig;
  tools: LspToolsConfig;
}
export interface CpiConfig {
  shell?: ShellConfig;
  caveman?: CavemanConfig;
  editor?: EditorConfig;
  lsp?: LspConfig;
  // Future extensions add their sections here.
}

// ── defaults ─────────────────────────────────────────────────────────────────

let defaultCache: CpiConfig | null = null;

/**
 * Load the shipped default config (`cpi-config.default.json`, resolved relative
 * to this module). This is the documented base layer that user/project configs
 * deep-merge over. Cached after first read. Throws if missing or invalid — it
 * ships with the package, so absence is a packaging error worth surfacing rather
 * than silently degrading every extension that reads config.
 */
export function loadDefaultConfig(): CpiConfig {
  if (defaultCache) return defaultCache;
  const path = fileURLToPath(new URL("../../cpi-config.default.json", import.meta.url));
  const raw = loadConfigFile(path);
  if (!raw) {
    throw new Error(
      `[cpi-config] default config missing or invalid at ${path}; restore cpi-config.default.json.`,
    );
  }
  defaultCache = raw as unknown as CpiConfig;
  return defaultCache;
}

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
export function deepMerge<T>(user: T, project: Partial<T> | undefined): T {
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
 * Load the full cpi config: user-level + project-level cpi-config.json, deep
 * merged, then defaults merged underneath so missing fields fall back.
 */
export function loadCpiConfig(cwd: string = process.cwd()): CpiConfig {
  const userPath = join(process.env.HOME ?? "", ".pi", "agent", "cpi-config.json");
  const projectPath = join(cwd, ".pi", "cpi-config.json");

  const user = loadConfigFile(userPath);
  const project = loadConfigFile(projectPath);

  // Deep-merge user + project, then merge the shipped defaults under the
  // result so any missing fields fall back to cpi-config.default.json.
  const merged = deepMerge(user ?? {}, project ?? {});
  const config = deepMerge(loadDefaultConfig(), merged);

  return config;
}

/**
 * Load and validate the shell section of the config.
 * Ensures numeric fields are sane and clamped to reasonable ranges.
 */
function intInRange(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function loadShellConfig(cwd: string = process.cwd()): ShellConfig {
  const config = loadCpiConfig(cwd);
  const defaults = loadDefaultConfig();
  const s = config.shell ?? defaults.shell!;
  const d = defaults.shell!;
  const defaultWaitfor = Number(s.defaultWaitfor);
  const maxWaitfor = Number(s.maxWaitfor);
  return {
    defaultWaitfor:
      Number.isFinite(defaultWaitfor) && defaultWaitfor > 0 ? defaultWaitfor : d.defaultWaitfor,
    maxWaitfor: Number.isFinite(maxWaitfor) && maxWaitfor > 0 ? maxWaitfor : d.maxWaitfor,
    maxPreviewLines: intInRange(s.maxPreviewLines, d.maxPreviewLines, 1, 10000),
    previewMaxBytes: intInRange(s.previewMaxBytes, d.previewMaxBytes, 1024, 1048576),
    maxAcc: intInRange(s.maxAcc, d.maxAcc, 65536, 67108864),
    updateMs: intInRange(s.updateMs, d.updateMs, 0, 60000),
    tailLines: intInRange(s.tailLines, d.tailLines, 1, 200),
    describeMax: intInRange(s.describeMax, d.describeMax, 8, 200),
  };
}

/** Coerce a config value to a string, defaulting to "" when absent/non-string. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Coerce a config value to a boolean, defaulting to `fallback` when absent/non-boolean. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Load the caveman section: the default config's `caveman` deep-merged with the
 * user/project `caveman` config, with each string field coerced to a string
 * ("" if missing or non-string). Cheap file read; callers may invoke per-turn
 * without caching.
 */
export function loadCavemanConfig(cwd: string = process.cwd()): CavemanConfig {
  const config = loadCpiConfig(cwd);
  const merged = deepMerge(loadDefaultConfig().caveman!, config.caveman);
  return {
    system_prompt: str(merged.system_prompt),
    mid_convo_nudge_positive: str(merged.mid_convo_nudge_positive),
    mid_convo_nudge_negative: str(merged.mid_convo_nudge_negative),
  };
}

/**
 * Load and validate the editor section. Defaults from cpi-config.default.json
 * deep-merged under the user/project `editor` config; numeric fields clamped.
 */
export function loadEditorConfig(cwd: string = process.cwd()): ResolvedEditorConfig {
  const config = loadCpiConfig(cwd);
  const d = loadDefaultConfig().editor ?? {};
  const e = deepMerge(d, config.editor ?? {}) as ResolvedEditorConfig;
  const maxFileBytes = Number(e.maxFileBytes);
  const subagentTimeoutMs = Number(e.subagentTimeoutMs);
  const maxTranscripts = Number(e.maxTranscripts);
  const chain: EditorChainRule[] = Array.isArray(e.chain)
    ? e.chain
        .filter((r) => r && typeof r.search === "string" && typeof r.replace === "string")
        .map((r) => ({ search: r.search as string, replace: r.replace as string }))
    : [];
  return {
    model: typeof e.model === "string" ? e.model : undefined,
    provider: typeof e.provider === "string" ? e.provider : undefined,
    maxFileBytes: Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 262144,
    subagentTimeoutMs:
      Number.isFinite(subagentTimeoutMs) && subagentTimeoutMs > 0 ? subagentTimeoutMs : 120000,
    transcriptDir: typeof e.transcriptDir === "string" ? e.transcriptDir : "",
    maxTranscripts: Number.isFinite(maxTranscripts) && maxTranscripts > 0 ? maxTranscripts : 200,
    fuzzyMatch: bool(e.fuzzyMatch, true),
    chain,
  };
}

/**
 * Load and validate the lsp section (design §11). Defaults from
 * cpi-config.default.json deep-merged under the user/project `lsp` config;
 * numeric fields clamped via {@link intInRange}, string pins coerced via
 * {@link str} (defaulting to the shipped pin when absent).
 */
export function loadLspConfig(cwd: string = process.cwd()): LspConfig {
  const config = loadCpiConfig(cwd);
  const d = loadDefaultConfig().lsp!;
  const merged = deepMerge(d, config.lsp ?? {}) as LspConfig;
  const dt = d.servers.typescript;
  const dp = d.servers.python;
  const ds = d.servers.shell;
  const du = d.tools.uv;
  const mt = merged.servers?.typescript;
  const mp = merged.servers?.python;
  const ms = merged.servers?.shell;
  const mu = merged.tools?.uv;
  return {
    startupTimeoutMs: intInRange(merged.startupTimeoutMs, d.startupTimeoutMs, 1000, 300000),
    lintTimeoutMs: intInRange(merged.lintTimeoutMs, d.lintTimeoutMs, 500, 120000),
    installTimeoutMs: intInRange(merged.installTimeoutMs, d.installTimeoutMs, 1000, 600000),
    discoveryMaxDepth: intInRange(merged.discoveryMaxDepth, d.discoveryMaxDepth, 1, 256),
    servers: {
      typescript: {
        package: str(mt?.package) || dt.package,
        version: str(mt?.version) || dt.version,
        tsVersion: str(mt?.tsVersion) || dt.tsVersion,
      },
      python: {
        package: str(mp?.package) || dp.package,
        version: str(mp?.version) || dp.version,
      },
      shell: { enabled: bool(ms?.enabled, ds.enabled) },
    },
    tools: {
      uv: {
        version: str(mu?.version) || du.version,
        repo: str(mu?.repo) || du.repo,
        verify: str(mu?.verify) || du.verify,
      },
    },
  };
}
