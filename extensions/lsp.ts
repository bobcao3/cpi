/**
 * `lsp` — sole owner of the LSP subsystem (design §7, §11, §14).
 *
 * Registers unconditionally at load (no globalThis dedup flag — AGENTS.md):
 *   • the `lsp` tool (list_sessions|list_supported_servers|start|stop|check),
 *   • a `session_shutdown` teardown → manager.disposeAll() (idempotent/reentrant).
* Producers (shell, the view/edit/create tools) are pure clients of
 * lib/lsp/manager.ts — they never register the tool. Single owner ⇒ the shared
 * plumbing is present iff cpi is present.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCwdPath } from "./lib/cwd.ts";
import {
  ensureSession,
  checkFile,
  stop,
  findSession,
  list,
  disposeAll,
} from "./lib/lsp/manager.ts";
import { awaitReady } from "./lib/lsp/session.ts";
import { loadAllLspSpecs } from "./lib/lsp/registry.ts";
import {
  languageByPath,
  discoverProjectRoot,
  LANGUAGE_MARKERS,
  LSP_LANGUAGES,
  type Language,
} from "./lib/lsp/discover.ts";
import { loadLspConfig } from "./lib/config.ts";
import { formatDiagnostics } from "./lib/lsp/diagnostics.ts";
import { loadText, render, renderLines, textPath, type ToolText } from "./lib/text.ts";

interface LspParams {
  command: "list_sessions" | "start" | "stop" | "check" | "list_supported_servers";
  project_dir?: string;
  file?: string;
  env?: string;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

class UserErr extends Error {}

/** Languages whose project markers are present in `root` (design §7.2). */
function languagesForRoot(root: string): Language[] {
  const out: Language[] = [];
  for (const lang of Object.keys(LANGUAGE_MARKERS) as Language[]) {
    if (LANGUAGE_MARKERS[lang].some((m) => existsSync(join(root, m)))) out.push(lang);
  }
  return out;
}

/** Resolve (language, root): file's language wins; root = project_dir when given. */
function resolveTarget(
  file: string | undefined,
  projectDir: string | undefined,
): { language: Language; root: string } {
  if (!file && !projectDir) throw new UserErr("provide `file` or `project_dir`.");
  if (file) {
    const abs = resolveCwdPath(file);
    const language = languageByPath(abs);
    if (!language) throw new UserErr(`unrecognized file extension: ${file}`);
    const root = projectDir ? resolveCwdPath(projectDir) : discoverProjectRoot(abs, language);
    return { language, root };
  }
  const root = resolveCwdPath(projectDir!);
  const langs = languagesForRoot(root);
  if (langs.length === 0) throw new UserErr(`no known language markers in ${root}; pass \`file=\`.`);
  if (langs.length > 1) {
    throw new UserErr(`multiple languages in ${root} (${langs.join(", ")}); pass \`file=\` to disambiguate.`);
  }
  return { language: langs[0], root };
}

function doList() {
  const sessions = list();
  if (sessions.length === 0) return textResult("No LSP sessions.");
  const header = "id\tlanguage\troot\tbin\tenv\tstate";
  const rows = sessions.map((s) =>
    `${s.id}\t${s.language}\t${s.projectRoot}\t${basename(s.bin)}\t${s.envPath ? "env" : "-"}\t${s.state}`,
  );
  return textResult([header, ...rows].join("\n"));
}

/** `lsp list_supported_servers`: enumerate every supported language, its
 *  extensions, server binary, and how it is provisioned. Dynamic — reflects the
 *  current LSP_LANGUAGES + config, so it stays correct as servers are added or
 *  provisioned differently across harness upgrades / user config. */
function doListSupportedServers() {
  const specs = loadAllLspSpecs();
  const lines = LSP_LANGUAGES.map((lang) => {
    const s = specs[lang];
    const exts = s.extensions.join(", ");
    const install = s.install.method === "env-only"
      ? "env-only (never auto-installed)"
      : s.install.method === "reuse"
        ? "reused (global)"
        : `${s.install.method}, auto-installed`;
    return `${lang} (${exts}): ${s.binName} — ${install}`;
  });
  return textResult(lines.join("\n"));
}

