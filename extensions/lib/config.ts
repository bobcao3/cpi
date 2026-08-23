/**
 * Shared cpi configuration loader: deep-merges three JSON files at load time
 * (later wins): cpi-config.default.json, ~/.pi/agent/cpi-config.json,
 * <cwd>/.pi/cpi-config.json. Plain objects merge recursively; arrays are
 * replaced wholesale. A separate file, not pi's settings.json: that schema is
 * pi-owned and extensions load before it resolves.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCwd } from "./cwd.ts";

export interface ShellConfig {
  /** Shell executable to use (`auto` follows `$SHELL`; otherwise a command/path). */
  executable: string;
  defaultWaitfor: number;
  maxWaitfor: number;
  /** Agent-facing tail-preview lines (default 500); independent of the TUI's folded preview. */
  maxPreviewLines: number;
  previewMaxBytes: number;
  maxAcc: number;
  updateMs: number;
  tailLines: number;
  describeMax: number;
}

export interface EditorChainRule {
  /** Raw JavaScript RegExp source applied to the main model id; bare `(...)` captures, `|` alternation. */
  search: string;
  /** Replacement producing the candidate model id via `mainId.replace(search, replace)`. Supports `$1`..`$9` backrefs and `$&` (whole match). */
  replace: string;
}

export type EditorMode = "tool-call" | "direct-diff";

export interface EditorConfig {
  /** Editor subagent model id; omit to derive from the main model. */
  model?: string;
  mode?: EditorMode;
  provider?: string;
  maxFileBytes?: number;
  subagentTimeoutMs?: number;
  /** Bounded number of validation-feedback turns after the initial response. */
  maxCorrectionTurns?: number;
  transcriptDir?: string;
  maxTranscripts?: number;
  /** Whitespace/elision fallback (trailing whitespace, uniform indentation, `...` elision) when anchored exact matching misses. Default true. */
  fuzzyMatch?: boolean;
  /** Ordered {search,replace} rules deriving candidate editor model ids; fall-through = keep the main model. */
  chain?: EditorChainRule[];
}

export interface ResolvedEditorConfig {
  model?: string;
  mode: EditorMode;
  provider?: string;
  maxFileBytes: number;
  subagentTimeoutMs: number;
  maxCorrectionTurns: number;
  transcriptDir: string;
  maxTranscripts: number;
  fuzzyMatch: boolean;
  chain: EditorChainRule[];
}

export interface FastConfig {
  providers: string[];
  models: string[];
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
  editor?: EditorConfig;
  fast?: FastConfig;
  lsp?: LspConfig;
  // Future extensions add their sections here.
}

let defaultCache: CpiConfig | null = null;

/** Shipped defaults, cached after first read. Throws if missing/invalid —
 *  absence is a packaging error; silent degradation would hide it. */
export function loadDefaultConfig(): CpiConfig {
  if (defaultCache) return defaultCache;
  const path = fileURLToPath(
    new URL("../../cpi-config.default.json", import.meta.url),
  );
  const raw = loadConfigFile(path);
  if (!raw) {
    throw new Error(
      `[cpi-config] default config missing or invalid at ${path}; restore cpi-config.default.json.`,
    );
  }
  defaultCache = raw as unknown as CpiConfig;
  return defaultCache;
}

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

