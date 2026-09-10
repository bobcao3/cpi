/**
 * Keeps the model oriented to the working directory: set_cwd changes cpi's
 * logical context cwd and delivers reminders after the tool result or turn.
 *
 * cpi tools and prompts consume this logical cwd, making it safe for
 * worker-isolated subagents. Limitation: pi's immutable SDK cwd and resource
 * discovery do not automatically follow; the reminder carries truth.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { discardQueuedMessages } from "./lib/prepend-message.ts";
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

import { compactedNotificationFilter } from "./lib/compaction-display.ts";

export { getCwd, resolveCwdPath } from "./lib/cwd.ts";

const CWD_TOOL = "set_cwd";
const REMINDER_TYPE = "cwd-reminder";
const STATE_ENTRY = "cwd-state";
const BOUNDARY_STEP = 25;
const BOUNDARY_KEY = "__cpiCwdBoundary";

interface BoundaryState {
  last: number;
  pending?: { cwd: string; reason: string };
}

function boundary(): BoundaryState {
  const g = globalThis as Record<string, unknown>;
  const b = g[BOUNDARY_KEY] as BoundaryState | undefined;
  if (b && typeof b === "object") return b;
  const fresh = { last: 0 };
  g[BOUNDARY_KEY] = fresh;
  return fresh;
}

function applyCwd(pi: ExtensionAPI, target: string, reason: string): void {
  setCwd(target);
  pi.appendEntry(STATE_ENTRY, { cwd: target });
  boundary().pending = { cwd: target, reason };
}

function reminderContent(cwd: string, reason?: string): string {
  const text = loadText<{ reminder: { content: string } }>(
    "cwd",
    textPath("cwd"),
  );
  return render(text.reminder.content, { cwd, reason });
}

function deliverReminder(pi: ExtensionAPI, cwd: string, reason?: string): void {
  pi.sendMessage(
    {
      customType: REMINDER_TYPE,
      content: reminderContent(cwd, reason),
      display: true,
      details: { cwd, reason },
    },
    { triggerTurn: false },
  );
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
  const compacted = compactedNotificationFilter(pi);
  pi.registerMessageRenderer(REMINDER_TYPE, (message, _options, theme) => {
    const hidden = compacted(message);
    if (hidden) return hidden;
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
  discardQueuedMessages(REMINDER_TYPE);
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
        details: {
          cwd: target,
          newAgentsFiles: newAgents.map((f) => f.path),
          referenceDocuments: newAgents.map((file) => ({
            kind: "project",
            path: file.path,
          })),
        },
      };
    },
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage?.();
    const b = boundary();
    if (b.pending) {
      const pending = b.pending;
      delete b.pending;
      if (usage?.percent != null) {
        b.last = Math.max(b.last, Math.floor(usage.percent / BOUNDARY_STEP));
      }
      deliverReminder(pi, pending.cwd, pending.reason);
      return;
    }
    if (!usage || usage.percent == null) return;
    const crossed = Math.floor(usage.percent / BOUNDARY_STEP);
    if (crossed > b.last && crossed >= 1) {
      b.last = crossed;
      deliverReminder(pi, getCwd());
    }
  });

  // Compaction drops token count — reset so boundaries re-fire as it refills
  pi.on("session_compact", async () => {
    boundary().last = 0;
  });

  pi.on("context", (event, ctx) => {
    let represented = ctx.cwd;
    for (const message of event.messages) {
      if (
        message.role !== "custom" ||
        (message.customType !== REMINDER_TYPE &&
          message.customType !== "cpi-context-checkpoint")
      )
        continue;
      const details = message.details as { cwd?: string } | undefined;
      if (typeof details?.cwd === "string") represented = details.cwd;
    }
    const cwd = getCwd();
    if (represented !== cwd)
      return {
        messages: [
          ...event.messages,
          {
            role: "custom" as const,
            customType: REMINDER_TYPE,
            content: reminderContent(cwd),
            display: false,
            details: { cwd },
            timestamp: event.messages.at(-1)?.timestamp ?? 0,
          },
        ],
      };
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreFromSession(ctx);
    seedAgentsContext(getCwd());
    boundary().last = 0;
    delete boundary().pending;
    ensureToolActive(pi);
  });

  pi.on("resources_discover", async () => {
    ensureToolActive(pi);
  });
}
