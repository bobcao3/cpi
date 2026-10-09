import { extname } from "node:path";
import {
  type Language,
  LANGUAGE_EXTENSIONS,
  LANGUAGE_MARKERS,
  zigVersionPin,
} from "./discover.ts";
import { type LspConfig, loadLspConfig } from "../config.ts";
import { getCwd } from "../cwd.ts";

export interface SpawnDirective {
  cmd: string;
  args: string[];
  cwd?: string;
}

export interface LspInstallSpec {
  method: "npm" | "uv" | "reuse" | "env-only" | "go" | "zls";
  /** npm/uv/go package name (absent for download/reuse methods). */
  package?: string;
  /** Pinned exact version (absent for "reuse"). */
  version?: string;
  /** Project Zig version pin ("zls"): provisioning prefers it over `version`. */
  pin?: string | null;
  /** typescript only: paired `typescript` version verified together at provision. */
  tsVersion?: string;
  /** "zls": release-worker base URL and minisign trust anchor for the download. */
  releases?: string;
  pubkey?: string;
}

export interface LspServerSpec {
  language: Language;
  extensions: string[];
  markers: string[];
  /** LSP languageId for a path: "typescript"|"typescriptreact"|"python"|"bash"|"bats"|"sh"|"zsh"|"mksh"|"ruby"|"go"|"zig"|"zon". */
  languageId: (path: string) => string;
  install: LspInstallSpec;
  /** Diagnostic source label the server reports under. */
  source: string;
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
    source: "tsserver",
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
    source: "pyrefly",
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
    source: "shuck",
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
    source: "ruby-lsp",
    binName: "ruby-lsp",
    serverCommand: (bin) => ({ cmd: bin, args: [] }),
  };
}

function goSpec(cfg: LspConfig): LspServerSpec {
  const go = cfg.servers.go;
  return {
    language: "go",
    extensions: LANGUAGE_EXTENSIONS.go,
    markers: LANGUAGE_MARKERS.go,
    languageId: () => "go",
    install: { method: "go", package: go.package, version: go.version },
    source: "gopls",
    binName: "gopls",
    serverCommand: (bin) => ({ cmd: bin, args: [] }),
  };
}

function zigSpec(cfg: LspConfig, root: string): LspServerSpec {
  const zig = cfg.servers.zig;
  return {
    language: "zig",
    extensions: LANGUAGE_EXTENSIONS.zig,
    markers: LANGUAGE_MARKERS.zig,
    languageId: (path) =>
      extname(path).toLowerCase() === ".zon" ? "zon" : "zig",
    install: {
      method: "zls",
      pin: zigVersionPin(root),
      version: zig.version,
      releases: zig.releases,
      pubkey: zig.pubkey,
    },
    source: "zls",
    binName: "zls",
    serverCommand: (bin) => ({ cmd: bin, args: [] }),
  };
}

/** `projectRoot` feeds the zig version pin; config always resolves from the cwd. */
export function getLspServerSpec(
  language: Language,
  projectRoot: string = getCwd(),
): LspServerSpec {
  const cfg = loadLspConfig();
  switch (language) {
    case "typescript":
      return typescriptSpec(cfg);
    case "python":
      return pythonSpec(cfg);
    case "shell":
      return shellSpec(cfg);
    case "ruby":
      return rubySpec(cfg);
    case "go":
      return goSpec(cfg);
    case "zig":
      return zigSpec(cfg, projectRoot);
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
    go: goSpec(cfg),
    zig: zigSpec(cfg, cwd),
  };
}
