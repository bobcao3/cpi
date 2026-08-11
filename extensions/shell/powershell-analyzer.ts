import { spawn } from "node:child_process";
import { loadText, textPath } from "../lib/text.ts";
import type { LintResult, ShuckDiagnostic } from "./lint.ts";
import type { ShellProfile } from "./profile.ts";

const LIMIT_COMMANDS = 128;
const LIMIT_ELEMENTS = 64;
const LIMIT_INPUT_BYTES = 1024 * 1024;
const LIMIT_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const PARSER_SCRIPT = `
$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | Select-Object -First ${LIMIT_COMMANDS} | ForEach-Object {
  [pscustomobject]@{
    name = $_.GetCommandName()
    elements = @($_.CommandElements | Select-Object -First ${LIMIT_ELEMENTS} | ForEach-Object { $_.Extent.Text })
    startLine = $_.Extent.StartLineNumber
    startColumn = $_.Extent.StartColumnNumber
    endLine = $_.Extent.EndLineNumber
    endColumn = $_.Extent.EndColumnNumber
  }
})
$result = [pscustomobject]@{
  errors = @($errors | Select-Object -First ${LIMIT_COMMANDS} | ForEach-Object {
    [pscustomobject]@{
      message = $_.Message
      startLine = $_.Extent.StartLineNumber
      startColumn = $_.Extent.StartColumnNumber
      endLine = $_.Extent.EndLineNumber
      endColumn = $_.Extent.EndColumnNumber
    }
  })
  commands = $commands
}
$result | ConvertTo-Json -Compress -Depth 5
`;

