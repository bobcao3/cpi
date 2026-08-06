/** LSP fields for llm_editor create/edit results: embed project diagnostics inline so the model sees them; advisory only. */

import { ensureSession, checkFile } from "../lib/lsp/manager.ts";
import { awaitReady } from "../lib/lsp/session.ts";
import { discoverProjectRoot, languageByPath } from "../lib/lsp/discover.ts";
import { renderDiagnostics } from "../lib/lsp/diagnostics-overflow.ts";
import { loadLspConfig } from "../lib/config.ts";
import { loadEditorText, fmt } from "./text.ts";
import { field } from "./result-xml.ts";

/** Never throws: any failure degrades to "" — the edit already succeeded. Runs under the writer's per-path lock, so checkFile reads the just-written content. `abs` must be absolute. */
export async function lspFields(abs: string): Promise<string> {
  try {
    const lang = languageByPath(abs);
    if (!lang) return "";
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
    const rendered = await renderDiagnostics(diags);
    return [
      field("lsp", "started", {
        project: root,
        bin: session.bin,
        state: session.state,
      }),
      field("diagnostics", rendered.text || T.lsp.diagnostics_none),
      `  <!-- ${fmt(T.lsp.restart_hint, { root, path: abs })} -->`,
    ].join("\n");
  } catch {
    return "";
  }
}
