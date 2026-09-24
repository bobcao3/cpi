import { readFile, stat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, relative, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadEditorConfig } from "../lib/config.ts";
import { getCwd } from "../lib/cwd.ts";
import { surfaceNewAgents, formatAgentsBlock } from "../lib/agents.ts";
import { requestFooterRender } from "../lib/footer.ts";
import { sniffMediaType, modelSupportsVision } from "../lib/media.ts";
import { resolveTranscriptDir } from "./log.ts";
import { resolveEditorModel } from "./model-select.ts";
import { loadEditorText, fmt } from "./text.ts";
import { viewFile } from "./viewer.ts";
import { readImageResult, textResult, videoResult } from "./media-result.ts";
import { lineBodies } from "./lines.ts";

type ReadParams = { path: string; query?: string };

function readResult(payload: string, details: unknown, suffix?: string) {
  let text = payload;
  if (suffix) text = text ? `${text}\n${suffix}` : suffix;
  return { content: [{ type: "text" as const, text }], details };
}

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

async function headRead(abs: string, cwd: string, max = 200) {
  const T = loadEditorText(cwd);
  const content = await readFile(abs, "utf-8");
  const all = content.split("\n");
  const totalLines = lineBodies(content).length;
  return {
    text:
      totalLines > max
        ? `${all.slice(0, max).join("\n")}\n${fmt(T.messages.head_more, { n: totalLines - max })}`
        : content,
    lineCount: Math.min(totalLines, max),
  };
}

function surfaceAgentsBlock(dir: string): string {
  return formatAgentsBlock(surfaceNewAgents(dir));
}

export async function executeRead(
  params: ReadParams,
  signal: AbortSignal | undefined,
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

  const media = await sniffMediaType(abs).catch(() => null);
  if (media && media.kind === "video") return videoResult(abs, id);
  if (media && media.kind === "image") {
    const mime = media.mime;
    if (!modelSupportsVision(ctx.model)) {
      return textResult(
        id,
        "image",
        fmt(T.messages.image_unsupported, { mime, path: abs }),
      );
    }
    return readImageResult(abs, mime, id);
  }

  if (!params.query) {
    try {
      const content = await headRead(abs, cwd);
      const agents = surfaceAgentsBlock(dirname(abs));
      return readResult(
        content.text,
        {
          id,
          kind: "content",
          text: content.text,
          lineCount: content.lineCount,
        },
        agents,
      );
    } catch (e) {
      return readErrorResult(
        id,
        fmt(T.errors.cannot_read, { path: abs, reason: (e as Error).message }),
      );
    }
  }

  const cfg = loadEditorConfig(cwd);
  const pick = resolveEditorModel(ctx);
  const r = await viewFile(params.path, {
    id,
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
    {
      id,
      kind: "view",
      text: r.text,
      summary: r.summary,
      ranges: r.ranges,
      usage: r.usage,
    },
    agents,
  );
}