interface AnalyzerText {
  errors: Record<string, string>;
  warnings: Record<string, string>;
}
interface Fact {
  name?: unknown;
  elements?: unknown;
  startLine?: unknown;
  startColumn?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
  message?: unknown;
}
interface AnalysisPayload {
  errors?: unknown;
  commands?: unknown;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function diagnostic(
  fact: Fact,
  code: string,
  severity: "error" | "warning",
  message: string,
): ShuckDiagnostic {
  const row = positive(fact.startLine, 1);
  const column = positive(fact.startColumn, 1);
  return {
    code,
    severity,
    message,
    location: { row, column },
    end_location: {
      row: positive(fact.endLine, row),
      column: positive(fact.endColumn, column),
    },
    filename: "<command>",
  };
}

function hostFailure(message: string, code = "PSHost"): LintResult {
  return {
    errors: [diagnostic({}, code, "error", message)],
    warnings: [],
    available: true,
  };
}

function elementsOf(fact: Fact): string[] {
  if (!Array.isArray(fact.elements)) return [];
  return fact.elements
    .slice(0, LIMIT_ELEMENTS)
    .filter((value): value is string => typeof value === "string");
}

function bare(value: string): string {
  return value.replace(/^['"]|['"]$/g, "").toLowerCase();
}

function hasAny(values: string[], choices: Set<string>): boolean {
  for (const value of values) if (choices.has(bare(value))) return true;
  return false;
}

function isRoot(value: string): boolean {
  const text = bare(value).replace(/\//g, "\\");
  return /^[a-z]:\\?$/.test(text) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(text);
}

function ruleDiagnostics(
  facts: Fact[],
  availability: { fd: boolean; rg: boolean },
  text: AnalyzerText,
): { errors: ShuckDiagnostic[]; warnings: ShuckDiagnostic[] } {
  const errors: ShuckDiagnostic[] = [];
  const warnings: ShuckDiagnostic[] = [];
  const disks = new Set([
    "clear-disk",
    "format-volume",
    "initialize-disk",
    "remove-partition",
  ]);
  for (const fact of facts.slice(0, LIMIT_COMMANDS)) {
    const name = typeof fact.name === "string" ? fact.name.toLowerCase() : "";
    const elements = elementsOf(fact);
    const args = elements.slice(1);
    if (!name)
      errors.push(diagnostic(fact, "PSDynamic", "error", text.errors.dynamic));
    if (disks.has(name))
      errors.push(diagnostic(fact, "PSDisk", "error", text.errors.disk));
    if (name === "invoke-expression" || name === "iex") {
      errors.push(
        diagnostic(
          fact,
          "PSInvokeExpression",
          "error",
          text.errors.invoke_expression,
        ),
      );
    }
    const removeFlags = new Set(args.map(bare));
    if (
      (name === "remove-item" || name === "ri" || name === "del") &&
      removeFlags.has("-recurse") &&
      removeFlags.has("-force") &&
      args.some(isRoot)
    ) {
      errors.push(
        diagnostic(fact, "PSRootRemove", "error", text.errors.root_remove),
      );
    }
    const nested =
      ((name === "cmd" || name === "cmd.exe") &&
        hasAny(args, new Set(["/c", "/k"]))) ||
      (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name) &&
        hasAny(args, new Set(["-command", "-c", "-encodedcommand", "-enc"])));
    if (nested)
      errors.push(
        diagnostic(fact, "PSNestedShell", "error", text.errors.nested_shell),
      );
    if (availability.fd && (name === "get-childitem" || name === "gci")) {
      warnings.push(
        diagnostic(fact, "PSPreferFd", "warning", text.warnings.fd),
      );
    }
    if (availability.rg && (name === "select-string" || name === "sls")) {
      warnings.push(
        diagnostic(fact, "PSPreferRg", "warning", text.warnings.rg),
      );
    }
  }
  return { errors, warnings };
}

function parsePayload(
  output: string,
  availability: { fd: boolean; rg: boolean },
  text: AnalyzerText,
): LintResult {
  let payload: AnalysisPayload;
  try {
    payload = JSON.parse(output) as AnalysisPayload;
  } catch {
    return hostFailure(text.errors.host);
  }
  if (!Array.isArray(payload.errors) || !Array.isArray(payload.commands)) {
    return hostFailure(text.errors.host);
  }
  const parseErrors = payload.errors.slice(0, LIMIT_COMMANDS).map((value) => {
    const fact = value && typeof value === "object" ? (value as Fact) : {};
    const message =
      typeof fact.message === "string" ? fact.message : text.errors.host;
    return diagnostic(fact, "PSParse", "error", message);
  });
  const facts = payload.commands
    .slice(0, LIMIT_COMMANDS)
    .filter((value): value is Fact => !!value && typeof value === "object");
  const rules = ruleDiagnostics(facts, availability, text);
  return {
    errors: [...parseErrors, ...rules.errors],
    warnings: rules.warnings,
    available: true,
  };
}

export async function lintPowerShell(
  command: string,
  shell: ShellProfile,
  availability: { fd: boolean; rg: boolean },
): Promise<LintResult> {
  const text = loadText<AnalyzerText>("powershell", textPath("powershell"));
  if (Buffer.byteLength(command) > LIMIT_INPUT_BYTES)
    return hostFailure(text.errors.input, "PSInput");
  return new Promise((resolve) => {
    const child = spawn(
      shell.executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PARSER_SCRIPT],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    let settled = false;
    const finish = (result: LintResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (chunk: Buffer): void => {
      if (settled) return;
      if (Buffer.byteLength(output) + chunk.length > LIMIT_OUTPUT_BYTES) {
        child.kill();
        finish(hostFailure(text.errors.overflow, "PSOverflow"));
        return;
      }
      output += chunk.toString("utf8");
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(hostFailure(text.errors.timeout, "PSTimeout"));
    }, TIMEOUT_MS);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", () => finish(hostFailure(text.errors.host)));
    child.on("close", (code) => {
      if (settled) return;
      finish(
        code === 0
          ? parsePayload(output.trim(), availability, text)
          : hostFailure(text.errors.host),
      );
    });
    child.stdin?.end(command);
  });
}
