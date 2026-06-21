/**
 * Shell command linting — thin client over the LSP manager (design §8.3).
 *
 * `lintCommand` delegates to `LspManager.lintText("shell", cmd)`; the manager
 * owns the single shuck session (rootUri=null, synthetic /tmp doc). Shapes
 * `ShuckDiagnostic` / `formatDiagnostics` / `disposeLspClient` are preserved
 * (the latter is now a no-op — the `lsp` owner disposes all sessions) so
 * `shell.ts` / `repeat.ts` stay structurally stable. Semantics preserved:
 * same blocking-on-error, same warning surfacing, same shapes.
 */
import { getLspManager } from "../lib/lsp/manager.ts";
import { type Diagnostic } from "../lib/lsp/diagnostics.ts";

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

/** No-op: the `lsp` owner disposes all sessions on session_shutdown (design §14). */
export function disposeLspClient(): void {}

export function formatDiagnostics(d: ShuckDiagnostic[]): string {
  return d
    .map((x) => `  L${x.location.row}:${x.location.column} ${x.severity}[${x.code}] ${x.message}`)
    .join("\n");
}

function toShuck(d: Diagnostic): ShuckDiagnostic {
  const sev: ShuckDiagnostic["severity"] =
    d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "hint";
  return {
    code: d.code ?? "",
    severity: sev,
    message: d.message,
    location: { row: d.startLine, column: d.startCol },
    end_location: { row: d.endLine, column: d.endCol },
    filename: d.file,
  };
}

/**
 * Lint a shell command via the LSP manager's shuck session. `shuckPath` is
 * accepted for signature stability but ignored — the manager resolves shuck
 * itself (env-PATH-first reuse, design §6.2). `available` is always true:
 * errors only exist when the session is ready (lintText returns [] otherwise),
 * so the `lint.available ? errors.length : 0` blocking count is unchanged.
 */
export async function lintCommand(command: string, _shuckPath: string): Promise<LintResult> {
  const diags = await getLspManager().lintText("shell", command);
  const shuck = diags.map(toShuck);
  return {
    errors: shuck.filter((d) => d.severity === "error"),
    warnings: shuck.filter((d) => d.severity === "warning"),
    available: true,
  };
}