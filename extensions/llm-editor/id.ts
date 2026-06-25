/**
 * Content-addressed id for one view/edit/create tool call.
 *
 * `shortSha` hashes the call's input args (command, path, query/instruction/
 * file_text) to a short hex digest. It is:
 *   - deterministic: identical args ⇒ identical id (so a re-run of the same
 *     view/edit overwrites the same transcript slot, not a new file).
 *   - per-call: differs across distinct calls (command/path/text vary).
 *
 * The id is the `<id>` field in every result and the filename of the persisted
 * subagent transcript (`<dir>/<id>.md`), letting the agent resolve a result to
 * its transcript via the path convention stated in the system prompt.
 *
 * Pure leaf: node:crypto only.
 */

import { createHash } from "node:crypto";

export interface ShaArgs {
  command?: string;
  path: string;
  query?: string;
  instruction?: string;
  file_text?: string;
}

/** 8-hex short-sha of the args (sha256, first 4 bytes). */
export function shortSha(args: ShaArgs): string {
  const payload = JSON.stringify({
    command: args.command ?? "",
    path: args.path,
    query: args.query ?? "",
    instruction: args.instruction ?? "",
    file_text: args.file_text ?? "",
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 8);
}
