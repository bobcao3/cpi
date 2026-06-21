/**
 * `edit`: delegate to the Editor subagent, then apply + write under compare-and-swap.
 *
 * Reads the file, sends raw content + a natural-language instruction to the
 * tool-less Editor subagent (which emits SEARCH/REPLACE blocks), parses +
 * applies them (atomic, unique, exact) and writes the result. Mirrors SWE-Edit's
 * Editor (§3.1): decouples the main agent's reasoning from format-sensitive
 * find-replace generation.
 *
 * Race-free commit: the loop runs under a per-path lock (cas.ts) so parallel
 * same-path edits serialize instead of clobbering. Each attempt captures a
 * fingerprint at read time and compare-and-swaps at write time: if the file
 * drifted since read (a concurrent `sh`/external edit during the subagent run)
 * nothing is written — instead the CURRENT content is re-read and handed back
 * to the Editor subagent (reconcile task) to re-emit blocks against the updated
 * source. The CAS repeats at most once; a second drift writes nothing and is
 * surfaced to
 * the main agent as a structured error for handling. Any block failure also
 * writes nothing. Write itself is tmp-file + rename (atomic replace). All prose
 * lives in text.toml.
 */

import { readFile, stat, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { runSubagent } from "./subagent.ts";
import { loadEditorText, fmt, type EditorText } from "./text.ts";
import { parseBlocks, applyBlocks, type ApplyError } from "./apply.ts";
import { editDiffOps, type DiffOp } from "./diff.ts";
import { withPathLock, fingerprintOf, unchangedSince, type Fingerprint } from "./cas.ts";

/** Max reconcile attempts after a drift; past it the drift is surfaced to the main agent (no write). Exactly one. */
const MAX_RECONCILES = 1;

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
  onStream?: (accumulated: string) => void;
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
      usage?: { input: number; output: number };
    }
  | { ok: false; error: string };

function formatApplyError(T: EditorText, e: ApplyError): string {
  switch (e.code) {
    case "no_blocks":
      return T.errors.apply_no_blocks;
    case "empty_with_others":
      return T.errors.apply_empty_with_others;
    case "not_found":
      return fmt(T.errors.apply_not_found, { i: e.block });
    case "not_unique":
      return fmt(T.errors.apply_not_unique, { i: e.block, n: e.occurrences });
    case "overlap":
      return fmt(T.errors.apply_overlap, { i: e.block, j: e.prev });
  }
}

export async function editFile(path: string, opts: EditFileOptions): Promise<EditFileResult> {
  const T = loadEditorText(opts.cwd);
  const abs = resolve(opts.cwd, path);
  return withPathLock(abs, async () => {
    for (let attempt = 0; attempt <= MAX_RECONCILES; attempt++) {
      const reconcile = attempt > 0;
      let content: string;
      let at: Fingerprint;
      try {
        const st = await stat(abs, { bigint: true });
        if (!st.isFile()) return { ok: false, error: fmt(T.errors.not_a_file, { path: abs }) };
        if (Number(st.size) > opts.maxFileBytes)
          return {
            ok: false,
            error: fmt(T.errors.file_too_large, { size: Number(st.size), limit: opts.maxFileBytes, path: abs }),
          };
        content = await readFile(abs, "utf-8");
        at = fingerprintOf(st);
      } catch (err) {
        return {
          ok: false,
          error: fmt(T.errors.cannot_read, { path: abs, reason: (err as Error).message }),
        };
      }

      const task = reconcile
        ? fmt(T.tasks.editor_reconcile, { content, instruction: opts.instruction })
        : fmt(T.tasks.editor, { content, instruction: opts.instruction });
      const res = await runSubagent({
        role: "editor",
        systemPrompt: T.system.editor,
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
      });

      if (res.spawnError)
        return { ok: false, error: fmt(T.errors.spawn_not_found, { reason: res.spawnError }) };
      if (res.timedOut)
        return { ok: false, error: fmt(T.errors.editor_timeout, { ms: opts.timeoutMs }) };

      const blocks = parseBlocks(res.answer);
      const applied = applyBlocks(content, blocks);
      if (!applied.ok) {
        return {
          ok: false,
          error: formatApplyError(T, applied.error),
        };
      }

      // Compare-and-swap: commit only if unchanged since this attempt's read.
      if (!(await unchangedSince(abs, at))) {
        // Drifted; reconcile on the next attempt against the updated source.
        continue;
      }

      const tmp = join(dirname(abs), `.llm-editor-tmp-${process.pid}-${Date.now()}`);
      try {
        await writeFile(tmp, applied.content, "utf-8");
        await rename(tmp, abs);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        return { ok: false, error: fmt(T.errors.write_failed, { reason: (err as Error).message }) };
      }

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
        usage: res.usage,
      };
    }
    // Reconcile (allowed once) exhausted; file kept drifting. Write nothing; surface to main agent.
    return { ok: false, error: fmt(T.errors.file_drifted, { path: abs }) };
  });
}