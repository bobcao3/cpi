/**
 * Post-run LSP check for files written by a shell command (design §8.4).
 *
 * Pure leaf mirroring `shell/cd-targets.ts` (detect→surface split): given the
 * `EditTarget[]` from `shell/edit-detect.ts`, for each edit whose language has a
 * READY LSP session, append formatted diagnostics; for the first edit whose
 * project has no session, emit a one-time "run `lsp start`" note. Diagnostics are
 * advisory — the command already ran, so this reports, never blocks.
 *
 * `shell.ts` invokes this only for COMPLETED, non-backgrounded runs.
 *
 * `globalThis.__cpiLspWarned` holds the shared mutable warned-roots Set (re-read
 * each call — pure data, NOT a boolean dedup flag, per the core-owner rules).
 */

import { detectEdits, type EditTarget } from "./edit-detect.ts";
import type { JsonNode as Node } from "../lib/tree-sitter.ts";
import { checkFile, findSession } from "../lib/lsp/manager.ts";
import { discoverProjectRoot, languageByPath } from "../lib/lsp/discover.ts";
import { formatDiagnostics } from "../lib/lsp/diagnostics.ts";

export interface LspHookResult {
  /** Aggregated formatted diagnostics across edits with a ready session. */
  appendedText?: string;
  /** One-time note for the first edit whose project has no LSP session. */
  warning?: string;
}

/** Shared mutable set of `${lang}:${root}` keys already warned about. */
function warnedSet(): Set<string> {
  const g = globalThis as unknown as { __cpiLspWarned?: Set<string> };
  if (!g.__cpiLspWarned) g.__cpiLspWarned = new Set<string>();
  return g.__cpiLspWarned;
}

/**
 * For each edit: if a READY LSP session covers its project, append formatted
 * diagnostics; otherwise note the missing session once (deduped per
 * `${lang}:${root}`). `appendedText` aggregates diagnostics across edits;
 * `warning` is the first un-warned no-session note. Never throws — a failing
 * edit is skipped, not the whole hook.
 */
export async function postRunLspCheck(edits: EditTarget[]): Promise<LspHookResult> {
  let appendedText: string | undefined;
  let warning: string | undefined;
  const warned = warnedSet();
  for (const t of edits) {
    try {
      const lang = languageByPath(t.path);
      if (!lang) continue;
      const root = discoverProjectRoot(t.path, lang);
      const sess = findSession(lang, root);
      if (sess && sess.state === "ready") {
        const diags = await checkFile(t.path);
        if (diags.length > 0) {
          const block = `${t.path}\n${formatDiagnostics(diags)}`;
          appendedText = appendedText === undefined ? block : `${appendedText}\n${block}`;
        }
      } else {
        const key = `${lang}:${root}`;
        if (!warned.has(key)) {
          warned.add(key);
          if (warning === undefined) {
            warning = `(no active LSP for ${t.path}; we suggest calling lsp tool \`lsp start file=${t.path}\` to enable auto-lint)`;
          }
        }
      }
    } catch {
      // skip this edit — never fail the whole hook
    }
  }
  const result: LspHookResult = {};
  if (appendedText !== undefined) result.appendedText = appendedText;
  if (warning !== undefined) result.warning = warning;
  return result;
}

/**
 * Orchestration entry for shell.ts: detect edits in `root`, run the post-run
 * LSP check, and return a single ready-to-append suffix — "" when there is
 * nothing to report, else "\n" + diagnostics (+ optional one-time no-session
 * note). Never throws. shell.ts calls this once after a completed (non-
 * backgrounded) run.
 */
export async function runLspHook(root: Node | null): Promise<string> {
  const hook = await postRunLspCheck(detectEdits(root));
  const parts: string[] = [];
  if (hook.appendedText !== undefined) parts.push(hook.appendedText);
  if (hook.warning !== undefined) parts.push(hook.warning);
  return parts.length === 0 ? "" : "\n" + parts.join("\n");
}
