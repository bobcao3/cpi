/**
 * CWD extension
 *
 * Keeps the model oriented to the working directory as context grows and as
 * it moves between trees:
 *
 *   - Registers a `set_cwd` tool. Executing it `setCwd()`s (process.chdir)
 *     to the target and queues a `<system-reminder>` of the new CWD to land
 *     right after the tool result, before the next LLM call (deliverAs
 *     "afterToolResult").
 *   - Tracks context-window usage; each time usage crosses a 25% boundary
 *     (25 / 50 / 75) it queues a `<system-reminder>` of the current CWD to
 *     land before the next user interaction (deliverAs "beforeUser").
 *
 * Both reminders go through the shared prepend-message queue
 * (lib/prepend-message.ts `queueMessage`), exercising its two drain points.
 *
 * Why process.chdir: the cpi shell tool spawns `bash -c` with no cwd, so it
 * inherits process.cwd(). pi exposes no public API to mutate its captured
 * `_cwd`, and built-in read/write/edit are disabled in cpi, so the shell is
 * the only path-sensitive tool — process.chdir is the minimal consistent
 * lever. Limitation: pi's system-prompt "Current working directory" line and
 * AGENTS.md discovery do not follow; the `<system-reminder>` carries the
 * truth instead.
 *
 * Public API (re-exported for other cpi tools): `getCwd()` returns the live
 * cwd following set_cwd; `resolveCwdPath()` resolves a path against it.
 * Source of truth lives in lib/cwd.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { queueMessage } from "./lib/prepend-message.ts";
import { getCwd, resolveCwdPath, setCwd } from "./lib/cwd.ts";
import { discoverAgentsFiles, formatAgentsBlock, type AgentsFile } from "./lib/agents.ts";

// Re-export the live-cwd API so other tools import it from the cwd feature.
export { getCwd, resolveCwdPath } from "./lib/cwd.ts";

const CWD_TOOL = "set_cwd";
const REMINDER_TYPE = "cwd-reminder";
const STATE_ENTRY = "cwd-state";
const BOUNDARY_STEP = 25; // percent of context window
const BOUNDARY_KEY = "__cpiCwdBoundary";
const SEEN_AGENTS_KEY = "__cpiCwdSeenAgents";

/**
 * Paths of AGENTS.md/CLAUDE.md files already seen by the agent — seeded
 * from pi's startup context (the old cwd's tree) and grown each set_cwd.
 * Backed by globalThis so it survives jiti extension reloads.
 */
function seenAgents(): Set<string> {
  const g = globalThis as Record<string, unknown>;
  const existing = g[SEEN_AGENTS_KEY] as Set<string> | undefined;
  if (existing instanceof Set) return existing;
  const fresh = new Set<string>();
  g[SEEN_AGENTS_KEY] = fresh;
  return fresh;
}

/**
 * AGENTS.md files in `target`'s tree not already in the agent's context.
 * Seeds the seen set with the old cwd's tree (pi's startup snapshot) so
 * already-loaded ancestors are not re-surfaced. Mutates seen to include
 * the returned files.
 */
function newAgentsForTarget(oldCwd: string, target: string): AgentsFile[] {
  const seen = seenAgents();
  for (const f of discoverAgentsFiles(oldCwd)) seen.add(f.path);
  const surfaced = discoverAgentsFiles(target).filter((f) => !seen.has(f.path));
  for (const f of surfaced) seen.add(f.path);
  return surfaced;
}

function boundary(): { last: number } {
  const g = globalThis as Record<string, unknown>;
  const b = g[BOUNDARY_KEY] as { last: number } | undefined;
  if (b && typeof b === "object") return b;
  const fresh = { last: 0 };
  g[BOUNDARY_KEY] = fresh;
  return fresh;
}

