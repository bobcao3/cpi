/** Spawn the sh-monitor supervisor with the same runtime as pi — never a hard-coded "bun": process.execPath is the exact binary driving pi (nvm/asdf/volta). */
export type RuntimeKind = "bun" | "node" | "deno";

export interface RuntimeSpawn {
  bin: string;
  pre: string[];
}

/** node 22.6–23.5 strip types only with this flag; ≥23.6 defaults it on. */
const NODE_STRIP_FLAG = "--experimental-strip-types";

export function detectRuntime(): RuntimeKind {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.Bun !== "undefined") return "bun";
  if (typeof g.Deno !== "undefined") return "deno";
  return "node";
}

export function runtimeSpawn(): RuntimeSpawn {
  const bin = process.execPath;
  switch (detectRuntime()) {
    case "bun":
      return { bin, pre: [] };
    case "deno":
      return { bin, pre: ["run", "--allow-all"] };
    case "node":
      return { bin, pre: [NODE_STRIP_FLAG] };
  }
}
