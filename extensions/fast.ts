import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  clearRightSegment,
  registerRightSegment,
  requestFooterRender,
} from "./lib/footer.ts";
import { getCwd } from "./lib/cwd.ts";
import { loadFastConfig } from "./lib/fast-config.ts";
import type { FastConfig } from "./lib/config.ts";
import { loadText, render, textPath, type ToolText } from "./lib/text.ts";

const SEGMENT_NAME = "fast";
const STATE_ENTRY = "fast-state";
const STATE_KEY = "__cpiFastState";
const ENV_KEY = "CPI_FAST_MODE";
const SERVICE_TIER = "priority";
const INDICATOR = "⚡fast";
const OPTIONS = ["on", "off", "toggle"] as const;

type ModelRef = { provider: string; id: string };
type FastState = { enabled: boolean };
type FastText = ToolText & { flag: { description: string } };

function getState(): FastState {
  const global = globalThis as Record<string, unknown>;
  if (
    !isRecord(global[STATE_KEY]) ||
    typeof global[STATE_KEY].enabled !== "boolean"
  ) {
    global[STATE_KEY] = { enabled: process.env[ENV_KEY] === "1" };
  }
  return global[STATE_KEY] as FastState;
}

function applyEnabled(enabled: boolean): void {
  getState().enabled = enabled;
  process.env[ENV_KEY] = enabled ? "1" : "0";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toModelRef(model: unknown): ModelRef | undefined {
  if (!isRecord(model)) return undefined;
  return typeof model.provider === "string" && typeof model.id === "string"
    ? { provider: model.provider, id: model.id }
    : undefined;
}

function isEligible(config: FastConfig, model: ModelRef | undefined): boolean {
  return (
    model !== undefined &&
    config.providers.includes(model.provider) &&
    config.models.includes(model.id)
  );
}

function parseEnabled(args: string, enabled: boolean): boolean {
  const value = args.trim().toLowerCase();
  if (!value || value === "toggle") return !enabled;
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error("Usage: /fast [on|off|toggle]");
}

export default function fastExtension(pi: ExtensionAPI): void {
  const text = loadText<FastText>("fast", textPath("fast"));
  let config = loadFastConfig(getCwd());
  let configCwd = getCwd();
  let currentModel: ModelRef | undefined;

  const indicator = (): string | undefined =>
    getState().enabled && isEligible(config, currentModel)
      ? INDICATOR
      : undefined;

  const refreshConfig = (): void => {
    const cwd = getCwd();
    if (cwd === configCwd) return;
    config = loadFastConfig(cwd);
    configCwd = cwd;
    requestFooterRender();
  };

  const reconstructState = (ctx: ExtensionContext): boolean => {
    let found = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === STATE_ENTRY &&
        isRecord(entry.data) &&
        typeof entry.data.enabled === "boolean"
      ) {
        applyEnabled(entry.data.enabled);
        found = true;
      }
    }
    return found;
  };

  const setEnabled = (enabled: boolean): void => {
    pi.appendEntry(STATE_ENTRY, { enabled });
    applyEnabled(enabled);
    requestFooterRender();
  };

  pi.registerFlag("fast", {
    description: render(text.flag.description, {}),
    type: "boolean",
    default: false,
  });

  pi.registerCommand("fast", {
    description: render(text.tool.description, {}),
    getArgumentCompletions(prefix) {
      const normalized = prefix.trim().toLowerCase();
      const matches = OPTIONS.filter((option) => option.startsWith(normalized));
      return matches.length
        ? matches.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      try {
        refreshConfig();
        setEnabled(parseEnabled(args, getState().enabled));
        ctx.ui.notify(
          `Fast mode: ${getState().enabled ? "on" : "off"}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    configCwd = getCwd();
    config = loadFastConfig(configCwd);
    currentModel = toModelRef(ctx.model);
    const foundState = reconstructState(ctx);
    clearRightSegment(SEGMENT_NAME);
    registerRightSegment(SEGMENT_NAME, indicator);
    if (pi.getFlag("fast") === true) {
      try {
        setEnabled(true);
      } catch (error) {
        if (ctx.hasUI) {
          const message =
            error instanceof Error ? error.message : String(error);
          ctx.ui.notify(message, "error");
        }
      }
    } else if (!foundState) {
      setEnabled(getState().enabled);
    }
    requestFooterRender();
  });

  pi.on("session_tree", (_event, ctx) => {
    const foundState = reconstructState(ctx);
    if (!foundState) {
      setEnabled(getState().enabled);
    }
    requestFooterRender();
  });

  pi.on("model_select", (event) => {
    currentModel = toModelRef(event.model);
    requestFooterRender();
  });

  pi.on("before_provider_request", (event, ctx) => {
    refreshConfig();
    const model = toModelRef(ctx.model);
    if (
      !getState().enabled ||
      !isEligible(config, model) ||
      !isRecord(event.payload)
    ) {
      return undefined;
    }
    return { ...event.payload, service_tier: SERVICE_TIER };
  });

  pi.on("session_shutdown", async () => {
    clearRightSegment(SEGMENT_NAME);
    requestFooterRender();
  });
}
