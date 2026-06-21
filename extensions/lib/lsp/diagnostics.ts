/**
 * LSP diagnostic type + formatter (pure node).
 *
 * Canonical diagnostic shape for the LSP subsystem: `tsserver`, `pyrefly`, and
 * `shuck` diagnostics all normalize into {@link Diagnostic}. `formatDiagnostics`
 * renders the `Lr:c severity[source] msg  (file)` line form (design §6.5).
 *
 * `shell/lint.ts` keeps its own `ShuckDiagnostic` + `formatDiagnostics` until
 * Layer 4 rewrites it as a thin client over the manager; this module is the
 * target type the manager/editor path renders. Pure node — no pi import.
 */

export type DiagnosticSeverity = "error" | "warning" | "hint" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Tool-specific code, e.g. "TS2304" / "null-overlap". Omitted when absent. */
  code?: string;
  message: string;
  /** Origin server: "tsserver" | "pyrefly" | "shuck". */
  source: string;
  /** Absolute path; "" for synthetic inline docs (/tmp lintText). */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface FormatDiagnosticsOptions {
  /** Render cap (TigerStyle explicit limit, design §13). Default 200. */
  max?: number;
}

/** Explicit limit on rendered diagnostics (design §13). */
export const DIAGNOSTICS_FORMAT_MAX = 200;

const SEVERITIES: ReadonlySet<DiagnosticSeverity> = new Set(["error", "warning", "hint", "info"]);

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

/**
 * Render diagnostics as one line each (design §6.5):
 *   `L<line>:<col> <severity>[<source>] <message>  (<file>)`
 * The `(<file>)` suffix is omitted when `file` is "" (synthetic inline docs).
 * Capped at `opts.max` (default 200); a trailing `…and N more` line notes any
 * overflow so a silent drop never happens. Returns "" for an empty list.
 */
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
  if (diags.length > max) lines.push(`…and ${diags.length - max} more (capped at ${max})`);
  return lines.join("\n");
}