// Returns a new object; inputs are not mutated.
export function deepMerge<T>(user: T, project: Partial<T> | undefined): T {
  if (project === undefined) return user;
  if (typeof user !== "object" || user === null) return project as T;
  if (typeof project !== "object" || project === null) return project as T;
  if (Array.isArray(user) || Array.isArray(project)) return project as T;

  const merged: Record<string, unknown> = {
    ...(user as Record<string, unknown>),
  };
  for (const [key, projectVal] of Object.entries(
    project as Record<string, unknown>,
  )) {
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

export function loadCpiConfig(cwd: string = getCwd()): CpiConfig {
  const userPath = join(
    process.env.HOME ?? "",
    ".pi",
    "agent",
    "cpi-config.json",
  );
  const projectPath = join(cwd, ".pi", "cpi-config.json");

  const user = loadConfigFile(userPath);
  const project = loadConfigFile(projectPath);

  const merged = deepMerge(user ?? {}, project ?? {});
  const config = deepMerge(loadDefaultConfig(), merged);

  return config;
}

function intInRange(
  v: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function loadShellConfig(cwd: string = getCwd()): ShellConfig {
  const config = loadCpiConfig(cwd);
  const defaults = loadDefaultConfig();
  const s = config.shell ?? defaults.shell!;
  const d = defaults.shell!;
  const defaultWaitfor = Number(s.defaultWaitfor);
  const maxWaitfor = Number(s.maxWaitfor);
  return {
    executable: str(s.executable) || str(d.executable) || "auto",
    defaultWaitfor:
      Number.isFinite(defaultWaitfor) && defaultWaitfor > 0
        ? defaultWaitfor
        : d.defaultWaitfor,
    maxWaitfor:
      Number.isFinite(maxWaitfor) && maxWaitfor > 0 ? maxWaitfor : d.maxWaitfor,
    maxPreviewLines: intInRange(s.maxPreviewLines, d.maxPreviewLines, 1, 10000),
    previewMaxBytes: intInRange(
      s.previewMaxBytes,
      d.previewMaxBytes,
      1024,
      1048576,
    ),
    maxAcc: intInRange(s.maxAcc, d.maxAcc, 65536, 67108864),
    updateMs: intInRange(s.updateMs, d.updateMs, 0, 60000),
    tailLines: intInRange(s.tailLines, d.tailLines, 1, 200),
    describeMax: intInRange(s.describeMax, d.describeMax, 8, 200),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function loadEditorConfig(cwd: string = getCwd()): ResolvedEditorConfig {
  const config = loadCpiConfig(cwd);
  const d = loadDefaultConfig().editor ?? {};
  const e = deepMerge(d, config.editor ?? {}) as ResolvedEditorConfig;
  const maxFileBytes = Number(e.maxFileBytes);
  const subagentTimeoutMs = Number(e.subagentTimeoutMs);
  const maxTranscripts = Number(e.maxTranscripts);
  const chain: EditorChainRule[] = Array.isArray(e.chain)
    ? e.chain
        .filter(
          (r) =>
            r && typeof r.search === "string" && typeof r.replace === "string",
        )
        .map((r) => ({
          search: r.search as string,
          replace: r.replace as string,
        }))
    : [];
  return {
    model: typeof e.model === "string" ? e.model : undefined,
    mode: e.mode === "direct-diff" ? "direct-diff" : "tool-call",
    provider: typeof e.provider === "string" ? e.provider : undefined,
    maxFileBytes:
      Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 262144,
    subagentTimeoutMs:
      Number.isFinite(subagentTimeoutMs) && subagentTimeoutMs > 0
        ? subagentTimeoutMs
        : 120000,
    maxCorrectionTurns: intInRange(
      e.maxCorrectionTurns,
      intInRange(d.maxCorrectionTurns, 2, 0, 8),
      0,
      8,
    ),
    transcriptDir: typeof e.transcriptDir === "string" ? e.transcriptDir : "",
    maxTranscripts:
      Number.isFinite(maxTranscripts) && maxTranscripts > 0
        ? maxTranscripts
        : 200,
    fuzzyMatch: bool(e.fuzzyMatch, true),
    chain,
  };
}

export function loadLspConfig(cwd: string = getCwd()): LspConfig {
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
    startupTimeoutMs: intInRange(
      merged.startupTimeoutMs,
      d.startupTimeoutMs,
      1000,
      300000,
    ),
    lintTimeoutMs: intInRange(
      merged.lintTimeoutMs,
      d.lintTimeoutMs,
      500,
      120000,
    ),
    installTimeoutMs: intInRange(
      merged.installTimeoutMs,
      d.installTimeoutMs,
      1000,
      600000,
    ),
    discoveryMaxDepth: intInRange(
      merged.discoveryMaxDepth,
      d.discoveryMaxDepth,
      1,
      256,
    ),
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
