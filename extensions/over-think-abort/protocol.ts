/**
 * over-think-abort: parent↔child protocol.
 *
 * The llm-editor `edit` subagent (a `pi --print` child) is `-e`-loaded with
 * ../over-think-abort/index.ts. The parent (llm-editor/subagent.ts) computes a
 * thinking-token budget from the edited file's size — max(1000, file_bytes/8),
 * i.e. half the file's token estimate (file_bytes/4 ≈ tokens), floored at 1000
 * — and injects it via BUDGET_ENV. The child counts streamed `thinking_delta`
 * chars and, on breach, writes a cpi:over_think_<mode> sentinel (abort for the
 * streaming mid-flight path, warn for the post-hoc path); the streaming path
 * additionally calls ctx.abort(). The parent scans stderr for the sentinel to
 * surface a distinct error instead of a generic parse failure.
 *
 * Budget and counter share one token model (CHARS_PER_TOKEN). The budget is
 * expressed in tokens (BUDGET_ENV, sentinel); the hot path compares chars.
 */

/** Env var carrying the thinking-token budget; set only for the editor child. */
export const BUDGET_ENV = "CPI_OVER_THINK_BUDGET";

/** Chars per token — matches the budget's file_bytes/4 estimate. */
export const CHARS_PER_TOKEN = 4;

/** Sentinel modes: abort = streaming mid-flight (parent rejects), warn = post-hoc (parent applies + warns). */
export type OverThinkMode = "abort" | "warn";

/** Sentinel prefix; the full line is `cpi:over_think_<mode> budget=... thinking=...`. */
export const OVER_THINK_PREFIX = "cpi:over_think";

/** Render the sentinel line: `cpi:over_think_<mode> budget=<tokens> thinking=<tokens>`. */
export function overThinkLine(mode: OverThinkMode, budget: number, thinking: number): string {
  return `${OVER_THINK_PREFIX}_${mode} budget=${budget} thinking=${thinking}\n`;
}

const OVER_THINK_RE = /cpi:over_think_(abort|warn)\s+budget=(\d+)\s+thinking=(\d+)/g;

/** Parse the last over-think sentinel in stderr; undefined if absent. */
export function parseOverThink(stderr: string): { mode: OverThinkMode; budget: number; thinking: number } | undefined {
  let last: { mode: OverThinkMode; budget: number; thinking: number } | undefined;
  for (const m of stderr.matchAll(OVER_THINK_RE)) {
    last = { mode: m[1] as OverThinkMode, budget: parseInt(m[2], 10), thinking: parseInt(m[3], 10) };
  }
  return last;
}
