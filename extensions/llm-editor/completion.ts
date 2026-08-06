/** Tool calls write structured args; a missing completion file indicates truncation. */

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

function writeCompletion(tool: string, args: unknown): void {
  if (!COMPLETION_PATH) return;
  try {
    writeFileSync(COMPLETION_PATH, JSON.stringify({ tool, args }) + "\n");
  } catch {}
}

function coerceArrayField(args: Record<string, unknown>, key: string): void {
  if (typeof args[key] !== "string") return;
  try {
    const p = JSON.parse(args[key] as string);
    if (Array.isArray(p)) args[key] = p;
  } catch {}
}

export default function (pi: ExtensionAPI): void {
  if (!process.env.PI_SUBAGENT) return;
  const T = loadEditorText();
  const role = process.env.PI_SUBAGENT_ROLE;

  if (!role || role === "viewer") {
    const parameters = Type.Object({
      ranges: Type.Array(
        Type.Object(
          {
            start: Type.Number({
              description: T.completion.schema.range_start,
            }),
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
        if (input && typeof input === "object")
          coerceArrayField(input as Record<string, unknown>, "ranges");
        return input as Static<typeof parameters>;
      },
      async execute(_id: string, params: Static<typeof parameters>) {
        writeCompletion("view-complete", params);
        return {
          content: [{ type: "text", text: "done" }],
          details: undefined,
          terminate: true,
        };
      },
    });
  }

  if (!role || role === "editor") {
    const parameters = Type.Object({
      diffs: Type.Optional(
        Type.Array(
          Type.String({
            description: T.completion.schema.diff,
            maxLength: MAX_DIFF_BLOCK_BYTES,
          }),
          {
            description: T.completion.schema.diffs,
            minItems: 1,
            maxItems: MAX_DIFF_BLOCKS,
          },
        ),
      ),
      content: Type.Optional(
        Type.String({
          description: T.completion.schema.content,
          maxLength: MAX_DIFF_TOTAL_BYTES,
        }),
      ),
      cancel: Type.Optional(
        Type.Boolean({ description: T.completion.schema.cancel }),
      ),
    });
    pi.registerTool({
      name: "edit-complete",
      label: "edit-complete",
      promptSnippet: T.completion.edit_complete.prompt_snippet,
      promptGuidelines: T.completion.edit_complete.guidelines,
      description: T.completion.edit_complete.description,
      parameters,
      prepareArguments(input: unknown): Static<typeof parameters> {
        if (input && typeof input === "object")
          coerceArrayField(input as Record<string, unknown>, "diffs");
        return input as Static<typeof parameters>;
      },
      async execute(_id: string, params: Static<typeof parameters>) {
        writeCompletion("edit-complete", params);
        return {
          content: [
            { type: "text", text: params.cancel ? "cancelled" : "applying" },
          ],
          details: undefined,
          terminate: true,
        };
      },
    });
  }
}
