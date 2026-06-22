/**
 * Shared shell command analysis — the single orchestration point for `sh`
 * (and, later, `sh_repeat_until`).
 *
 * Given a command, the resolved shell profile, and tool availability, this runs
 * the dialect-specific Shuck lint, the tree-sitter parse, and the custom AST
 * command-policy rules, then returns the lint diagnostics, parsed AST/node,
 * rule results, and an explicit capability status. Callers consume the result
 * rather than re-orchestrating lint+parse+rules themselves.
 *
 * Policy:
 *   - Unsupported dialect (e.g. fish) fails closed: status "unsupported-dialect"
 *     with actionable info. Safety rules and linting are never silently skipped
 *     just because the dialect is unknown — the caller rejects before spawn.
 *   - A supported dialect whose tree-sitter parser is unavailable — or whose parse
 *     returns no usable AST (runtime init/parse failure) — degrades gracefully
 *     (status "parser-unavailable"): lint may still run, AST rules are skipped,
 *     exactly the established behavior for missing optional tooling. Status is
 *     derived from the actual parse result, not the availability switch alone.
 *
 * The bundled tree-sitter-bash grammar is used to parse sh/bash/zsh/mksh; it is
 * not claimed to be a native zsh/mksh parser. Shuck's dialect-specific lint path
 * is the authoritative dialect check; the custom AST rules
 * (shell/rules.ts, with wrapper resolution) are defense-in-depth.
 */

import { lintCommand, formatDiagnostics, type LintResult } from "./lint.ts";
import { parseCommand, type ParseResult } from "../lib/tree-sitter.ts";
import { checkRules, formatRuleMatches, type RuleCheckResult, type RuleContext } from "./rules.ts";
import type { ShellProfile } from "./profile.ts";
import type { ToolAvailability } from "./tools.ts";

export type AnalysisStatus = "ok" | "unsupported-dialect" | "parser-unavailable";

export interface UnsupportedDialectInfo {
  /** Absolute path of the resolved executable. */
  executable: string;
  /** Human-facing name (e.g. "fish", "bash (POSIX sh)"). */
  displayName: string;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  /** Set iff status === "unsupported-dialect"; null otherwise. */
  unsupported: UnsupportedDialectInfo | null;
  /** Shuck lint diagnostics (empty + available:false when not run). */
  lint: LintResult;
  /** tree-sitter parse (node null when not run/unavailable). */
  parse: ParseResult;
  /** Custom AST command-policy rule results. */
  rules: RuleCheckResult;
  /** Rejection lines (lint errors + rule rejections), "\n"-joined; "" if none. */
  errorText: string;
  /** Warning lines (lint warnings + rule warnings), "\n"-joined; "" if none. */
  warningText: string;
  /** Count of blocking errors (lint errors when lint ran + rule rejections). */
  errorCount: number;
}

export interface AnalyzeInput {
  command: string;
  shell: ShellProfile;
  availability: ToolAvailability;
  /** Shuck binary path (null when shuck unavailable → lint skipped). */
  shuckPath: string | null;
}

const SUPPORTED_DIALECTS = new Set(["sh", "bash", "zsh", "mksh"]);

const EMPTY_LINT: LintResult = { errors: [], warnings: [], available: false };
const EMPTY_PARSE: ParseResult = { ast: null, node: null, available: false };
const EMPTY_RULES: RuleCheckResult = { rejections: [], warnings: [] };

/** True iff the resolved shell dialect is one cpi can analyze. */
export function isSupportedDialect(shell: ShellProfile): boolean {
  return shell.dialect !== null && SUPPORTED_DIALECTS.has(shell.dialect);
}

/**
 * Analyze a shell command. Fail closed for unsupported dialects; degrade for a
 * supported dialect whose parser is unavailable. Never throws — parse/lint
 * failures are reflected in `available` flags, matching established behavior.
 */
export async function analyzeCommand(input: AnalyzeInput): Promise<AnalysisResult> {
  const { command, shell, availability, shuckPath } = input;

  if (!isSupportedDialect(shell)) {
    return {
      status: "unsupported-dialect",
      unsupported: { executable: shell.executable, displayName: shell.displayName },
      lint: EMPTY_LINT,
      parse: EMPTY_PARSE,
      rules: EMPTY_RULES,
      errorText: "",
      warningText: "",
      errorCount: 0,
    };
  }

  const [lint, parse] = await Promise.all([
    shuckPath
      ? lintCommand(command, shuckPath, shell)
      : Promise.resolve(EMPTY_LINT),
    availability.treeSitter ? parseCommand(command) : Promise.resolve(EMPTY_PARSE),
  ]);

  const ruleCtx: RuleContext = { fdAvailable: availability.fd, rgAvailable: availability.rg };
  const rules = parse.node ? checkRules(parse.node, ruleCtx) : EMPTY_RULES;

  const errorText = [fmt(lint.errors, formatDiagnostics), fmt(rules.rejections, formatRuleMatches)]
    .filter(Boolean)
    .join("\n");
  const warningText = [fmt(lint.warnings, formatDiagnostics), fmt(rules.warnings, formatRuleMatches)]
    .filter(Boolean)
    .join("\n");
  const errorCount = (lint.available ? lint.errors.length : 0) + rules.rejections.length;

  return {
    status: parse.available ? "ok" : "parser-unavailable",
    unsupported: null,
    lint,
    parse,
    rules,
    errorText,
    warningText,
    errorCount,
  };
}

const fmt = (diags: readonly any[], formatter: (d: any[]) => string): string =>
  diags.length ? formatter(diags as any[]) : "";

/**
 * Actionable fail-closed message for an unsupported dialect: identifies the
 * resolved shell and suggests setting an explicit supported executable.
 */
export function unsupportedDialectMessage(u: UnsupportedDialectInfo): string {
  return (
    `Blocked: shell ${JSON.stringify(u.displayName)} (${u.executable}) resolves to a dialect cpi ` +
    `cannot analyze. Command analysis (lint + safety rules) is never silently skipped, so the ` +
    `command was not executed. Supported dialects: sh, bash, zsh, mksh. Set "shell.executable" ` +
    `explicitly to a supported interpreter (e.g. "bash", "/bin/zsh", "sh") in your cpi config and retry.`
  );
}
