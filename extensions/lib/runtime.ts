/**
 * Detects the JS runtime driving pi (bun/node/deno) so the sh-monitor supervisor
 * is spawned with the SAME runtime that's running pi — never a hard-coded "bun".
 * `process.execPath` is the exact binary running pi, so a pi launched via
 * nvm/asdf/volta re-uses that same binary for the child supervisor.
 *
 * sh-monitor.ts is pure `node:` builtins + typebox (strip-only compatible), so it
 * runs under any of the three once invoked with the right argv:
 *
 *   bun  <file>                  — runs .ts natively
 *   node <file>                  — type stripping (node ≥23.6 default; the flag
 *                                  below also covers 22.6–23.5)
 *   deno run --allow-all <file>  — TS native, but sh-monitor spawns arbitrary
 *                                  shells and binds a resume socket, so it needs
 *                                  broad perms — `-A` grants exactly that for our
 *                                  own trusted supervisor
 *
 * Used only pi-side (the launcher). sh-monitor itself never spawns a JS runtime.
 */
export type RuntimeKind = "bun" | "node" | "deno";

export interface RuntimeSpawn {
  /** Absolute path to the runtime binary driving pi (process.execPath). */
  bin: string;
  /** Argv inserted before the target .ts file path. */
  pre: string[];
}

const NODE_STRIP_FLAG = "--experimental-strip-types";

/** Which runtime is running this process. `globalThis.Bun`/`Deno` are canonical. */
export function detectRuntime(): RuntimeKind {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.Bun !== "undefined") return "bun";
  if (typeof g.Deno !== "undefined") return "deno";
  return "node";
}

/** Args to run a .ts entry under whatever runtime is driving pi. */
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
