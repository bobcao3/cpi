/**
 * Language registry — `LspServerSpec` per language (pure node, design §6.2).
 *
 * One spec per language describing how to discover, install, spawn, and
 * full-check its LSP server. Version pins come from {@link loadLspConfig} so a
 * config pin bump re-provisions on the next session (the version-match check
 * in provision.ts, Layer 3). Pure node — imports only config + discover types.
 *
 * Python `fullCheckCommand` runs `pyrefly check` with `cwd = root` (project
 * mode from cwd), **not** `pyrefly check <root>` (which is per-file mode).
 * Typescript `fullCheckCommand` runs `tsc --noEmit -p <root>`, with `tsc`
 * resolved from the server env's `node_modules/.bin` (sibling of the server
 * binary); env-provided reuse is a Layer 3 concern.
 */

import { dirname, extname, join } from "node:path";
import { type Language, LANGUAGE_EXTENSIONS, LANGUAGE_MARKERS } from "./discover.ts";
import { type LspConfig, loadLspConfig } from "../config.ts";

/** Spawn directive: command + args (+ optional cwd override). */
export interface SpawnDirective {
  cmd: string;
  args: string[];
  cwd?: string;
}

/** Full-package check directive (CLI checker, e.g. `tsc --noEmit -p <root>`). */
export interface FullCheck {
  cmd: string;
  args: string[];
  cwd?: string;
}

/** Install description; versions pinned via config (§6.6, §12). */
export interface LspInstallSpec {
  method: "npm" | "uv" | "reuse";
  /** npm/uv package name (absent for "reuse"). */
  package?: string;
  /** Pinned exact version (absent for "reuse"). */
  version?: string;
  /** typescript only: paired `typescript` version verified together at provision. */
  tsVersion?: string;
}

/** Complete description of one language's LSP server (design §6.2). */
export interface LspServerSpec {
  language: Language;
  extensions: string[];
  markers: string[];
  /** LSP languageId for a path: "typescript"|"typescriptreact"|"python"|"bash". */
  languageId: (path: string) => string;
  install: LspInstallSpec;
  /** Server binary name to resolve on PATH before installing. */
  binName: string;
  /** Build the stdio server spawn directive from the resolved binary + root. */
  serverCommand: (bin: string, root: string) => SpawnDirective;
  /** `initialize` options (passed through by the worker, Layer 3). */
  initOptions?: unknown;
  /** Whether a full-package CLI check exists for this language. */
  supportsFullPackageCheck: boolean;
  /** Build the full-package check directive, or undefined when unsupported. */
  fullCheckCommand?: (bin: string, root: string) => FullCheck;
}

function typescriptSpec(cfg: LspConfig): LspServerSpec {
  const ts = cfg.servers.typescript;
  return {
    language: "typescript",
    extensions: LANGUAGE_EXTENSIONS.typescript,
    markers: LANGUAGE_MARKERS.typescript,
    languageId: (path) =>
      extname(path).toLowerCase() === ".tsx" ? "typescriptreact" : "typescript",
    install: { method: "npm", package: ts.package, version: ts.version, tsVersion: ts.tsVersion },
    binName: "typescript-language-server",
    serverCommand: (bin) => ({ cmd: bin, args: ["--stdio"] }),
    initOptions: { hostInfo: "cpi" },
    supportsFullPackageCheck: true,
    fullCheckCommand: (bin, root) => ({
      cmd: join(dirname(bin), "tsc"),
      args: ["--noEmit", "-p", root],
    }),
  };
}

function pythonSpec(cfg: LspConfig): LspServerSpec {
  const py = cfg.servers.python;
  return {
    language: "python",
    extensions: LANGUAGE_EXTENSIONS.python,
    markers: LANGUAGE_MARKERS.python,
    languageId: () => "python",
    install: { method: "uv", package: py.package, version: py.version },
    binName: "pyrefly",
    serverCommand: (bin) => ({ cmd: bin, args: ["lsp"] }),
    supportsFullPackageCheck: true,
    // `pyrefly check` with cwd=root → project mode. Passing <root> as a file
    // arg would be per-file mode, so cwd (not an arg) carries the root.
    fullCheckCommand: (bin, root) => ({ cmd: bin, args: ["check"], cwd: root }),
  };
}

function shellSpec(cfg: LspConfig): LspServerSpec {
  // cfg.servers.shell.enabled is consulted by the manager (Layer 3); the spec
  // itself is built unconditionally so resolution can reuse the global shuck.
  void cfg;
  return {
    language: "shell",
    extensions: LANGUAGE_EXTENSIONS.shell,
    markers: LANGUAGE_MARKERS.shell,
    languageId: () => "bash",
    install: { method: "reuse" },
    binName: "shuck",
    serverCommand: (bin) => ({ cmd: bin, args: ["server", "--isolated"] }),
    supportsFullPackageCheck: false,
  };
}

/** Resolve the spec for one language, reading version pins from config. */
export function getLspServerSpec(language: Language, cwd: string = process.cwd()): LspServerSpec {
  const cfg = loadLspConfig(cwd);
  switch (language) {
    case "typescript":
      return typescriptSpec(cfg);
    case "python":
      return pythonSpec(cfg);
    case "shell":
      return shellSpec(cfg);
    default:
      throw new Error(`getLspServerSpec: unknown language ${String(language)}`);
  }
}

/** Build specs for every language (for `lsp list_sessions` / enumeration). */
export function loadAllLspSpecs(cwd: string = process.cwd()): Record<Language, LspServerSpec> {
  const cfg = loadLspConfig(cwd);
  return {
    typescript: typescriptSpec(cfg),
    python: pythonSpec(cfg),
    shell: shellSpec(cfg),
  };
}
