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
  type UdiffParseError,
  MAX_DIFF_BLOCK_BYTES,
  MAX_DIFF_BLOCKS,
  MAX_DIFF_LINES,
  MAX_DIFF_TOTAL_BYTES,
  MAX_DIFF_COORDINATE,
} from "./udiff.ts";
import type { PatchTarget } from "./patch-framing.ts";
import {
  applyUdiffs,
  type UdiffApplyError,
  type UdiffApplyResult,
} from "./udiff-apply.ts";
import { editDiffOps, type DiffOp } from "./diff.ts";
import { withPathLock } from "./lock.ts";
import { lspFields } from "./lsp.ts";
import { loadEditorConfig } from "../lib/config.ts";

export interface FileEditOptions {
  cwd: string;
  signal?: AbortSignal;
  maxFileBytes: number;
}

type Usage = { input: number; output: number };
type FileEditError = { ok: false; error: string; usage?: Usage };
export interface PatchFailure {
  block: number;
  hunk: number;
  line: number;
  appliedHunks: number[];
  message: string;
}
export type FileEditContentResult =
  | (Omit<UdiffApplyResult & { ok: true }, "failure"> & {
      failure?: PatchFailure;
      usage?: Usage;
    })
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
      failure?: PatchFailure;
    }
  | FileEditError;

function failureMessage(
  T: EditorText,
  e: UdiffParseError | UdiffApplyError,
  appliedHunks: number[] = [],
): string {
  const code = e.code === "not_found" && e.fuzzy ? "not_found_fuzzy" : e.code;
  const reason = fmt(T.errors[`apply_${code}`], {
    patch: e.block,
    i: e.block,
    line: e.line,
    j: e.code === "overlap" ? e.previous : 0,
    previous_hunk: e.code === "overlap" ? e.previous : 0,
    hunk_limit: MAX_DIFF_BLOCKS,
    patch_byte_limit: MAX_DIFF_BLOCK_BYTES,
    total_byte_limit: MAX_DIFF_TOTAL_BYTES,
    patch_line_limit: MAX_DIFF_LINES,
    coordinate_limit: MAX_DIFF_COORDINATE,
  });
  if (e.hunk === undefined) return fmt(T.errors.patch_rejected, { reason });
  const failure = fmt(T.errors.hunk_failed, {
    ...e,
    patch: e.block,
    reason,
  });
  return fmt(
    T.errors[appliedHunks.length ? "hunk_partial" : "hunk_unchanged"],
    {
      failure,
      hunk: e.hunk,
      applied: appliedHunks.join(", "),
      plural: appliedHunks.length !== 1,
    },
  );
}

export function applyFileDiff(
  content: string,
  diffs: unknown,
  T: EditorText,
  opts: PatchTarget & { fuzzyMatch?: boolean; partialApply?: boolean },
): FileEditContentResult {
  const partial = opts.partialApply ?? loadEditorConfig(opts.cwd).partialApply;
  const parsed = parseUdiffs(diffs, opts);
  if (parsed.ok === false && !parsed.hunks)
    return { ok: false, error: failureMessage(T, parsed.error) };
  const result = applyUdiffs(content, parsed.hunks ?? [], {
    fuzzy: opts.fuzzyMatch,
    partial,
  });
  if (result.ok === false)
    return { ok: false, error: failureMessage(T, result.error) };
  const error =
    result.failure ?? (parsed.ok === false ? parsed.error : undefined);
  if (error) {
    const appliedHunks =
      partial && result.content !== content ? result.appliedHunks : [];
    const message = failureMessage(T, error, appliedHunks);
    if (!appliedHunks.length) return { ok: false, error: message };
    return {
      ...result,
      failure: {
        block: error.block!,
        hunk: error.hunk!,
        line: error.line!,
        appliedHunks,
        message,
      },
    };
  }
  return result.content === content
    ? { ok: false, error: T.errors.no_change }
    : { ...result, failure: undefined };
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
      failure: applied.failure,
    };
  });
}

export async function applyPatchFile(
  path: string,
  opts: FileEditOptions & {
    patch: string;
    fuzzyMatch?: boolean;
    partialApply?: boolean;
  },
): Promise<EditFileResult> {
  const T = loadEditorText(opts.cwd);
  return withFileEdit(path, opts, async (content) =>
    applyFileDiff(content, [opts.patch], T, { ...opts, path }),
  );
}