async function doStart(p: LspParams) {
  const { language, root } = resolveTarget(p.file, p.project_dir);
  const cfg = loadLspConfig();
  const session = await ensureSession(language, root, { envPath: p.env });
  if (session.state === "starting") await awaitReady(session, cfg.startupTimeoutMs);
  const envNote = p.env ? `\nenv=${p.env}` : "";
  if (session.state === "install-failed") {
    return errResult(
      `install failed for ${language} (root ${root}). Fix the toolchain or pass \`env=\` with the server on PATH, then re-run \`lsp start\`.${envNote}`,
    );
  }
  return textResult(
    `session ${session.id}\nlanguage=${language} root=${root} state=${session.state} bin=${session.bin} source=${session.source}${envNote}`,
  );
}

async function doStop(p: LspParams) {
  if (p.file) {
    const abs = resolveCwdPath(p.file);
    const lang = languageByPath(abs);
    if (!lang) return errResult(`unrecognized file: ${p.file}`);
    const root = discoverProjectRoot(abs, lang);
    const s = findSession(lang, root);
    if (!s) return textResult(`no session for ${lang} @ ${root}.`);
    await stop(s.id);
    return textResult(`stopped session ${s.id}.`);
  }
  if (!p.project_dir) return errResult("provide `file` or `project_dir`.");
  const root = resolveCwdPath(p.project_dir);
  const langs = languagesForRoot(root);
  let stopped = 0;
  for (const lang of langs) {
    const s = findSession(lang, root);
    if (s) {
      await stop(s.id);
      stopped++;
    }
  }
  return textResult(stopped ? `stopped ${stopped} session(s) for ${root}.` : `no sessions for ${root}.`);
}

async function doCheck(p: LspParams) {
  if (!p.file) return errResult("provide `file` (use `lsp start` to begin a session).");
  const abs = resolveCwdPath(p.file);
  const lang = languageByPath(abs);
  if (!lang) return errResult(`unrecognized file: ${p.file}`);
  const root = discoverProjectRoot(abs, lang);
  const session = findSession(lang, root);
  if (!session) {
    return errResult(`no LSP session for ${lang} @ ${root}; run \`lsp start file=${p.file}\` to begin one.`);
  }
  if (session.state === "install-failed") {
    return errResult(
      `install failed for ${lang} (root ${root}). Run \`lsp start file=${p.file} env=<dotenv>\` to provision with the right env.`,
    );
  }
  const diags = await checkFile(abs);
  return textResult(diags.length ? formatDiagnostics(diags) : `no diagnostics for ${p.file}`);
}

export default async function lspExtension(pi: ExtensionAPI): Promise<void> {
  const T = loadText<ToolText>("lsp", textPath("lsp"));
  const guidelines = renderLines(T.guidelines.bullets, {});
  pi.registerTool({
    name: "lsp",
    label: "lsp",
    description: render(T.tool.description, {}),
    promptSnippet: T.tool.prompt_snippet,
    promptGuidelines: guidelines,
    parameters: Type.Object({
      command: Type.Union([
        Type.Literal("list_sessions"),
        Type.Literal("list_supported_servers"),
        Type.Literal("start"),
        Type.Literal("stop"),
        Type.Literal("check"),
      ]),
      project_dir: Type.Optional(
        Type.String({ description: T.schema!.project_dir }),
      ),
      file: Type.Optional(
        Type.String({ description: T.schema!.file }),
      ),
      env: Type.Optional(
        Type.String({
          description: T.schema!.env,
        }),
      ),
    }),
    async execute(_toolCallId, params: LspParams, _signal, _onUpdate, _ctx) {
      try {
        switch (params.command) {
          case "list_sessions":
            return doList();
          case "list_supported_servers":
            return doListSupportedServers();
          case "start":
            return await doStart(params);
          case "stop":
            return await doStop(params);
          case "check":
            return await doCheck(params);
        }
      } catch (e) {
        return errResult(`lsp ${params.command}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return errResult(`lsp: unknown command ${params.command}`);
    },
  });


  pi.on("session_shutdown", async () => {
    try {
      await disposeAll();
    } catch {
      // disposeAll is idempotent/reentrant; never let it block shutdown.
    }
  });
}
