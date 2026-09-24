/**
 * cpi's AI-mediated file tools `read`/`write`/`edit`, plus direct `apply_patch`,
 * overriding pi's builtins
 * by name (extension tools win pi's registry — nothing needs disabling). The
 * tool name IS the command: read = dir → 2-level listing, image → inline
 * attachment (vision models only), query → Viewer subagent ranges, else plain
 * head; write = new file only (fails if it exists); edit = Editor subagent
 * hunks, applied + written here. File I/O lives in the tools; subagents only
 * reason. Prose (descriptions, guidelines, schemas, messages) lives in
 * text.toml; this module holds logic + glyphs only.
 */

import { Type } from "typebox";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadEditorConfig } from "../lib/config.ts";
import { resolveCwdPath, getCwd } from "../lib/cwd.ts";
import { expandSourcePath } from "../lib/skill-paths.ts";
import { surfaceNewAgents, formatAgentsBlock } from "../lib/agents.ts";
import { requestFooterRender } from "../lib/footer.ts";
import { resolveTranscriptDir } from "./log.ts";
import { resolveEditorModel } from "./model-select.ts";
import { loadEditorText, fmt } from "./text.ts";
import { executeRead } from "./read-tool.ts";
import { editFile } from "./editor.ts";
import { applyPatchFile } from "./file-edit.ts";
import { MAX_DIFF_BLOCK_BYTES } from "./udiff.ts";
import { withPathLock } from "./lock.ts";
import { shortSha } from "./id.ts";
import { resultXml, field } from "./result-xml.ts";
import { lspFields } from "./lsp.ts";
import { renderEditorCall, renderEditorResult } from "./render.ts";
import { renderReadCall, renderReadResult } from "./read-render.ts";

export type Command = "read" | "write" | "edit" | "apply_patch";

// Tool metadata + schema descriptions are registered once at load (startup cwd); per-call messages/errors re-read per-cwd.
const T0 = loadEditorText();

const readSchema = Type.Object({
  path: Type.String({ description: T0.schema.read_path }),
  query: Type.Optional(Type.String({ description: T0.schema.query })),
});
const editSchema = Type.Object({
  path: Type.String({ description: T0.schema.path }),
  instruction: Type.String({ description: T0.schema.instruction }),
});
const patchSchema = Type.Object({
  path: Type.String({ description: T0.schema.path }),
  patch: Type.String({
    description: T0.schema.patch,
    minLength: 1,
    maxLength: MAX_DIFF_BLOCK_BYTES,
  }),
});
const writeSchema = Type.Object({
  path: Type.String({ description: T0.schema.path }),
  file_text: Type.String({ description: T0.schema.file_text }),
});

type ReadParams = { path: string; query?: string };
type EditParams = { path: string; instruction: string };
type PatchParams = { path: string; patch: string };
type WriteParams = { path: string; file_text: string };
type AnyParams = ReadParams | EditParams | PatchParams | WriteParams;

