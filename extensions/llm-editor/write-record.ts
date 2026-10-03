import type { DiffOp } from "./diff.ts";

export interface WriteDetails {
  kind?: "edit" | "create" | "error";
  path?: string;
  diffOps?: DiffOp[];
  hunks?: number;
  rewrite?: boolean;
  bytes?: number;
  message?: string;
  failure?: unknown;
}
export interface WriteValue {
  details?: WriteDetails;
  content?: readonly { type: string; text?: string }[];
}
export interface WriteMember {
  id: string;
  command: string;
  path?: string;
  result?: WriteValue;
  isError: boolean;
  stream?: string[];
  limited?: boolean;
}

export function is_write_action(name: string): boolean {
  return name === "write" || name === "edit" || name === "apply_patch";
}

export function stream_tail(text: string): string[] {
  return text
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "" && !/^(jsonl:|summary:)/.test(line))
    .slice(-5)
    .map((line) => line.slice(0, 4096));
}
