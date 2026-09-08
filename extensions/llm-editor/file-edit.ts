import { randomUUID } from "node:crypto";
import {
  readFile,
  stat,
  writeFile,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import {
  generateDiffString,
  generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { loadEditorText, fmt, type EditorText } from "./text.ts";
import {
  parseUdiffs,
  MAX_DIFF_BLOCK_BYTES,
  type UdiffParseError,
} from "./udiff.ts";
import {
  applyUdiffs,
  type UdiffApplyError,
  type UdiffApplyResult,
} from "./udiff-apply.ts";
import { editDiffOps, type DiffOp } from "./diff.ts";
import { withPathLock } from "./lock.ts";
import { lspFields } from "./lsp.ts";

export interface FileEditOptions {
  cwd: string;
  signal?: AbortSignal;
  maxFileBytes: number;
}

type Usage = { input: number; output: number };
type FileEditError = { ok: false; error: string; usage?: Usage };
export type FileEditContentResult =
  | ((UdiffApplyResult & { ok: true }) & { usage?: Usage })
  | FileEditError;

export type EditFileResult =
  | {
      ok: true;
      diff: string;
      diffOps: DiffOp[];
      patch: string;
      firstChangedLine: number | undefined;
      applied: number;
      wholeFileRewrite: boolean;
      match: "exact" | "fuzzy";
      lsp: string;
      usage?: Usage;
    }
  | FileEditError;

function formatParseError(T: EditorText, e: UdiffParseError): string {
  return fmt(T.errors[`apply_${e.code}`], {
    i: e.block ?? 0,
    line: e.line ?? 0,
  });
}

function formatApplyError(T: EditorText, e: UdiffApplyError): string {
  const code = e.code === "not_found" && e.fuzzy ? "not_found_fuzzy" : e.code;
  return fmt(T.errors[`apply_${code}`], {
    i: e.block,
    j: e.code === "overlap" ? e.previous : 0,
  });
}

export function applyFileDiff(
  content: string,
  diffs: unknown,
  T: EditorText,
  fuzzyMatch?: boolean,
): FileEditContentResult {
  const parsed = parseUdiffs(diffs);
  if (parsed.ok === false)
    return { ok: false, error: formatParseError(T, parsed.error) };
  const result = applyUdiffs(content, parsed.hunks, { fuzzy: fuzzyMatch });
  if (result.ok === false)
    return { ok: false, error: formatApplyError(T, result.error) };
  return result.content === content
    ? { ok: false, error: T.errors.no_change }
    : result;
}

export async function withFileEdit(
  path: string,
  opts: FileEditOptions,
  update: (content: string) => Promise<FileEditContentResult>,
): Promise<EditFileResult> {
  const T = loadEditorText(opts.cwd);
  const abs = resolve(opts.cwd, path);
  return withPathLock(abs, async () => {
    if (opts.signal?.aborted) return { ok: false, error: T.errors.aborted };
    let content: string;
    let mode: number;
    try {
      const st = await stat(abs, { bigint: true });
      if (!st.isFile())
        return { ok: false, error: fmt(T.errors.not_a_file, { path: abs }) };
      if (Number(st.size) > opts.maxFileBytes)
        return {
          ok: false,
          error: fmt(T.errors.file_too_large, {
            size: Number(st.size),
            limit: opts.maxFileBytes,
            path: abs,
          }),
        };
      content = await readFile(abs, "utf-8");
      mode = Number(st.mode) & 0o777;
    } catch (err) {
      return {
        ok: false,
        error: fmt(T.errors.cannot_read, {
          path: abs,
          reason: (err as Error).message,
        }),
      };
    }
    if (opts.signal?.aborted) return { ok: false, error: T.errors.aborted };
    const applied = await update(content);
    if (applied.ok === false) return applied;
    const { usage } = applied;
    const tmp = join(dirname(abs), `.llm-editor-tmp-${randomUUID()}`);
    try {
      await writeFile(tmp, applied.content, { encoding: "utf-8", flag: "wx" });
      await chmod(tmp, mode);
      if (opts.signal?.aborted) {
        await unlink(tmp).catch(() => {});
        return { ok: false, error: T.errors.aborted, usage };
      }
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      return {
        ok: false,
        error: fmt(T.errors.write_failed, {
          path: abs,
          reason: (err as Error).message,
        }),
        usage,
      };
    }
    const lsp = await lspFields(abs);
    const { diff, firstChangedLine } = generateDiffString(
      content,
      applied.content,
    );
    return {
      ok: true,
      diff,
      diffOps: editDiffOps(content, applied.content, 3, 2),
      patch: generateUnifiedPatch(abs, content, applied.content),
      firstChangedLine,
      applied: applied.applied,
      wholeFileRewrite: applied.wholeFileRewrite,
      match: applied.match,
      lsp,
      usage,
    };
  });
}

const PATCH_HEADER = /^@@(?: -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)?$/;

export async function applyPatchFile(
  path: string,
  opts: FileEditOptions & { patch: string; fuzzyMatch?: boolean },
): Promise<EditFileResult> {
  const T = loadEditorText(opts.cwd);
  if (Buffer.byteLength(opts.patch, "utf8") > MAX_DIFF_BLOCK_BYTES)
    return {
      ok: false,
      error: formatParseError(T, { code: "too_large", block: 0 }),
    };
  const lines = opts.patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (
    !PATCH_HEADER.test(lines[0] ?? "") ||
    lines.some((line) => !PATCH_HEADER.test(line) && !/^[ +\-\\]/.test(line))
  )
    return { ok: false, error: T.errors.patch_format };
  return withFileEdit(path, opts, async (content) =>
    applyFileDiff(content, [opts.patch], T, opts.fuzzyMatch),
  );
}
