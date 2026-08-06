/** Applies editor changes atomically under a per-path lock. */

import { readFile, stat, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import {
  generateDiffString,
  generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { runSubagent } from "./subagent.ts";
import { loadEditorText, fmt, type EditorText } from "./text.ts";
import { parseUdiffs, type UdiffParseError } from "./udiff.ts";
import {
  applyUdiffs,
  type UdiffApplyError,
  type UdiffApplyResult,
} from "./udiff-apply.ts";
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
  /** Controls fuzzy matching (default on). */
  fuzzyMatch?: boolean;
  onStream?: (accumulated: string) => void;
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

type Attempt =
  | { ok: "applied"; result: UdiffApplyResult & { ok: true } }
  | { ok: "retryable"; error: string }
  | { ok: "fatal"; error: string };

function formatParseError(T: EditorText, e: UdiffParseError): string {
  const values = { i: e.block ?? 0, line: e.line ?? 0 };
  switch (e.code) {
    case "no_diffs":
      return T.errors.apply_no_diffs;
    case "too_many":
      return fmt(T.errors.apply_too_many, values);
    case "too_large":
      return fmt(T.errors.apply_too_large, values);
    case "bad_block":
      return fmt(T.errors.apply_bad_block, values);
    case "bad_header":
      return fmt(T.errors.apply_bad_header, values);
    case "no_changes":
      return T.errors.apply_no_changes;
    case "bad_count":
      return fmt(T.errors.apply_bad_count, values);
    case "bad_newline":
      return fmt(T.errors.apply_bad_newline, values);
  }
}

function formatApplyError(T: EditorText, e: UdiffApplyError): string {
  switch (e.code) {
    case "bad_anchor":
      return fmt(T.errors.apply_bad_anchor, { i: e.block });
    case "not_found":
      return e.fuzzy
        ? fmt(T.errors.apply_not_found_fuzzy, { i: e.block })
        : fmt(T.errors.apply_not_found, { i: e.block });
    case "ambiguous":
      return fmt(T.errors.apply_ambiguous, { i: e.block });
    case "bad_newline":
      return fmt(T.errors.apply_bad_newline, { i: e.block });
    case "work_limit":
      return fmt(T.errors.apply_work_limit, { i: e.block });
    case "overlap":
      return fmt(T.errors.apply_overlap, { i: e.block, j: e.previous });
  }
}

export async function editFile(
  path: string,
  opts: EditFileOptions,
): Promise<EditFileResult> {
  const T = loadEditorText(opts.cwd);
  const abs = resolve(opts.cwd, path);
  return withPathLock(abs, async () => {
    let content: string;
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
    } catch (err) {
      return {
        ok: false,
        error: fmt(T.errors.cannot_read, {
          path: abs,
          reason: (err as Error).message,
        }),
      };
    }

    let usage: { input: number; output: number } | undefined;
    const numbered = numberLines(content);
    const baseSystem =
      opts.fuzzyMatch === false
        ? T.system.editor
        : T.system.editor + T.system.editor_fuzzy;

    const attempt = async (failure?: string): Promise<Attempt> => {
      const res = await runSubagent({
        role: "editor",
        systemPrompt: failure
          ? baseSystem + T.system.editor_rewrite
          : baseSystem,
        task: failure
          ? fmt(T.tasks.editor_retry, {
              content: numbered,
              instruction: opts.instruction,
              failure,
            })
          : fmt(T.tasks.editor, {
              content: numbered,
              instruction: opts.instruction,
            }),
        provider: opts.provider,
        modelId: opts.modelId,
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        transcriptDir: opts.transcriptDir,
        id: failure ? `${opts.id}-retry` : opts.id,
        maxTranscripts: opts.maxTranscripts,
        onStream: opts.onStream,
        thinkingLevel: opts.thinkingLevel,
      });

      if (res.spawnError)
        return {
          ok: "fatal",
          error: fmt(T.errors.spawn_not_found, { reason: res.spawnError }),
        };
      if (res.timedOut)
        return {
          ok: "fatal",
          error: fmt(T.errors.editor_timeout, { ms: opts.timeoutMs }),
        };

      const c = res.completion;
      if (!c || c.tool !== "edit-complete")
        return { ok: "fatal", error: T.errors.editor_truncated };
      if (c.args.cancel === true)
        return { ok: "fatal", error: T.errors.editor_cancelled };
      if (res.usage)
        usage = {
          input: (usage?.input ?? 0) + res.usage.input,
          output: (usage?.output ?? 0) + res.usage.output,
        };

      const rewrite =
        typeof c.args.content === "string" ? c.args.content : undefined;
      if (rewrite !== undefined) {
        if (rewrite.trim() === "" && content.trim() !== "")
          return { ok: "retryable", error: T.errors.rewrite_empty };
        return {
          ok: "applied",
          result: {
            ok: true,
            content: rewrite,
            applied: 1,
            wholeFileRewrite: true,
            match: "exact",
          },
        };
      }
      const parsed = parseUdiffs(c.args.diffs);
      if (parsed.ok === false)
        return { ok: "retryable", error: formatParseError(T, parsed.error) };
      const result = applyUdiffs(content, parsed.hunks, {
        fuzzy: opts.fuzzyMatch,
      });
      if (result.ok === false)
        return { ok: "retryable", error: formatApplyError(T, result.error) };
      return { ok: "applied", result };
    };

    let outcome = await attempt();
    if (outcome.ok === "retryable") outcome = await attempt(outcome.error);
    if (outcome.ok !== "applied") return { ok: false, error: outcome.error };
    const applied = outcome.result;
    if (applied.content === content) {
      return { ok: false, error: T.errors.no_change };
    }

    const tmp = join(
      dirname(abs),
      `.llm-editor-tmp-${process.pid}-${Date.now()}`,
    );
    try {
      await writeFile(tmp, applied.content, "utf-8");
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      return {
        ok: false,
        error: fmt(T.errors.write_failed, {
          path: abs,
          reason: (err as Error).message,
        }),
      };
    }

    const lsp = await lspFields(abs);
    const { diff, firstChangedLine } = generateDiffString(
      content,
      applied.content,
    );
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
      usage,
    };
  });
}
