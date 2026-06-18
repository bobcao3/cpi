/**
 * Caveman Micro Extension for Pi
 *
 * Toggles the "caveman-micro" token-compression prompt style on/off.
 * Enabled by default; a rock indicator (🪨) is shown in the footer's
 * extension-status line while enabled.
 *
 * Why a status line and not a custom footer: pi allows only one custom
 * footer at a time (setFooter replaces). Owning the footer here collided
 * with the shell extension's footer, so one indicator always won. Using
 * ctx.ui.setStatus() lets every footer (built-in or custom) render the
 * marker with no ownership conflict.
 *
 * Commands:
 *   /caveman           Toggle caveman mode on/off
 *   /caveman on        Enable explicitly
 *   /caveman off       Disable explicitly
 *   /caveman status    Show current state
 *
 * Configuration is read from caveman-micro.yaml (next to this index.ts).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { prependMessage, isFirstTurn } from "../lib/prepend-message";

// ── Types ──────────────────────────────────────────────────────────────────

interface CavemanState {
  enabled: boolean;
}

interface CavemanConfig {
  system_prompt: string;
  mid_convo_nudge_positive: string;
  mid_convo_nudge_negative: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const STATE_KEY = "caveman-micro-state";
const CONFIG_FILE = "caveman-micro.yaml";
const STATUS_KEY = "caveman";
const STATUS_TEXT = "🪨";

// ── Module-level state (reset on extension reload) ──────────────────────────

let cavemanEnabled = true;
let cachedConfig: CavemanConfig | null = null;
let pi_appendState: (data: CavemanState) => void = () => {};

// ── Config loading ───────────────────────────────────────────────────────────

function getExtensionDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    const dir = (globalThis as Record<string, unknown>).__dirname;
    if (typeof dir === "string") return dir;
    return process.cwd();
  }
}

function loadYAMLLib(): ((input: string) => unknown) | null {
  try {
    const piBin = realpathSync(process.argv[1] || "");
    let dir = dirname(piBin);
    for (let i = 0; i < 20 && dir !== "/" && dir !== "."; i++) {
      const scopedPkg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
      if (existsSync(scopedPkg)) {
        const req = createRequire(join(scopedPkg, "dist", "index.js"));
        const yamlMod = req("yaml");
        return typeof yamlMod.parse === "function" ? yamlMod.parse : null;
      }
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  return null;
}

function loadConfig(): CavemanConfig {
  if (cachedConfig !== null) return cachedConfig;

  const configPath = join(getExtensionDir(), CONFIG_FILE);
  const empty = {
    system_prompt: "",
    mid_convo_nudge_positive: "",
    mid_convo_nudge_negative: "",
  };

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    console.error(`[caveman-micro] Failed to read ${configPath}:`, err);
    cachedConfig = empty;
    return cachedConfig;
  }

  const yamlParse = loadYAMLLib();
  if (!yamlParse) {
    console.error("[caveman-micro] yaml package not found");
    cachedConfig = empty;
    return cachedConfig;
  }

  try {
    const parsed = yamlParse(raw) as Record<string, unknown>;
    cachedConfig = {
      system_prompt: String(parsed.system_prompt ?? ""),
      mid_convo_nudge_positive: String(parsed.mid_convo_nudge_positive ?? ""),
      mid_convo_nudge_negative: String(parsed.mid_convo_nudge_negative ?? ""),
    };
  } catch (err) {
    console.error("[caveman-micro] Failed to parse config:", err);
    cachedConfig = empty;
  }
  return cachedConfig;
}

// ── Status integration ──────────────────────────────────────────────────────

function applyStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, cavemanEnabled ? STATUS_TEXT : undefined);
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

  // ── /caveman command ──────────────────────────────────────────────────

  pi.registerCommand("caveman", {
    description: "Toggle caveman-micro compression on/off (or: /caveman on|off|status)",

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
            "Cannot enable caveman: system_prompt is empty in " +
              CONFIG_FILE +
              ". Check the extension directory.",
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

  // ── Prepend nudge before first user message ──────────────────────

  prependMessage(pi, {
    customType: "caveman-micro-nudge",
    content: loadConfig().mid_convo_nudge_positive || "From now on, respond in caveman style.",
    when: isFirstTurn,
    once: true,
  });

  // ── Inject caveman prompt into system prompt ──────────────────────────

  pi.on("before_agent_start", async (event) => {
    if (!cavemanEnabled) return undefined;

    const config = loadConfig();
    if (!config.system_prompt) return undefined;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + "---\n" + config.system_prompt + "\n---\n",
    };
  });

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
