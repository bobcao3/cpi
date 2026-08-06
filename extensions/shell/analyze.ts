/**
 * Orchestrates shell command analysis: dialect lint + tree-sitter parse +
 * custom AST rules. Unsupported dialects fail closed; a supported dialect
 * with an unavailable parser degrades (parser-unavailable). Shuck's dialect
 * lint is authoritative — the bundled tree-sitter grammar is defense-in-depth.
 */

import { lintCommand, formatDiagnostics, type LintResult } from "./lint.ts";
import { parseCommand, type ParseResult } from "../lib/tree-sitter.ts";
import {
  checkRules,
  formatRuleMatches,
  type RuleCheckResult,
  type RuleContext,
} from "./rules.ts";
import type { ShellProfile } from "./profile.ts";
import type { ToolAvailability } from "./tools.ts";

export type AnalysisStatus =
  | "ok"
  | "unsupported-dialect"
  | "parser-unavailable";

export interface UnsupportedDialectInfo {
  executable: string;
  displayName: string;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  /** Set iff status === "unsupported-dialect"; null otherwise. */
  unsupported: UnsupportedDialectInfo | null;
  lint: LintResult;
  parse: ParseResult;
  rules: RuleCheckResult;
  errorText: string;
  warningText: string;
  /** Count of blocking errors (lint errors when lint ran + rule rejections). */
  errorCount: number;
}

export interface AnalyzeInput {
  command: string;
  shell: ShellProfile;
  availability: ToolAvailability;
  shuckPath: string | null;
}

const SUPPORTED_DIALECTS = new Set(["sh", "bash", "zsh", "mksh"]);

const EMPTY_LINT: LintResult = { errors: [], warnings: [], available: false };
const EMPTY_PARSE: ParseResult = { ast: null, node: null, available: false };
const EMPTY_RULES: RuleCheckResult = { rejections: [], warnings: [] };

export function isSupportedDialect(shell: ShellProfile): boolean {
  return shell.dialect !== null && SUPPORTED_DIALECTS.has(shell.dialect);
}

/** Never throws — parse/lint failures surface in the `available` flags. */
export async function analyzeCommand(
  input: AnalyzeInput,
): Promise<AnalysisResult> {
  const { command, shell, availability, shuckPath } = input;

  if (!isSupportedDialect(shell)) {
    return {
      status: "unsupported-dialect",
      unsupported: {
        executable: shell.executable,
        displayName: shell.displayName,
      },
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
    availability.treeSitter
      ? parseCommand(command)
      : Promise.resolve(EMPTY_PARSE),
  ]);

  const ruleCtx: RuleContext = {
    fdAvailable: availability.fd,
    rgAvailable: availability.rg,
  };
  const rules = parse.node ? checkRules(parse.node, ruleCtx) : EMPTY_RULES;

  const errorText = [
    fmt(lint.errors, formatDiagnostics),
    fmt(rules.rejections, formatRuleMatches),
  ]
    .filter(Boolean)
    .join("\n");
  const warningText = [
    fmt(lint.warnings, formatDiagnostics),
    fmt(rules.warnings, formatRuleMatches),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  const errorCount =
    (lint.available ? lint.errors.length : 0) + rules.rejections.length;

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

export function unsupportedDialectMessage(u: UnsupportedDialectInfo): string {
  return (
    `Blocked: shell ${JSON.stringify(u.displayName)} (${u.executable}) resolves to a dialect cpi ` +
    `cannot analyze. Command analysis (lint + safety rules) is never silently skipped, so the ` +
    `command was not executed. Supported dialects: sh, bash, zsh, mksh. Set "shell.executable" ` +
    `explicitly to a supported interpreter (e.g. "bash", "/bin/zsh", "sh") in your cpi config and retry.`
  );
}
