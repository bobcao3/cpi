/**
 * The `llm_editor` tool definition (cpi's replacement for the disabled built-in
 * read/write/edit). One tool, three commands, AI-mediated via tool-less `pi`
 * subagents — SWE-Edit's decomposition (arXiv:2604.26102):
 *   view    directory → deterministic 2-level listing (no subagent)
 *           file      → Viewer subagent returns only relevant line ranges
 *           file (no query) → plain numbered head read (no subagent)
 *   create  → write a new file (fails if it exists); no subagent
 *   edit    → Editor subagent emits SEARCH/REPLACE blocks; tool applies + writes
 *
 * File I/O lives in the tool (Node fs); subagents only reason. Registered as the
 * sole owner by index.ts. All prose (description, guidelines, schema desc,
 * messages, errors) lives in text.toml; this module holds logic + glyphs only.
 */

import { Type } from "typebox";
import { readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadEditorConfig } from "../lib/config.ts";
import { resolveTranscriptDir } from "./log.ts";
import { resolveEditorModel } from "./model-select.ts";
import { loadEditorText, fmt } from "./text.ts";
import { viewFile } from "./viewer.ts";
import { editFile } from "./editor.ts";
import { withPathLock } from "./cas.ts";
import { shortSha } from "./id.ts";
import { resultXml, field } from "./result-xml.ts";
import { lspFields } from "./lsp.ts";
import { renderLlmEditorCall, renderLlmEditorResult } from "./render.ts";

export const LLM_EDITOR_TOOL = "llm_editor";

// Tool metadata + schema descriptions are registered once at load, so they
// read text.toml for the startup cwd. Per-call messages/errors re-read per-cwd.
const T0 = loadEditorText();

const schema = Type.Object({
  command: Type.Union([Type.Literal("view"), Type.Literal("create"), Type.Literal("edit")], {
    description: T0.schema.command,
  }),
  path: Type.String({ description: T0.schema.path }),
  query: Type.Optional(Type.String({ description: T0.schema.query })),
  instruction: Type.Optional(Type.String({ description: T0.schema.instruction })),
  file_text: Type.Optional(Type.String({ description: T0.schema.file_text })),
});

type Params = {
  command: "view" | "create" | "edit";
  path: string;
  query?: string;
  instruction?: string;
  file_text?: string;
};

function okResult(
  id: string,
  command: Params["command"],
  path: string,
  body: string[],
  details?: unknown,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: resultXml([field("id", id), field("command", command), field("path", path), ...body]),
      },
    ],
    details,
  };
}
function errorResult(id: string, command: Params["command"], path: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: resultXml([
          field("id", id),
          field("command", command),
          field("path", path),
          field("error", message),
        ]),
      },
    ],
    isError: true,
    details: { id, kind: "error", message },
  };
}

/** Deterministic non-hidden listing up to 2 levels deep. Bounded recursion. */
async function listTree(root: string, cwd: string): Promise<string> {
  const T = loadEditorText(cwd);
  const lines: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = relative(cwd, join(dir, e.name)) || e.name;
      lines.push(
        `${"  ".repeat(depth - 1)}${e.isDirectory() ? "📁" : "📄"} ${rel}${e.isDirectory() ? "/" : ""}`,
      );
      if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 1);
  return lines.length ? lines.join("\n") : T.messages.empty_dir;
}

/** Plain numbered head read — cheap fallback when no Viewer query is given. */
async function headRead(abs: string, cwd: string, max = 200): Promise<string> {
  const T = loadEditorText(cwd);
  const content = await readFile(abs, "utf-8");
  const all = content.split("\n");
  const lines = all.slice(0, max);
  const body = lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
  return all.length > max ? `${body}\n${fmt(T.messages.head_more, { n: all.length - max })}` : body;
}

