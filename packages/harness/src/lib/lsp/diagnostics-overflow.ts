/**
 * Contract: inline up to the cap; on overflow persist the full diagnostics
 * and return its path, falling back to capped inline output if persistence fails.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Diagnostic, formatDiagnostics } from "./diagnostics.ts";
import { getSessionDir } from "../session-dir.ts";

export const DIAGNOSTICS_INLINE_CAP = 3;

export interface RenderDiagnosticsOptions {
  cap?: number;
  sessionDir?: string;
}

export interface RenderedDiagnostics {
  text: string;
  fullPath?: string;
}

function assertCap(cap: unknown): asserts cap is number {
  if (!(Number.isInteger(cap) && (cap as number) > 0)) {
    throw new Error(
      `renderDiagnostics: cap must be a positive int, got ${String(cap)}`,
    );
  }
}

function overflowPath(sessionDir: string | undefined): {
  path: string;
  makeDir: boolean;
} {
  const base = sessionDir ?? tmpdir();
  const name = `pi-lsp-diags-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
  if (sessionDir)
    return { path: join(base, "lsp-diagnostics", name), makeDir: true };
  return { path: join(base, name), makeDir: false };
}

export async function renderDiagnostics(
  diags: Diagnostic[],
  opts: RenderDiagnosticsOptions = {},
): Promise<RenderedDiagnostics> {
  if (!Array.isArray(diags)) {
    throw new Error("renderDiagnostics: diags must be an array");
  }
  if (diags.length === 0) return { text: "" };
  const cap = opts.cap ?? DIAGNOSTICS_INLINE_CAP;
  assertCap(cap);
  if (diags.length <= cap) {
    return { text: formatDiagnostics(diags, { max: cap }) };
  }
  const full = formatDiagnostics(diags, { max: diags.length });
  const { path, makeDir } = overflowPath(opts.sessionDir ?? getSessionDir());
  try {
    if (makeDir) await mkdir(dirname(path), { recursive: true });
    await writeFile(path, full, "utf8");
  } catch {
    return { text: formatDiagnostics(diags, { max: cap }) };
  }
  const head = formatDiagnostics(diags.slice(0, cap), { max: cap });
  return {
    text: `${head}\n…and ${diags.length - cap} more — full: ${path}`,
    fullPath: path,
  };
}
