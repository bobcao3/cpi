/**
 * Advisory only — the command already ran, so this reports, never blocks.
 * `__cpiLspWarned` is shared mutable data (not a dedup flag), re-read per call.
 */

import { detectEdits, type EditTarget } from "./edit-detect.ts";
import type { JsonNode as Node } from "../lib/tree-sitter.ts";
import { checkFile, findSession } from "../lib/lsp/manager.ts";
import { discoverProjectRoot, languageByPath } from "../lib/lsp/discover.ts";
import { renderDiagnostics } from "../lib/lsp/diagnostics-overflow.ts";

export interface LspHookResult {
  appendedText?: string;
  warning?: string;
}

function warnedSet(): Set<string> {
  const g = globalThis as unknown as { __cpiLspWarned?: Set<string> };
  if (!g.__cpiLspWarned) g.__cpiLspWarned = new Set<string>();
  return g.__cpiLspWarned;
}

export async function postRunLspCheck(
  edits: EditTarget[],
): Promise<LspHookResult> {
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
          const rendered = await renderDiagnostics(diags);
          const block = `${t.path}\n${rendered.text}`;
          appendedText =
            appendedText === undefined ? block : `${appendedText}\n${block}`;
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
    } catch {}
  }
  const result: LspHookResult = {};
  if (appendedText !== undefined) result.appendedText = appendedText;
  if (warning !== undefined) result.warning = warning;
  return result;
}

export async function runLspHook(root: Node | null): Promise<string> {
  const hook = await postRunLspCheck(detectEdits(root));
  const parts: string[] = [];
  if (hook.appendedText !== undefined) parts.push(hook.appendedText);
  if (hook.warning !== undefined) parts.push(hook.warning);
  return parts.length === 0 ? "" : "\n" + parts.join("\n");
}
