import { createHash } from "node:crypto";

export interface ShaArgs {
  command?: string;
  path: string;
  query?: string;
  instruction?: string;
  file_text?: string;
}

/** 8-hex id: sha256 of the call's args (first 4 bytes); identical args ⇒ identical id, so a re-run overwrites the same transcript slot. */
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
