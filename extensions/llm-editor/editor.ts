/** Applies editor changes atomically under a per-path lock. */

import { basename, resolve } from "node:path";
import { loadEditorConfig, type EditorMode } from "../lib/config.ts";
import { runSubagent, type SubagentCandidate } from "./subagent.ts";
import { loadEditorText, fmt } from "./text.ts";
import {
  MAX_DIRECT_OUTPUT_BYTES,
  directDiffEnvelope,
  parseDirectDiff,
  type DirectDiffMarkers,
} from "./direct-diff.ts";
import type { UdiffApplyResult } from "./udiff-apply.ts";
import { numberLines } from "./lines.ts";
import {
  withFileEdit,
  applyFileDiff,
  type EditFileResult,
} from "./file-edit.ts";

export type { EditFileResult };

export interface EditFileOptions {
  id: string;
  instruction: string;
  provider: string;
  modelId: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Bounded validation-feedback turns. */
  maxCorrectionTurns?: number;
  transcriptDir: string;
  maxTranscripts: number;
  maxFileBytes: number;
  /** Controls fuzzy matching (default on). */
  fuzzyMatch?: boolean;
  onStream?: (accumulated: string) => void;
  thinkingLevel?: string;
  mode?: EditorMode;
  /** Direct-diff envelope markers (default "patch"). */
  directMarkers?: DirectDiffMarkers;
}

type Attempt =
  | { ok: "applied"; result: UdiffApplyResult & { ok: true } }
  | { ok: "retryable"; error: string }
  | { ok: "fatal"; error: string };

export async function editFile(
  path: string,
  opts: EditFileOptions,
): Promise<EditFileResult> {
  const T = loadEditorText(opts.cwd);
  const editorConfig = loadEditorConfig(opts.cwd);
  return withFileEdit(path, opts, async (content) => {
    let usage: { input: number; output: number } | undefined;
    const numbered = numberLines(content);
    const direct = (opts.mode ?? editorConfig.mode) === "direct-diff";
    const maxCorrectionTurns =
      opts.maxCorrectionTurns ?? editorConfig.maxCorrectionTurns;
    const directMarkers = opts.directMarkers ?? "patch";
    const envelopeMarkers = directDiffEnvelope(directMarkers);
    const baseSystem =
      (direct
        ? fmt(T.system.editor_direct, envelopeMarkers)
        : T.system.editor) +
      (opts.fuzzyMatch === false ? "" : T.system.editor_fuzzy);

    const validateDiffs = (diffs: unknown): Attempt => {
      const result = applyFileDiff(content, diffs, T, { ...opts, path });
      if (result.ok === false) return { ok: "retryable", error: result.error };
      return { ok: "applied", result };
    };

    const validateCandidate = (candidate: SubagentCandidate): Attempt => {
      if (direct) {
        if (candidate.outputOverflow)
          return { ok: "retryable", error: T.errors.direct_output_overflow };
        const envelope = parseDirectDiff(candidate.text, directMarkers);
        if (envelope.ok === false)
          return {
            ok: "retryable",
            error: fmt(T.errors["direct_" + envelope.error], envelopeMarkers),
          };
        if ("cancel" in envelope)
          return { ok: "fatal", error: T.errors.direct_editor_cancelled };
        return validateDiffs([envelope.diff]);
      }

      const c = candidate.completion;
      if (!c || c.tool !== "edit-complete")
        return { ok: "retryable", error: T.errors.editor_truncated };
      if (c.args.cancel === true)
        return { ok: "fatal", error: T.errors.editor_cancelled };

      const rewrite =
        typeof c.args.content === "string" ? c.args.content : undefined;
      if (rewrite !== undefined) {
        if (rewrite.trim() === "" && content.trim() !== "")
          return { ok: "retryable", error: T.errors.rewrite_empty };
        if (rewrite === content)
          return { ok: "retryable", error: T.errors.no_change };
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
      return validateDiffs(c.args.diffs);
    };

    let outcome: Attempt | undefined;
    let correctionsSent = 0;
    const res = await runSubagent({
      role: "editor",
      title: basename(resolve(opts.cwd, path)),
      systemPrompt: baseSystem,
      task: fmt(direct ? T.tasks.editor_direct : T.tasks.editor, {
        content: numbered,
        instruction: opts.instruction,
        ...envelopeMarkers,
      }),
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
      outputMode: direct ? "text" : "tool-call",
      maxOutputBytes: MAX_DIRECT_OUTPUT_BYTES,
      maxCorrectionTurns,
      onCandidate: (candidate) => {
        outcome = validateCandidate(candidate);
        if (
          outcome.ok === "retryable" &&
          correctionsSent < maxCorrectionTurns
        ) {
          correctionsSent++;
          return fmt(
            direct
              ? T.tasks.editor_direct_correction
              : T.tasks.editor_correction,
            { failure: outcome.error, ...envelopeMarkers },
          );
        }
        return undefined;
      },
    });
    usage = res.usage;
    if (res.timedOut)
      return {
        ok: false,
        error: fmt(T.errors.editor_timeout, { ms: opts.timeoutMs }),
        usage,
      };
    if (res.aborted) return { ok: false, error: T.errors.aborted, usage };
    if (res.spawnError)
      return {
        ok: false,
        error: fmt(T.errors.subagent_start_failed, { reason: res.spawnError }),
        usage,
      };
    if (!outcome) return { ok: false, error: T.errors.editor_truncated, usage };
    if (correctionsSent >= res.turns)
      return { ok: false, error: T.errors.editor_truncated, usage };
    if (
      outcome.ok === "retryable" &&
      maxCorrectionTurns > 0 &&
      correctionsSent === maxCorrectionTurns
    )
      return {
        ok: false,
        error: fmt(T.errors.editor_corrections_exhausted, {
          turns: maxCorrectionTurns,
          failure: outcome.error,
        }),
        usage,
      };
    if (outcome.ok !== "applied")
      return { ok: false, error: outcome.error, usage };
    return { ...outcome.result, usage };
  });
}
