/**
 * LSP fields for llm_editor create/edit results (design §9).
 *
 * After a successful write, embed `<lsp project bin state>started</lsp>` +
 * `<diagnostics>` (or an `install-failed` hint when the server couldn't
 * provision) in the result XML so the model sees the project's diagnostics
 * inline. Always non-blocking: provisioning failure or any error degrades to
 * "" — the edit already succeeded, LSP is advisory. `view` is excluded (no
 * write → no caller). Invoked under the writer's per-path lock (lock.ts) so
 * `checkFile` reads the just-written content with no concurrent-write race.
 *
 * Pure leaf: lib/lsp/* + result-xml + text only (no pi/tui imports).
 */

import { ensureSession, checkFile } from "../lib/lsp/manager.ts";
import { awaitReady } from "../lib/lsp/session.ts";
import { discoverProjectRoot, languageByPath } from "../lib/lsp/discover.ts";
import { formatDiagnostics } from "../lib/lsp/diagnostics.ts";
import { loadLspConfig } from "../lib/config.ts";
import { loadEditorText, fmt } from "./text.ts";
import { field } from "./result-xml.ts";

/**
 * `<lsp>` + `<diagnostics>` XML for a freshly-written file, or "" to skip
 * (unsupported language, install-failed-skip is NOT used — install-failed is
 * reported as a hint — and any error). Never throws: the edit already
 * succeeded. Bounded by config: install (60s) + startup handshake (30s) +
 * lint (10s). `abs` must be absolute (callers resolve it before writing).
 */
export async function lspFields(abs: string): Promise<string> {
  try {
    const lang = languageByPath(abs);
    if (!lang) return ""; // unsupported extension (.md, .json, …) → skip silently
    const root = discoverProjectRoot(abs, lang);
    const T = loadEditorText();
    const session = await ensureSession(lang, root);
    if (session.state === "starting") {
      await awaitReady(session, loadLspConfig().startupTimeoutMs);
    }
    if (session.state === "install-failed") {
      return field("lsp", fmt(T.lsp.install_failed, { path: abs }), {
        project: root,
        state: "install-failed",
      });
    }
    const diags = await checkFile(abs);
    return [
      field("lsp", "started", { project: root, bin: session.bin, state: session.state }),
      field("diagnostics", formatDiagnostics(diags) || T.lsp.diagnostics_none),
      `  <!-- ${fmt(T.lsp.restart_hint, { root, path: abs })} -->`,
    ].join("\n");
  } catch {
    return ""; // never fail the edit — LSP is advisory
  }
}
