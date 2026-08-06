export type DiagnosticSeverity = "error" | "warning" | "hint" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code?: string;
  message: string;
  source: string;
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface FormatDiagnosticsOptions {
  max?: number;
}

export const DIAGNOSTICS_FORMAT_MAX = 200;

const SEVERITIES: ReadonlySet<DiagnosticSeverity> = new Set([
  "error",
  "warning",
  "hint",
  "info",
]);

function assertDiag(d: Diagnostic, i: number): void {
  if (
    d === null ||
    typeof d !== "object" ||
    !SEVERITIES.has(d.severity) ||
    typeof d.message !== "string" ||
    typeof d.source !== "string" ||
    d.source.length === 0 ||
    typeof d.file !== "string" ||
    !Number.isInteger(d.startLine) ||
    d.startLine < 1 ||
    !Number.isInteger(d.startCol) ||
    d.startCol < 1 ||
    !Number.isInteger(d.endLine) ||
    d.endLine < 1 ||
    !Number.isInteger(d.endCol) ||
    d.endCol < 1
  ) {
    throw new Error(`formatDiagnostics: invalid diagnostic at index ${i}`);
  }
}

/** Output is capped at `opts.max`; overflow is marked. */
export function formatDiagnostics(
  diags: Diagnostic[],
  opts: FormatDiagnosticsOptions = {},
): string {
  if (!Array.isArray(diags)) {
    throw new Error("formatDiagnostics: diags must be an array");
  }
  if (diags.length === 0) return "";
  const max =
    Number.isInteger(opts.max) && (opts.max as number) > 0
      ? (opts.max as number)
      : DIAGNOSTICS_FORMAT_MAX;
  const n = Math.min(diags.length, max);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = diags[i];
    assertDiag(d, i);
    let line = `L${d.startLine}:${d.startCol} ${d.severity}[${d.source}] ${d.message}`;
    if (d.file) line += `  (${d.file})`;
    lines.push(line);
  }
  if (diags.length > max)
    lines.push(`…and ${diags.length - max} more (capped at ${max})`);
  return lines.join("\n");
}
