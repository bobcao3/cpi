import { extname } from "node:path";
import {
  type Language,
  LANGUAGE_EXTENSIONS,
  LANGUAGE_MARKERS,
} from "./discover.ts";
import { type LspConfig, loadLspConfig } from "../config.ts";
import { getCwd } from "../cwd.ts";

export interface SpawnDirective {
  cmd: string;
  args: string[];
  cwd?: string;
}

export interface LspInstallSpec {
  method: "npm" | "uv" | "reuse" | "env-only";
  /** npm/uv package name (absent for "reuse"). */
  package?: string;
  /** Pinned exact version (absent for "reuse"). */
  version?: string;
  /** typescript only: paired `typescript` version verified together at provision. */
  tsVersion?: string;
}

export interface LspServerSpec {
  language: Language;
  extensions: string[];
  markers: string[];
  /** LSP languageId for a path: "typescript"|"typescriptreact"|"python"|"bash"|"bats"|"sh"|"zsh"|"mksh"|"ruby". */
  languageId: (path: string) => string;
  install: LspInstallSpec;
  binName: string;
  serverCommand: (bin: string, root: string) => SpawnDirective;
  initOptions?: unknown;
  /** Diagnostics transport: "push" (server publishes via textDocument/publishDiagnostics, the default) or "pull" (worker calls textDocument/diagnostic per LSP 3.17 — used by ruby-lsp 0.26+, which is pull-only). */
  diagnosticMode?: "push" | "pull";
}

function typescriptSpec(cfg: LspConfig): LspServerSpec {
  const ts = cfg.servers.typescript;
  return {
    language: "typescript",
    extensions: LANGUAGE_EXTENSIONS.typescript,
    markers: LANGUAGE_MARKERS.typescript,
    languageId: (path) =>
      extname(path).toLowerCase() === ".tsx" ? "typescriptreact" : "typescript",
    install: {
      method: "npm",
      package: ts.package,
      version: ts.version,
      tsVersion: ts.tsVersion,
    },
    binName: "typescript-language-server",
    serverCommand: (bin) => ({ cmd: bin, args: ["--stdio"] }),
    initOptions: { hostInfo: "cpi" },
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
    // Implicit projects (no pyrefly.toml) require typeCheckingMode "default"; pyrefly.toml presets override it. Requires pyrefly >=1.0.
    initOptions: { pyrefly: { typeCheckingMode: "default" } },
  };
}

function shellLanguageId(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".zsh":
      return "zsh";
    case ".mksh":
      return "mksh";
    case ".bash":
      return "bash";
    case ".bats":
      return "bats";
    default:
      return "sh";
  }
}

function shellSpec(cfg: LspConfig): LspServerSpec {
  void cfg;
  return {
    language: "shell",
    extensions: LANGUAGE_EXTENSIONS.shell,
    markers: LANGUAGE_MARKERS.shell,
    languageId: shellLanguageId,
    install: { method: "reuse" },
    binName: "shuck",
    serverCommand: (bin) => ({ cmd: bin, args: ["server", "--isolated"] }),
  };
}

function rubySpec(cfg: LspConfig): LspServerSpec {
  void cfg;
  return {
    language: "ruby",
    extensions: LANGUAGE_EXTENSIONS.ruby,
    markers: LANGUAGE_MARKERS.ruby,
    languageId: () => "ruby",
    install: { method: "env-only" },
    diagnosticMode: "pull",
    binName: "ruby-lsp",
    serverCommand: (bin) => ({ cmd: bin, args: [] }),
  };
}

export function getLspServerSpec(
  language: Language,
  cwd: string = getCwd(),
): LspServerSpec {
  const cfg = loadLspConfig(cwd);
  switch (language) {
    case "typescript":
      return typescriptSpec(cfg);
    case "python":
      return pythonSpec(cfg);
    case "shell":
      return shellSpec(cfg);
    case "ruby":
      return rubySpec(cfg);
    default:
      throw new Error(`getLspServerSpec: unknown language ${String(language)}`);
  }
}

export function loadAllLspSpecs(
  cwd: string = getCwd(),
): Record<Language, LspServerSpec> {
  const cfg = loadLspConfig(cwd);
  return {
    typescript: typescriptSpec(cfg),
    python: pythonSpec(cfg),
    shell: shellSpec(cfg),
    ruby: rubySpec(cfg),
  };
}
