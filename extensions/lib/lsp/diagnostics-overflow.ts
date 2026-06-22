/**
 * Diagnostics overflow orchestration — mirrors `shell/exec.ts buildOutputText`
 * over the pure `diagnostics.ts` renderer (design §13 explicit limit).
 *
 * Renders at most {@link DIAGNOSTICS_INLINE_CAP} diagnostics inline; when a
 * diagnostic set exceeds the cap, the full set is persisted to a file (the
 * session dir when a session is active, else the OS tmpdir) and the inline
 * body ends with a `…and N more — full: <path>` pointer — exactly the `sh`
 * tool's output-truncation `full: <logPath>` suffix applied to diagnostics.
 *
 * Pure-leaf callers (`lsp check`, the editor/shell LSP hooks) reach the
 * session dir via `lib/session-dir.ts` (no `ctx`, no pi import). The pure
 * renderer stays in `diagnostics.ts`; this module owns only the impure
 * persist + pointer step, so the truncation computation stays testable.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Diagnostic,
  formatDiagnostics,
} from "./diagnostics.ts";
import { getSessionDir } from "../session-dir.ts";

/** Inline cap (TigerStyle explicit limit, design §13). */
export const DIAGNOSTICS_INLINE_CAP = 3;

export interface RenderDiagnosticsOptions {
  /** Override the inline cap. Default {@link DIAGNOSTICS_INLINE_CAP}. */
  cap?: number;
  /**
   * Where to persist the overflow dump. Defaults to {@link getSessionDir}
   * (falling back to `os.tmpdir()` when no session is active). Tests may
   * inject a dir; production callers never pass this.
   */
  sessionDir?: string;
}

export interface RenderedDiagnostics {
  /** Inline body (capped), or "" for an empty list. */
  text: string;
  /** Path to the full dump, set only when the inline cap was exceeded. */
  fullPath?: string;
}

function assertCap(cap: unknown): asserts cap is number {
  if (!(Number.isInteger(cap) && (cap as number) > 0)) {
    throw new Error(`renderDiagnostics: cap must be a positive int, got ${String(cap)}`);
  }
}

/** Resolve the overflow file path under `dir` (session dir) or `tmpdir()`. */
function overflowPath(sessionDir: string | undefined): { path: string; makeDir: boolean } {
  const base = sessionDir ?? tmpdir();
  const name = `pi-lsp-diags-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
  if (sessionDir) return { path: join(base, "lsp-diagnostics", name), makeDir: true };
  return { path: join(base, name), makeDir: false };
}

/**
 * Render `diags` inline (capped); when the cap is exceeded, persist the full
 * set to a file and point to it — mirroring `sh`'s `full: <path>` overflow.
 * Returns `{ text: "" }` for an empty list. Never throws: a persist failure
 * degrades to the pure `formatDiagnostics` fallback (inline cap + `…and N
 * more` line) so an advisory LSP report never breaks an edit or a run.
 */
export async function renderDiagnostics(
  diags: Diagnostic[],
  opts: RenderDiagnosticsOptions = {},
): Promise<RenderedDiagnostics> {
  if (!Array.isArray(diags)) {
    throw new Error("renderDiagnostics: diags must be an array");
  }
  if (diags.length === 0) return { text: "" };
  const cap = opts.cap ?? DIAGNOSTICS_INLINE_CAP;
  assertCap(cap);
  if (diags.length <= cap) {
    return { text: formatDiagnostics(diags, { max: cap }) };
  }
  // Full dump: render every diagnostic (max == length ⇒ no "more" line).
  const full = formatDiagnostics(diags, { max: diags.length });
  const { path, makeDir } = overflowPath(opts.sessionDir ?? getSessionDir());
  try {
    if (makeDir) await mkdir(dirname(path), { recursive: true });
    await writeFile(path, full, "utf8");
  } catch {
    // Persist failed — degrade to the pure capped fallback (no file pointer).
    return { text: formatDiagnostics(diags, { max: cap }) };
  }
  const head = formatDiagnostics(diags.slice(0, cap), { max: cap });
  return { text: `${head}\n…and ${diags.length - cap} more — full: ${path}`, fullPath: path };
}