export async function execute(
  _toolCallId: string,
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate?: (partial: { content: unknown[]; details?: unknown }) => void,
  ctx: ExtensionContext,
) {
  const T = loadEditorText(ctx.cwd);
  const id = shortSha(params);
  const abs = resolve(ctx.cwd, params.path);
  const cfg = loadEditorConfig(ctx.cwd);
  if (signal?.aborted) return errorResult(id, params.command, abs, T.errors.aborted);

  if (params.command === "view") {
    let isDir = false;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch {
      return errorResult(id, params.command, abs, fmt(T.errors.not_found, { path: abs }));
    }
    if (isDir) {
      const tree = await listTree(abs, ctx.cwd);
      return okResult(id, params.command, abs, [field("tree", tree)], {
        id,
        kind: "tree",
        text: tree,
      });
    }
    if (!params.query) {
      try {
        const content = await headRead(abs, ctx.cwd);
        return okResult(id, params.command, abs, [field("content", content)], {
          id,
          kind: "content",
          text: content,
        });
      } catch (e) {
        return errorResult(
          id,
          params.command,
          abs,
          fmt(T.errors.cannot_read, { path: abs, reason: (e as Error).message }),
        );
      }
    }
    onUpdate?.({ content: [], details: { id } });
    const pick = resolveEditorModel(ctx);
    const r = await viewFile(params.path, {
      id,
      onStream: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { id } }),
      query: params.query,
      provider: pick.provider,
      modelId: pick.modelId,
      cwd: ctx.cwd,
      signal,
      timeoutMs: cfg.subagentTimeoutMs,
      transcriptDir: resolveTranscriptDir(cfg.transcriptDir, ctx.cwd),
      maxTranscripts: cfg.maxTranscripts,
      maxFileBytes: cfg.maxFileBytes,
    });
    if (r.error) return errorResult(id, params.command, abs, r.error);
    return okResult(id, params.command, abs, [field("content", r.text)], {
      id,
      kind: "view",
      text: r.text,
      usage: r.usage,
    });
  }

  if (params.command === "create") {
    if (params.file_text === undefined)
      return errorResult(id, params.command, abs, T.errors.create_requires_text);
    const fileText = params.file_text;
    return withPathLock(abs, async () => {
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, fileText, { flag: "wx" });
      } catch (e) {
        const code = (e as Error & { code?: string }).code;
        if (code === "EEXIST")
          return errorResult(id, params.command, abs, fmt(T.errors.file_exists, { path: abs }));
        return errorResult(
          id,
          params.command,
          abs,
          fmt(T.errors.create_failed, { reason: (e as Error).message }),
        );
      }
      const body = [field("created", undefined, { bytes: Buffer.byteLength(fileText, "utf-8") })];
      const lsp = await lspFields(abs);
      if (lsp) body.push(lsp);
      return okResult(id, params.command, abs, body, {
        id,
        kind: "create",
        bytes: Buffer.byteLength(fileText, "utf-8"),
      });
    });
  }

  // edit
  if (!params.instruction)
    return errorResult(id, params.command, abs, T.errors.edit_requires_instruction);
  onUpdate?.({ content: [], details: { id } });
  const pick = resolveEditorModel(ctx);
  const r = await editFile(params.path, {
    id,
    onStream: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { id } }),
    instruction: params.instruction,
    provider: pick.provider,
    modelId: pick.modelId,
    cwd: ctx.cwd,
    signal,
    timeoutMs: cfg.subagentTimeoutMs,
    transcriptDir: resolveTranscriptDir(cfg.transcriptDir, ctx.cwd),
    maxTranscripts: cfg.maxTranscripts,
    maxFileBytes: cfg.maxFileBytes,
    fuzzyMatch: cfg.fuzzyMatch,
  });
  if (!r.ok) return errorResult(id, params.command, abs, r.error);
  const body = [
    field("blocks", String(r.applied)),
    field("rewrite", String(r.wholeFileRewrite)),
    field("match", r.match),
    field("diff", r.diff),
  ];
  if (r.lsp) body.push(r.lsp);
  return okResult(id, params.command, abs, body, {
    id,
    kind: "edit",
    diff: r.diff,
    blocks: r.applied,
    rewrite: r.wholeFileRewrite,
    match: r.match,
    patch: r.patch,
    firstChangedLine: r.firstChangedLine,
    diffOps: r.diffOps,
    usage: r.usage,
  });
}

export const llmEditorTool = {
  name: LLM_EDITOR_TOOL,
  label: T0.tool.label,
  description: T0.tool.description,
  promptSnippet: T0.tool.prompt_snippet,
  promptGuidelines: T0.tool.guidelines,
  parameters: schema,
  renderCall(args: any, theme: any, context: any) {
    return renderLlmEditorCall(args, theme, context);
  },
  renderResult(result: any, opts: { expanded: boolean; isPartial: boolean }, theme: any) {
    return renderLlmEditorResult(result, opts, theme);
  },
  async execute(
    toolCallId: string,
    params: Params,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    return execute(toolCallId, params, signal, onUpdate, ctx);
  },
};
