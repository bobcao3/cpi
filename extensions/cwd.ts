/**
 * Keeps the model oriented to the working directory: set_cwd chdir()s and
 * queues a <system-reminder> after the tool result; at each 25% context
 * boundary a reminder lands before the next user turn.
 *
 * Why process.chdir: the shell inherits process.cwd() and pi exposes no API
 * to mutate its own cwd. Limitation: pi's system-prompt cwd line and
 * AGENTS.md discovery don't follow; the reminder carries the truth.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { queueMessage } from "./lib/prepend-message.ts";
import { getCwd, resolveCwdPath, setCwd } from "./lib/cwd.ts";
import {
  formatAgentsBlock,
  seedAgentsContext,
  surfaceNewAgents,
} from "./lib/agents.ts";
import {
  loadText,
  render,
  renderLines,
  textPath,
  type ToolText,
} from "./lib/text.ts";

export { getCwd, resolveCwdPath } from "./lib/cwd.ts";

const CWD_TOOL = "set_cwd";
const REMINDER_TYPE = "cwd-reminder";
const STATE_ENTRY = "cwd-state";
const BOUNDARY_STEP = 25;
const BOUNDARY_KEY = "__cpiCwdBoundary";

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
    content: `system reminder | Current cwd: ${target} (${reason})`,
    display: true,
    details: { cwd: target, reason },
    deliverAs: "afterToolResult",
  });
}

function enqueueBoundaryReminder(pi: ExtensionAPI): void {
  const cwd = getCwd();
  queueMessage({
    customType: REMINDER_TYPE,
    content: `system reminder | Current cwd: ${cwd}`,
    display: true,
    details: { cwd },
    deliverAs: "beforeUser",
  });
}

function restoreFromSession(ctx: {
  sessionManager: { getEntries: () => any[] };
}): void {
  let last: string | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry?.type === "custom" &&
      entry?.customType === STATE_ENTRY &&
      entry?.data?.cwd
    ) {
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
    return new Text(
      `${theme.fg("muted", "📂")} ${theme.fg("muted", cwd)}`,
      0,
      0,
    );
  });
}

export default function (pi: ExtensionAPI): void {
  registerReminderRenderer(pi);

  const T = loadText<ToolText>("cwd", textPath("cwd"));
  const guidelines = renderLines(T.guidelines.bullets, {});
  const cwdSchema = Type.Object({
    path: Type.String({ description: T.schema!.path }),
  });

  pi.registerTool({
    name: CWD_TOOL,
    label: "Set cwd",
    description: render(T.tool.description, {}),
    promptSnippet: T.tool.prompt_snippet,
    promptGuidelines: guidelines,
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
      const newAgents = surfaceNewAgents(target);
      applyCwd(pi, target, `changed via ${CWD_TOOL}`);
      let text = `working directory: ${target}`;
      text += formatAgentsBlock(newAgents);
      return {
        content: [{ type: "text", text }],
        details: { cwd: target, newAgentsFiles: newAgents.map((f) => f.path) },
      };
    },
  });

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
    seedAgentsContext(getCwd());
    boundary().last = 0;
    ensureToolActive(pi);
  });

  pi.on("resources_discover", async () => {
    ensureToolActive(pi);
  });
}
