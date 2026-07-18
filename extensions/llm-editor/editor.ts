/**
 * `edit`: delegate to the Editor subagent, then apply + write atomically.
 *
 * Reads the file, sends numbered content + a natural-language instruction to the
 * tool-less Editor subagent, parses its unified-diff hunks, resolves all hunks
 * against one immutable snapshot, and writes the result atomically. Mirrors SWE-Edit's
 * Editor (§3.1): decouples the main agent's reasoning from format-sensitive
 * unified-hunk generation.
 *
 * Race-free per-path: the whole edit runs under a per-path lock (lock.ts) so
 * parallel same-path edits serialize instead of clobbering — a later edit
 * re-reads the earlier edit's result, not stale content. Within one process
 * same-path edits never overlap, so no compare-and-swap is needed; cross-process
 * drift (a concurrent `sh`/external edit during the subagent run) is out of
 * scope for a cross-platform extension. Atomicity is tmp-file + rename, so the
 * file is never left half-written; any hunk failure writes nothing. All prose
 * lives in text.toml.
 */

import { readFile, stat, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { runSubagent } from "./subagent.ts";
import { loadEditorText, fmt, type EditorText } from "./text.ts";
import { parseUdiffs, type UdiffParseError } from "./udiff.ts";
import { applyUdiffs, type UdiffApplyError, type UdiffApplyResult } from "./udiff-apply.ts";
import { numberLines } from "./lines.ts";
import { editDiffOps, type DiffOp } from "./diff.ts";
import { withPathLock } from "./lock.ts";
import { lspFields } from "./lsp.ts";

export interface EditFileOptions {
  id: string;
  instruction: string;
  provider: string;
  modelId: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  transcriptDir: string;
  maxTranscripts: number;
  maxFileBytes: number;
  /** Toggles whitespace/elision fallback for hunk matching (default on). */
  fuzzyMatch?: boolean;
  onStream?: (accumulated: string) => void;
  /** Optional thinking level for the Editor subagent. */
  thinkingLevel?: string;
}

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
      usage?: { input: number; output: number };
    }
  | { ok: false; error: string };

function formatParseError(T: EditorText, e: UdiffParseError): string {
  const values = { i: e.block ?? 0, line: e.line ?? 0 };
  switch (e.code) {
    case "no_diffs": return T.errors.apply_no_diffs;
    case "too_many": return fmt(T.errors.apply_too_many, values);
    case "too_large": return fmt(T.errors.apply_too_large, values);
    case "bad_block": return fmt(T.errors.apply_bad_block, values);
    case "bad_header": return fmt(T.errors.apply_bad_header, values);
    case "multiple_hunks": return fmt(T.errors.apply_multiple_hunks, values);
    case "bad_prefix": return fmt(T.errors.apply_bad_prefix, values);
    case "no_changes": return fmt(T.errors.apply_no_changes, values);
    case "bad_count": return fmt(T.errors.apply_bad_count, values);
    case "bad_elision": return fmt(T.errors.apply_bad_elision, values);
    case "bad_newline": return fmt(T.errors.apply_bad_newline, values);
  }
}

function formatApplyError(T: EditorText, e: UdiffApplyError): string {
  switch (e.code) {
    case "bad_anchor": return fmt(T.errors.apply_bad_anchor, { i: e.block });
    case "not_found":
      return e.fuzzy
        ? fmt(T.errors.apply_not_found_fuzzy, { i: e.block })
        : fmt(T.errors.apply_not_found, { i: e.block });
    case "ambiguous": return fmt(T.errors.apply_ambiguous, { i: e.block });
    case "bad_newline": return fmt(T.errors.apply_bad_newline, { i: e.block });
    case "work_limit": return fmt(T.errors.apply_work_limit, { i: e.block });
    case "overlap": return fmt(T.errors.apply_overlap, { i: e.block, j: e.previous });
  }
}

export async function editFile(path: string, opts: EditFileOptions): Promise<EditFileResult> {
  const T = loadEditorText(opts.cwd);
  const abs = resolve(opts.cwd, path);
  return withPathLock(abs, async () => {
    let content: string;
    try {
      const st = await stat(abs, { bigint: true });
      if (!st.isFile()) return { ok: false, error: fmt(T.errors.not_a_file, { path: abs }) };
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
    } catch (err) {
      return {
        ok: false,
        error: fmt(T.errors.cannot_read, { path: abs, reason: (err as Error).message }),
      };
    }

    const task = fmt(T.tasks.editor, { content: numberLines(content), instruction: opts.instruction });
    const systemPrompt =
      opts.fuzzyMatch === false ? T.system.editor : T.system.editor + T.system.editor_fuzzy;
    const res = await runSubagent({
      role: "editor",
      systemPrompt,
      task,
      provider: opts.provider,
      modelId: opts.modelId,
      cwd: opts.cwd,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      transcriptDir: opts.transcriptDir,
      id: opts.id,
      maxTranscripts: opts.maxTranscripts,
      onStream: opts.onStream,
      thinkingLevel: opts.thinkingLevel,
    });

    if (res.spawnError)
      return { ok: false, error: fmt(T.errors.spawn_not_found, { reason: res.spawnError }) };
    if (res.timedOut)
      return { ok: false, error: fmt(T.errors.editor_timeout, { ms: opts.timeoutMs }) };

    // The completion tool call IS the signal: edit-complete with diffs => apply;
    // cancel=true => abort; null/wrong tool => the subagent never completed.
    const c = res.completion;
    if (!c || c.tool !== "edit-complete") {
      return { ok: false, error: T.errors.editor_truncated };
    }
    if (c.args.cancel === true) {
      return { ok: false, error: T.errors.editor_cancelled };
    }

    const parsed = parseUdiffs(c.args.diffs);
    if (parsed.ok === false) {
      return { ok: false, error: formatParseError(T, parsed.error) };
    }
    const applied: UdiffApplyResult = applyUdiffs(content, parsed.hunks, { fuzzy: opts.fuzzyMatch });
    if (applied.ok === false) {
      return { ok: false, error: formatApplyError(T, applied.error) };
    }

    // Atomic write: tmp file + rename. The file is never left half-written.
    const tmp = join(dirname(abs), `.llm-editor-tmp-${process.pid}-${Date.now()}`);
    try {
      await writeFile(tmp, applied.content, "utf-8");
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      return { ok: false, error: fmt(T.errors.write_failed, { path: abs, reason: (err as Error).message }) };
    }

    const lsp = await lspFields(abs);
    const { diff, firstChangedLine } = generateDiffString(content, applied.content);
    const diffOps = editDiffOps(content, applied.content, 3, 2);
    const patch = generateUnifiedPatch(abs, content, applied.content);
    return {
      ok: true,
      diff,
      diffOps,
      patch,
      firstChangedLine,
      applied: applied.applied,
      wholeFileRewrite: applied.wholeFileRewrite,
      match: applied.match,
      lsp,
      usage: res.usage,
    };
  });
}
