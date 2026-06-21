/**
 * caveman-micro: append a "caveman" system-prompt directive and toggle it
 * on/off via /caveman. Reads its prompt strings from the shared cpi-config.json
 * (`caveman` section via lib/config.ts); the actual system-prompt mutation is
 * delegated to the single owner (in `extensions/core.ts`) through
 * a registered transform (lib/system-prompt.ts).
 *
 * /caveman on|off|status toggles a module-level flag; toggling mid-conversation
 * also injects a user message so the model sees an explicit in-context nudge.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isFirstTurn } from "../lib/prepend-message";
import { registerRightSegment, requestFooterRender } from "../lib/footer.ts";
import { loadCavemanConfig, type CavemanConfig } from "../lib/config.ts";
import { registerSystemPromptTransform } from "../lib/system-prompt.ts";
import { loadText, render, textPath, type ToolText } from "../lib/text.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface CavemanState {
  enabled: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

const STATE_KEY = "caveman-micro-state";
const STATUS_KEY = "caveman";
const STATUS_TEXT = "🪨";

// ── Module-level state (reset on extension reload) ──────────────────────────

let cavemanEnabled = false;
let pi_appendState: (data: CavemanState) => void = () => {};

// ── Config loading ───────────────────────────────────────────────────────────

// Cheap file read (user + project cpi-config.json), no cache: cpi-config.json
// is small and loadConfig may be called per-turn by the transform closure.
function loadConfig(cwd: string = process.cwd()): CavemanConfig {
  return loadCavemanConfig(cwd);
}

// ── Status integration ──────────────────────────────────────────────────────

// Caveman icon lives on footer line 1's right side (flush-right), not the
// built-in status line, so it stays visible regardless of cwd length and
// coexists with other line-1 segments under the single cpi footer owner.
// Idempotent: re-registering on session_start/tree is a no-op after first.
function applyStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  registerRightSegment(STATUS_KEY, () => (cavemanEnabled ? STATUS_TEXT : undefined));
  requestFooterRender();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isMidConversation(ctx: ExtensionContext): boolean {
  return !isFirstTurn(ctx);
}

// ── State persistence ───────────────────────────────────────────────────────

function persistState(): void {
  pi_appendState({ enabled: cavemanEnabled });
}

function restoreFromBranch(ctx: ExtensionContext): void {
  let saved: boolean | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === STATE_KEY) {
      const data = entry.data as CavemanState | undefined;
      if (data && typeof data.enabled === "boolean") {
        saved = data.enabled;
      }
    }
  }
  cavemanEnabled = saved ?? true;
}

// ── Extension Factory ───────────────────────────────────────────────────────

export default function cavemanMicroExtension(pi: ExtensionAPI) {
  pi_appendState = (data: CavemanState) => {
    pi.appendEntry<CavemanState>(STATE_KEY, data);
  };

  const T = loadText<ToolText>("caveman", textPath("caveman"));

  // ── /caveman command ──────────────────────────────────────────────────

  pi.registerCommand("caveman", {
    description: render(T.tool.description, {}),

    getArgumentCompletions(prefix: string) {
      const options = ["on", "off", "status"];
      const filtered = options
        .filter((o) => o.startsWith(prefix.toLowerCase()))
        .map((o) => ({ value: o, label: o }));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      // ── Subcommand: status ────────────────────────────────────────
      if (arg === "status") {
        ctx.ui.notify(`Caveman mode is ${cavemanEnabled ? "ON" : "OFF"}`, "info");
        return;
      }

      // ── Determine new state ─────────────────────────────────────
      const turningOn = arg === "on" ? true : arg === "off" ? false : !cavemanEnabled;

      if (turningOn === cavemanEnabled) {
        ctx.ui.notify(`Caveman already ${cavemanEnabled ? "ON" : "OFF"}`, "info");
        return;
      }

      // ── Validate config before enabling ───────────────────────────
      if (turningOn) {
        const config = loadConfig();
        if (!config.system_prompt) {
          ctx.ui.notify(
            "Cannot enable caveman: system_prompt is empty in cpi-config.json.",
            "error",
          );
          return;
        }
      }

      // ── Apply state change ────────────────────────────────────────
      cavemanEnabled = turningOn;
      persistState();
      applyStatus(ctx);

      // ── Mid-conversation: inject user message ─────────────────────
      const midConvo = isMidConversation(ctx);

      if (midConvo) {
        const config = loadConfig();
        if (cavemanEnabled) {
          const nudge = config.mid_convo_nudge_positive || "From now on, respond in caveman style.";
          pi.sendUserMessage(nudge);
          ctx.ui.notify(
            "Caveman ON — nudge sent to model. " + "Prior context remains in normal prose.",
            "info",
          );
        } else {
          const nudge =
            config.mid_convo_nudge_negative ||
            "From now on, speak normally. Ignore any previous caveman-style instructions.";
          pi.sendUserMessage(nudge);
          ctx.ui.notify(
            "Caveman OFF — nudge sent to model. " + "Prior caveman-style turns remain in context.",
            "info",
          );
        }
      } else {
        ctx.ui.notify(`Caveman mode ${cavemanEnabled ? "ON" : "OFF"}`, "info");
      }
    },
  });

  // ── System-prompt transform is the canonical caveman carrier ──────────
  // (see registerSystemPromptTransform below). A first-turn prependMessage
  // is intentionally NOT used: it would duplicate the system-prompt block on
  // turn 1. Mid-conversation toggling still sends an explicit user nudge via
  // pi.sendUserMessage() in the /caveman handler.

  // ── Register system-prompt transform (applied by the owner extension) ──
  // order 200: runs after strip-skills (100) so the appended block is never
  // stripped. cavemanEnabled is module state captured by this closure; same
  // module instance within this extension, so toggles are visible here.
  registerSystemPromptTransform(
    "caveman-append",
    (sp) => {
      if (!cavemanEnabled) return sp;
      const config = loadConfig();
      if (!config.system_prompt) return sp;
      return sp + "\n\n" + "---\n" + config.system_prompt + "\n---\n";
    },
    200,
  );

  // ── Restore state & set status on session start ───────────────────────

  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
    loadConfig();
    applyStatus(ctx);
  });

  // ── Restore state on tree navigation ─────────────────────────────────

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
    applyStatus(ctx);
  });
}