function okResult(
  command: Command,
  path: string,
  body: string[],
  details?: unknown,
  suffix?: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          resultXml([field("command", command), field("path", path), ...body]) +
          (suffix ? "\n" + suffix : ""),
      },
    ],
    details,
  };
}
function errorResult(
  id: string,
  command: Command,
  path: string,
  message: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: resultXml([
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

async function executeWrite(params: WriteParams, id: string, abs: string) {
  const T = loadEditorText(getCwd());
  const fileText = params.file_text;
  return withPathLock(abs, async () => {
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, fileText, { flag: "wx" });
    } catch (e) {
      const code = (e as Error & { code?: string }).code;
      if (code === "EEXIST")
        return errorResult(
          id,
          "write",
          abs,
          fmt(T.errors.file_exists, { path: abs }),
        );
      return errorResult(
        id,
        "write",
        abs,
        fmt(T.errors.create_failed, {
          path: abs,
          reason: (e as Error).message,
        }),
      );
    }
    const body = [
      field("created", undefined, {
        bytes: Buffer.byteLength(fileText, "utf-8"),
      }),
    ];
    const lsp = await lspFields(abs);
    if (lsp) body.push(lsp);
    const agents = surfaceAgentsBlock(dirname(abs));
    return okResult(
      "write",
      abs,
      body,
      { id, kind: "create", bytes: Buffer.byteLength(fileText, "utf-8") },
      agents,
    );
  });
}

type EditorUpdateCb = NonNullable<Parameters<ToolDefinition["execute"]>[3]>;

function surfaceAgentsBlock(dir: string): string {
  return formatAgentsBlock(surfaceNewAgents(dir));
}

async function executeEdit(
  command: "edit" | "apply_patch",
  params: EditParams | PatchParams,
  signal: AbortSignal | undefined,
  onUpdate: EditorUpdateCb | undefined,
  ctx: ExtensionContext,
  id: string,
  abs: string,
) {
  const cwd = getCwd();
  const cfg = loadEditorConfig(cwd);
  const common = {
    cwd,
    signal,
    maxFileBytes: cfg.maxFileBytes,
    fuzzyMatch: cfg.fuzzyMatch,
  };
  const r =
    command === "apply_patch"
      ? await applyPatchFile(abs, {
          ...common,
          patch: (params as PatchParams).patch,
        })
      : await editFile(abs, {
          ...common,
          ...resolveEditorModel(ctx),
          id,
          instruction: (params as EditParams).instruction,
          onStream: (text) =>
            onUpdate?.({ content: [{ type: "text", text }], details: { id } }),
          timeoutMs: cfg.subagentTimeoutMs,
          maxCorrectionTurns: cfg.maxCorrectionTurns,
          transcriptDir: resolveTranscriptDir(cfg.transcriptDir, cwd),
          maxTranscripts: cfg.maxTranscripts,
        });
  if (r.ok === false) return errorResult(id, command, abs, r.error);
  const body = [
    field("hunks", String(r.applied)),
    field("rewrite", String(r.wholeFileRewrite)),
    field("match", r.match),
    field("diff", r.diff),
  ];
  if (r.lsp) body.push(r.lsp);
  const agents = surfaceAgentsBlock(dirname(abs));
  requestFooterRender();
  return okResult(
    command,
    abs,
    body,
    {
      id,
      kind: "edit",
      diff: r.diff,
      hunks: r.applied,
      rewrite: r.wholeFileRewrite,
      match: r.match,
      patch: r.patch,
      firstChangedLine: r.firstChangedLine,
      diffOps: r.diffOps,
      usage: r.usage,
    },
    agents,
  );
}

async function execute(
  command: Command,
  params: AnyParams,
  signal: AbortSignal | undefined,
  onUpdate: EditorUpdateCb | undefined,
  ctx: ExtensionContext,
) {
  const T = loadEditorText(getCwd());
  const id = shortSha({ command, ...params });
  const abs = resolveCwdPath(
    command === "read" ? expandSourcePath(params.path) : params.path,
  );
  if (signal?.aborted) return errorResult(id, command, abs, T.errors.aborted);

  if (command === "read")
    return executeRead(
      { ...(params as ReadParams), path: abs },
      signal,
      ctx,
      id,
      abs,
    );
  if (command === "write") return executeWrite(params as WriteParams, id, abs);
  return executeEdit(
    command,
    params as EditParams | PatchParams,
    signal,
    onUpdate,
    ctx,
    id,
    abs,
  );
}

function defineTool(command: Command, schema: object) {
  const meta = T0.tool[command];
  return {
    name: command,
    label: command,
    description: meta.description,
    promptSnippet: meta.prompt_snippet,
    promptGuidelines: meta.guidelines,
    parameters: schema,
    renderShell: command === "read" ? ("self" as const) : ("default" as const),
    renderCall(args: any, theme: any, context: any) {
      return command === "read"
        ? renderReadCall(args, theme, context)
        : renderEditorCall(command, args, theme, context);
    },
    renderResult(
      result: any,
      opts: { expanded: boolean; isPartial: boolean },
      theme: any,
      context: any,
    ) {
      return command === "read"
        ? renderReadResult(result, opts, theme, context)
        : renderEditorResult(result, opts, theme, context);
    },
    async execute(
      _toolCallId: string,
      params: AnyParams,
      signal: AbortSignal | undefined,
      onUpdate: EditorUpdateCb | undefined,
      ctx: ExtensionContext,
    ) {
      return execute(command, params, signal, onUpdate, ctx);
    },
  };
}

export const readTool = defineTool("read", readSchema);
export const editTool = defineTool("edit", editSchema);
export const applyPatchTool = defineTool("apply_patch", patchSchema);
export const writeTool = defineTool("write", writeSchema);
