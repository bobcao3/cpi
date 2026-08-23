/**
 * cpi's AI-mediated file tools `read`/`write`/`edit`, overriding pi's builtins
 * by name (extension tools win pi's registry — nothing needs disabling). The
 * tool name IS the command: read = dir → 2-level listing, image → inline
 * attachment (vision models only), query → Viewer subagent ranges, else plain
 * head; write = new file only (fails if it exists); edit = Editor subagent
 * hunks, applied + written here. File I/O lives in the tools; subagents only
 * reason. Prose (descriptions, guidelines, schemas, messages) lives in
 * text.toml; this module holds logic + glyphs only.
 */

import { Type } from "typebox";
import { readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, relative, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  resizeImage,
  formatDimensionNote,
} from "@earendil-works/pi-coding-agent";
import { loadEditorConfig } from "../lib/config.ts";
import { resolveCwdPath, getCwd } from "../lib/cwd.ts";
import { surfaceNewAgents, formatAgentsBlock } from "../lib/agents.ts";
import { requestFooterRender } from "../lib/footer.ts";
import { resolveTranscriptDir } from "./log.ts";
import { resolveEditorModel } from "./model-select.ts";
import { loadEditorText, fmt } from "./text.ts";
import { viewFile } from "./viewer.ts";
import { editFile } from "./editor.ts";
import { withPathLock } from "./lock.ts";
import { shortSha } from "./id.ts";
import { resultXml, field } from "./result-xml.ts";
import { lspFields } from "./lsp.ts";
import { renderEditorCall, renderEditorResult } from "./render.ts";
import { sniffMediaType, modelSupportsVision } from "../lib/media.ts";

export type Command = "read" | "write" | "edit";

// Tool metadata + schema descriptions are registered once at load (startup cwd); per-call messages/errors re-read per-cwd.
const T0 = loadEditorText();

const readSchema = Type.Object({
  path: Type.String({ description: T0.schema.path }),
  query: Type.Optional(Type.String({ description: T0.schema.query })),
});
const editSchema = Type.Object({
  path: Type.String({ description: T0.schema.path }),
  instruction: Type.String({ description: T0.schema.instruction }),
});
const writeSchema = Type.Object({
  path: Type.String({ description: T0.schema.path }),
  file_text: Type.String({ description: T0.schema.file_text }),
});

type ReadParams = { path: string; query?: string };
type EditParams = { path: string; instruction: string };
type WriteParams = { path: string; file_text: string };
type AnyParams = ReadParams | EditParams | WriteParams;

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

/** Plain text result (no XML wrapper) for media paths (image/video notes). */
function textResult(
  id: string,
  kind: string,
  text: string,
  details?: Record<string, unknown>,
) {
  return {
    content: [{ type: "text" as const, text }],
    details: { id, kind, ...details },
  };
}

/** `read` success: raw payload (no XML, no escaping — the model sees exact bytes); the call `id` lives only in `details` and the transcript, never in the result text. */
function readResult(payload: string, details: unknown, suffix?: string) {
  let text = payload;
  if (suffix) text = text ? `${text}\n${suffix}` : suffix;
  return { content: [{ type: "text" as const, text }], details };
}

/** `read` error: the message is the whole result text; `id` stays in `details`. */
function readErrorResult(id: string, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    details: { id, kind: "error" as const, message },
  };
}

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

/** Plain full-file head read (no line numbers) — cheap fallback when no Viewer query is given. */
async function headRead(abs: string, cwd: string, max = 200): Promise<string> {
  const T = loadEditorText(cwd);
  const content = await readFile(abs, "utf-8");
  const all = content.split("\n");
  const lines = all.slice(0, max);
  const body = lines.join("\n");
  return all.length > max
    ? `${body}\n${fmt(T.messages.head_more, { n: all.length - max })}`
    : body;
}

function surfaceAgentsBlock(dir: string): string {
  return formatAgentsBlock(surfaceNewAgents(dir));
}

async function readImageResult(abs: string, mime: string, id: string) {
  const buffer = await readFile(abs);
  const resized = await resizeImage(buffer, mime);
  if (!resized) {
    return textResult(
      id,
      "image",
      `Read image file [${mime}]\n[Image omitted: could not be resized below the inline image size limit.]`,
    );
  }
  const dimNote = formatDimensionNote(resized);
  let note = `Read image file [${resized.mimeType}]`;
  if (dimNote) note += `\n${dimNote}`;
  return {
    content: [
      { type: "text" as const, text: note },
      {
        type: "image" as const,
        data: resized.data,
        mimeType: resized.mimeType,
      },
    ],
    details: {
      id,
      kind: "image" as const,
      mimeType: resized.mimeType,
      width: resized.width,
      height: resized.height,
      note,
    },
  };
}