function applyCwd(pi: ExtensionAPI, target: string, reason: string): void {
  setCwd(target);
  pi.appendEntry(STATE_ENTRY, { cwd: target });
  queueMessage({
    customType: REMINDER_TYPE,
    content: `system-reminder | Current cwd=${target} (${reason})`,
    display: true,
    details: { cwd: target, reason },
    deliverAs: "afterToolResult",
  });
}

function enqueueBoundaryReminder(pi: ExtensionAPI): void {
  const cwd = getCwd();
  queueMessage({
    customType: REMINDER_TYPE,
    content: `system reminder | Current cwd=${cwd}`,
    display: true,
    details: { cwd, reason: "context-threshold" },
    deliverAs: "beforeUser",
  });
}

function restoreFromSession(ctx: { sessionManager: { getEntries: () => any[] } }): void {
  let last: string | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry?.type === "custom" && entry?.customType === STATE_ENTRY && entry?.data?.cwd) {
      last = entry.data.cwd as string;
    }
  }
  if (!last) return;
  try {
    if (statSync(last).isDirectory()) setCwd(last);
  } catch {
    // path gone — keep launch cwd
  }
}

function ensureToolActive(pi: ExtensionAPI): void {
  const active = new Set(pi.getActiveTools());
  active.add(CWD_TOOL);
  pi.setActiveTools(Array.from(active));
}

function registerReminderRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(REMINDER_TYPE, (message, _options, theme) => {
    const d = (message.details ?? {}) as { cwd?: string };
    const cwd = d.cwd ?? "";
    return new Text(`${theme.fg("muted", "📂")} ${theme.fg("muted", cwd)}`, 0, 0);
  });
}

const cwdSchema = Type.Object({
  path: Type.String({
    description: "Target directory, absolute, or relative to cwd",
  }),
});

export default function (pi: ExtensionAPI): void {
  registerReminderRenderer(pi);

  pi.registerTool({
    name: CWD_TOOL,
    label: "Set cwd",
    description:
      "Change the cwd for all subsequent tool calls or shell commands.",
    promptSnippet: "Change the cwd for all subsequent tool calls or shell commands.",
    promptGuidelines: [
      "Use set_cwd when the user asks to switch projects, or when work has clearly moved to a different tree, and the current CWD is no longer the right root for shell commands.",
      "You should use set_cwd when you repeatedly need to prepend `cd path/to/prject && ...` in shell"
    ],
    parameters: cwdSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const target = resolveCwdPath(params.path);
      try {
        if (!statSync(target).isDirectory()) {
          return {
            content: [{ type: "text", text: `not a directory: ${target}` }],
            details: { cwd: getCwd() },
            isError: true,
          };
        }
      } catch {
        return {
          content: [{ type: "text", text: `path not found: ${target}` }],
          details: { cwd: getCwd() },
          isError: true,
        };
      }
      const oldCwd = getCwd();
      const newAgents = newAgentsForTarget(oldCwd, target);
      applyCwd(pi, target, `changed via ${CWD_TOOL}`);
      let text = `working directory: ${target}`;
      text += formatAgentsBlock(newAgents);
      return {
        content: [{ type: "text", text }],
        details: { cwd: target, newAgentsFiles: newAgents.map((f) => f.path) },
      };
    },
  });

  // 25% context-window boundary → queue CWD reminder before next user interaction
  pi.on("message_end", async (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    const usage = ctx.getContextUsage?.();
    if (!usage || usage.percent == null) return;
    const b = boundary();
    const crossed = Math.floor(usage.percent / BOUNDARY_STEP);
    if (crossed > b.last && crossed >= 1) {
      b.last = crossed;
      enqueueBoundaryReminder(pi);
    }
  });

  // Compaction drops token count — reset so boundaries re-fire as it refills
  pi.on("session_compact", async () => {
    boundary().last = 0;
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreFromSession(ctx);
    boundary().last = 0;
    ensureToolActive(pi);
  });

  pi.on("resources_discover", async () => {
    ensureToolActive(pi);
  });
}
