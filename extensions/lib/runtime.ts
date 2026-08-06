/** Match pi's runtime: process.execPath avoids hard-coding bun across nvm/asdf/volta. */
export type RuntimeKind = "bun" | "node" | "deno";

export interface RuntimeSpawn {
  bin: string;
  pre: string[];
}

/** Required for Node 22.6–23.5; ≥23.6 enables strip-types by default. */
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
