/**
 * Shell command linting — thin client over the LSP manager (design §8.3).
 *
 * `lintCommand` delegates to `LspManager.lintText("shell", cmd, { extension })`,
 * with the extension selected from the resolved shell dialect; the manager owns
 * the single shuck session (rootUri=null, synthetic /tmp doc). Shapes
 * `ShuckDiagnostic` / `formatDiagnostics` / `disposeLspClient` are preserved
 * (the latter is now a no-op — the `lsp` owner disposes all sessions) so
 * `shell.ts` / `repeat.ts` stay structurally stable. Semantics preserved:
 * same blocking-on-error, same warning surfacing, same shapes.
 */
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

/** No-op: the `lsp` owner disposes all sessions on session_shutdown (design §14). */
export function disposeLspClient(): void {}

export function formatDiagnostics(d: ShuckDiagnostic[]): string {
  return d
    .map((x) => `  L${x.location.row}:${x.location.column} ${x.severity}[${x.code}] ${x.message}`)
    .join("\n");
}

/**
 * Shuck codes that are structurally unactionable on the inline-analysis path.
 * The inline shuck session runs on a synthetic /tmp document with rootUri=null
 * and `server --isolated`, so it can never resolve relative `source` targets.
 * Consequently shuck's C003 ("sourced file is not available to this analysis",
 * the SC1091 analogue) is always a false positive here — verified: shuck 0.0.41
 * has no external-sources/-x mode, the `source=` directive only honors /dev/null,
 * and no `[lint]` key enables source following. Filter both the native and
 * shellcheck-style codes so they never surface as errors/warnings.
 */
const INLINE_UNACTIONABLE_CODES: Set<string> = new Set(["C003", "SC1091"]);

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
 * itself (env-PATH-first reuse, design §6.2). The synthetic URI extension
 * carries the shell dialect to the LSP server. The optional profile preserves
 * compatibility with the old two-argument call.
 */
export async function lintCommand(
  command: string,
  _shuckPath: string,
  shell: ShellProfile = resolveShell("bash"),
): Promise<LintResult> {
  if (!shell.dialect) {
    return { errors: [], warnings: [], available: false };
  }
  const diags = (await getLspManager().lintText("shell", command, { extension: shell.dialect }))
    .filter((d) => !INLINE_UNACTIONABLE_CODES.has(d.code ?? ""));
  const shuck = diags.map(toShuck);
  return {
    errors: shuck.filter((d) => d.severity === "error"),
    warnings: shuck.filter((d) => d.severity === "warning"),
    available: true,
  };
}