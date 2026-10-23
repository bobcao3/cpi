/**
 * Contract: inline up to the cap; on overflow persist the full diagnostics
 * and return its path, falling back to capped inline output if persistence fails.
 */

import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type Diagnostic, formatDiagnostics } from "./diagnostics.ts";
import {
  inheritedSessionOwner,
  sessionArtifactDirectory,
  type SessionOwner,
} from "../storage/owner.ts";
import { storage_directory } from "../storage/paths.ts";

export const DIAGNOSTICS_INLINE_CAP = 3;

export interface RenderDiagnosticsOptions {
  cap?: number;
  owner?: SessionOwner;
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
  const owner = opts.owner ?? inheritedSessionOwner();
  let path: string | undefined;
  let created = false;
  try {
    const directory = owner
      ? sessionArtifactDirectory(owner, "lsp-diagnostics")
      : storage_directory("state", "lsp-diagnostics");
    path = join(directory, `diagnostics-${randomUUID()}.log`);
    const handle = await open(path, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(full, "utf8");
    } finally {
      await handle.close();
    }
  } catch {
    if (created && path) await unlink(path).catch(() => {});
    return { text: formatDiagnostics(diags, { max: cap }) };
  }
  const head = formatDiagnostics(diags.slice(0, cap), { max: cap });
  return {
    text: `${head}\n…and ${diags.length - cap} more — full: ${path}`,
    fullPath: path,
  };
}
