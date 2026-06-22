/**
 * Role-gated completion tools for the Viewer/Editor subagents.
 *
 * Loaded in the llm-editor child via `-e` (alongside subagent-transcript, which
 * streams the live transcript, and cost-tree, which tallies cost). This module
 * owns the subagent handoff protocol; subagent-transcript owns only streaming.
 *
 * PI_SUBAGENT_ROLE narrows which tool registers (viewer->view-complete,
 * editor->edit-complete; unset registers both). The subagent ends its turn by
 * calling its completion tool, whose execute writes the structured args to
 * $PI_SUBAGENT_COMPLETION (a temp file the parent runSubagent reads back) and
 * returns terminate:true. The tool call IS the completion signal — a missing
 * completion file means the subagent never called its tool => truncation.
 *
 * edit-complete accepts diffs:string[] of unified-diff hunks, or content:string
 * holding the complete rewritten file, plus an optional cancel:bool. The
 * subagent's tool does not write files; the parent applies the result with
 * cpi's in-house atomic apply engine. All model-facing text lives in
 * extensions/text/llm-editor.toml ([completion.*]).
 *
 * Pure leaf: typebox + node:fs + ./text.ts (the shared TOML loader).
 */

import { writeFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadEditorText } from "./text.ts";
import {
  MAX_DIFF_BLOCKS,
  MAX_DIFF_BLOCK_BYTES,
  MAX_DIFF_TOTAL_BYTES,
} from "./udiff.ts";

const COMPLETION_PATH = process.env.PI_SUBAGENT_COMPLETION;

/** Persist the completion tool's structured args to the handoff file the
 *  llm-editor parent reads back (no stdout/JSONL reconstruction). Best-effort. */
function writeCompletion(tool: string, args: unknown): void {
  if (!COMPLETION_PATH) return;
  try {
    writeFileSync(COMPLETION_PATH, JSON.stringify({ tool, args }) + "\n");
  } catch {
    // best effort; never break the turn over the handoff write
  }
}

/** Coerce a JSON-string field into an array (Opus/GLM emit diffs/ranges as a
 *  JSON string). Runs in prepareArguments, BEFORE schema validation — mirroring
 *  pi's edit-tool prepareArguments. Mutates in place; leaves non-JSON strings so
 *  validation reports the real shape. */
function coerceArrayField(args: Record<string, unknown>, key: string): void {
  if (typeof args[key] !== "string") return;
  try {
    const p = JSON.parse(args[key] as string);
    if (Array.isArray(p)) args[key] = p;
  } catch {
    // not JSON; leave as-is
  }
}

export default function (pi: ExtensionAPI): void {
  if (!process.env.PI_SUBAGENT) return; // only in subagent children
  const T = loadEditorText();
  const role = process.env.PI_SUBAGENT_ROLE;

  if (!role || role === "viewer") {
    const parameters = Type.Object({
      ranges: Type.Array(
        Type.Object(
          {
            start: Type.Number({ description: T.completion.schema.range_start }),
            end: Type.Number({ description: T.completion.schema.range_end }),
          },
          { additionalProperties: false },
        ),
        { description: T.completion.schema.ranges },
      ),
    });
    pi.registerTool({
      name: "view-complete",
      label: "view-complete",
      promptSnippet: T.completion.view_complete.prompt_snippet,
      promptGuidelines: T.completion.view_complete.guidelines,
      description: T.completion.view_complete.description,
      parameters,
      prepareArguments(input: unknown): Static<typeof parameters> {
        if (input && typeof input === "object") coerceArrayField(input as Record<string, unknown>, "ranges");
        return input as Static<typeof parameters>;
      },
      async execute(_id: string, params: Static<typeof parameters>) {
        writeCompletion("view-complete", params);
        return { content: [{ type: "text", text: "done" }], details: undefined, terminate: true };
      },
    });
  }

  if (!role || role === "editor") {
    const parameters = Type.Object({
      diffs: Type.Optional(
        Type.Array(
          Type.String({ description: T.completion.schema.diff, maxLength: MAX_DIFF_BLOCK_BYTES }),
          {
            description: T.completion.schema.diffs,
            minItems: 1,
            maxItems: MAX_DIFF_BLOCKS,
          },
        ),
      ),
      // The escape hatch: when a hunk cannot be transcribed faithfully, the
      // whole new file needs no matching at all (SWE-Edit §3.1's rewrite mode).
      content: Type.Optional(
        Type.String({
          description: T.completion.schema.content,
          maxLength: MAX_DIFF_TOTAL_BYTES,
        }),
      ),
      cancel: Type.Optional(Type.Boolean({ description: T.completion.schema.cancel })),
    });
    pi.registerTool({
      name: "edit-complete",
      label: "edit-complete",
      promptSnippet: T.completion.edit_complete.prompt_snippet,
      promptGuidelines: T.completion.edit_complete.guidelines,
      description: T.completion.edit_complete.description,
      parameters,
      prepareArguments(input: unknown): Static<typeof parameters> {
        if (input && typeof input === "object") coerceArrayField(input as Record<string, unknown>, "diffs");
        return input as Static<typeof parameters>;
      },
      async execute(_id: string, params: Static<typeof parameters>) {
        writeCompletion("edit-complete", params);
        return {
          content: [{ type: "text", text: params.cancel ? "cancelled" : "applying" }],
          details: undefined,
          terminate: true,
        };
      },
    });
  }

}
