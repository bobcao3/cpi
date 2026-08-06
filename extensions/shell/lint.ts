import { getLspManager } from "../lib/lsp/manager.ts";
import { type Diagnostic } from "../lib/lsp/diagnostics.ts";
import { resolveShell, type ShellProfile } from "./profile.ts";

export interface ShuckDiagnostic {
  code: string;
  severity: "error" | "warning" | "hint";
  message: string;
  location: { row: number; column: number };
  end_location: { row: number; column: number };
  filename: string;
}
export interface LintResult {
  errors: ShuckDiagnostic[];
  warnings: ShuckDiagnostic[];
  available: boolean;
}

export function disposeLspClient(): void {}

export function formatDiagnostics(d: ShuckDiagnostic[]): string {
  return d
    .map(
      (x) =>
        `  L${x.location.row}:${x.location.column} ${x.severity}[${x.code}] ${x.message}`,
    )
    .join("\n");
}

const INLINE_UNACTIONABLE_CODES: Set<string> = new Set(["C003", "SC1091"]);

function toShuck(d: Diagnostic): ShuckDiagnostic {
  const sev: ShuckDiagnostic["severity"] =
    d.severity === "error"
      ? "error"
      : d.severity === "warning"
        ? "warning"
        : "hint";
  return {
    code: d.code ?? "",
    severity: sev,
    message: d.message,
    location: { row: d.startLine, column: d.startCol },
    end_location: { row: d.endLine, column: d.endCol },
    filename: d.file,
  };
}

export async function lintCommand(
  command: string,
  _shuckPath: string,
  shell: ShellProfile = resolveShell("bash"),
): Promise<LintResult> {
  if (!shell.dialect) {
    return { errors: [], warnings: [], available: false };
  }
  const diags = (
    await getLspManager().lintText("shell", command, {
      extension: shell.dialect,
    })
  ).filter((d) => !INLINE_UNACTIONABLE_CODES.has(d.code ?? ""));
  const shuck = diags.map(toShuck);
  return {
    errors: shuck.filter((d) => d.severity === "error"),
    warnings: shuck.filter((d) => d.severity === "warning"),
    available: true,
  };
}