/** `read` on a video: pi has no video content type; return an actionable note. */
function videoResult(abs: string, id: string) {
  const note =
    `Video file [${abs}]. pi has no native video content type, so it cannot be inlined. ` +
    `Extract frames via sh, e.g. \`ffmpeg -i "${abs}" -vf fps=1 frame_%03d.png\`, then read the frames.`;
  return textResult(id, "video", note, { path: abs });
}

type EditorUpdateCb = (partial: {
  content: unknown[];
  details?: unknown;
}) => void;

async function executeRead(
  params: ReadParams,
  signal: AbortSignal | undefined,
  onUpdate: EditorUpdateCb | undefined,
  ctx: ExtensionContext,
  id: string,
  abs: string,
) {
  const cwd = getCwd();
  const T = loadEditorText(cwd);
  let isDir = false;
  try {
    isDir = (await stat(abs)).isDirectory();
  } catch {
    return readErrorResult(id, fmt(T.errors.not_found, { path: abs }));
  }
  if (isDir) {
    const tree = await listTree(abs, cwd);
    const agents = surfaceAgentsBlock(abs);
    return readResult(tree, { id, kind: "tree", text: tree }, agents);
  }

  // Media = known extension AND matching magic bytes: `.ts` source is text
  // unless its bytes are an MPEG-TS stream. Sniffed before text reading so
  // binary is never dumped; video never inlines, image only for vision models.
  const media = await sniffMediaType(abs).catch(() => null);
  if (media && media.kind === "video") return videoResult(abs, id);
  if (media && media.kind === "image") {
    const mime = media.mime;
    if (!modelSupportsVision(ctx.model)) {
      return textResult(
        id,
        "image",
        `Image file [${mime}]: ${abs}. The current model does not support images.`,
      );
    }
    return readImageResult(abs, mime, id);
  }

  if (!params.query) {
    try {
      const content = await headRead(abs, cwd);
      const agents = surfaceAgentsBlock(dirname(abs));
      return readResult(
        content,
        { id, kind: "content", text: content },
        agents,
      );
    } catch (e) {
      return readErrorResult(
        id,
        fmt(T.errors.cannot_read, { path: abs, reason: (e as Error).message }),
      );
    }
  }

  onUpdate?.({ content: [], details: { id } });
  const cfg = loadEditorConfig(cwd);
  const pick = resolveEditorModel(ctx);
  const r = await viewFile(params.path, {
    id,
    onStream: (text) =>
      onUpdate?.({ content: [{ type: "text", text }], details: { id } }),
    query: params.query,
    provider: pick.provider,
    modelId: pick.modelId,
    cwd,
    signal,
    timeoutMs: cfg.subagentTimeoutMs,
    transcriptDir: resolveTranscriptDir(cfg.transcriptDir, cwd),
    maxTranscripts: cfg.maxTranscripts,
    maxFileBytes: cfg.maxFileBytes,
    thinkingLevel: pick.thinkingLevel,
  });
  if (r.error) return readErrorResult(id, r.error);
  requestFooterRender();
  const agents = surfaceAgentsBlock(dirname(abs));
  return readResult(
    r.text,
    { id, kind: "view", text: r.text, usage: r.usage },
    agents,
  );
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

async function executeEdit(
  params: EditParams,
  signal: AbortSignal | undefined,
  onUpdate: EditorUpdateCb | undefined,
  ctx: ExtensionContext,
  id: string,
  abs: string,
) {
  const cfg = loadEditorConfig(getCwd());
  const pick = resolveEditorModel(ctx);
  const r = await editFile(params.path, {
    id,
    onStream: (text) =>
      onUpdate?.({ content: [{ type: "text", text }], details: { id } }),
    instruction: params.instruction,
    provider: pick.provider,
    modelId: pick.modelId,
    cwd: getCwd(),
    signal,
    timeoutMs: cfg.subagentTimeoutMs,
    maxCorrectionTurns: cfg.maxCorrectionTurns,
    transcriptDir: resolveTranscriptDir(cfg.transcriptDir, getCwd()),
    maxTranscripts: cfg.maxTranscripts,
    maxFileBytes: cfg.maxFileBytes,
    fuzzyMatch: cfg.fuzzyMatch,
    thinkingLevel: pick.thinkingLevel,
  });
  if (r.ok === false) return errorResult(id, "edit", abs, r.error);
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
    "edit",
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
  const abs = resolveCwdPath(params.path);
  if (signal?.aborted) return errorResult(id, command, abs, T.errors.aborted);

  if (command === "read")
    return executeRead(params as ReadParams, signal, onUpdate, ctx, id, abs);
  if (command === "write") return executeWrite(params as WriteParams, id, abs);
  return executeEdit(params as EditParams, signal, onUpdate, ctx, id, abs);
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
    renderShell: "default" as const,
    renderCall(args: any, theme: any, context: any) {
      return renderEditorCall(command, args, theme, context);
    },
    renderResult(
      result: any,
      opts: { expanded: boolean; isPartial: boolean },
      theme: any,
      context: any,
    ) {
      return renderEditorResult(result, opts, theme, context);
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
export const writeTool = defineTool("write", writeSchema);
