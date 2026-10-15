import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  colorToHex,
  getTerminalColorMode,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { getThemeByName } from "@earendil-works/pi-coding-agent";
import { loadMermaidConfig } from "../lib/config.ts";
import { mermaid_message } from "./text.ts";
import {
  format_xychart,
  prepare_xychart,
  type XYChartPlan,
} from "./xychart.ts";
import { terminal_columns } from "./unicode.ts";

export const SUPPORTED_DIAGRAMS = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "erDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "xychart",
  "xychart-beta",
] as const;

export interface MermaidRenderResult {
  text?: string;
  warnings: string[];
  error?: string;
}

const SOURCE_LIMIT = 16 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const CACHE_LIMIT = 64;
const cache = new Map<string, MermaidRenderResult>();
const worker = fileURLToPath(new URL("./render-worker.mjs", import.meta.url));
const headers = new Set<string>(SUPPORTED_DIAGRAMS);

function normalize_source(source: string): string {
  let normalized = source
    .trim()
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "")
    .trimStart();
  while (normalized.startsWith("%%")) {
    const comment = normalized.startsWith("%%{")
      ? /^%%\{[\s\S]*?\}%%[^\n]*(?:\n|$)/
      : /^%%[^\n]*(?:\n|$)/;
    const remaining = normalized.replace(comment, "").trimStart();
    if (remaining === normalized) break;
    normalized = remaining;
  }
  return normalized;
}

function failure(error: string): MermaidRenderResult {
  return { error, warnings: [] };
}

function diagnostic(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, 1500);
}

export function render_mermaid(
  source: string,
  width: number,
): MermaidRenderResult {
  if (Buffer.byteLength(source, "utf8") > SOURCE_LIMIT)
    return failure(mermaid_message("source_limit"));
  if (!Number.isInteger(width) || width < 1 || width > 1000)
    return failure(mermaid_message("width_range"));
  const normalized = normalize_source(source);
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(normalized))
    return failure(mermaid_message("controls"));
  const header = normalized.match(/^([A-Za-z][A-Za-z0-9-]*)(?=[\s;:]|$)/)?.[1];
  if (!header || !headers.has(header))
    return failure(
      normalized
        ? mermaid_message("unsupported", {
            header: diagnostic(normalized.split("\n")[0]).slice(0, 80),
          })
        : mermaid_message("empty"),
    );
  let chart: XYChartPlan | undefined;
  if (header === "xychart" || header === "xychart-beta") {
    try {
      chart = prepare_xychart(normalized, width);
    } catch (error) {
      const code = error instanceof Error ? error.message : "chart_labels";
      return failure(
        mermaid_message(
          ["chart_values", "chart_lengths", "controls"].includes(code)
            ? code
            : "chart_labels",
        ),
      );
    }
  }
  const layout = loadMermaidConfig();
  const colorMode =
    getTerminalColorMode() === "truecolor" ? "truecolor" : "ansi256";
  const system_theme = getThemeByName("system")!;
  const colors = system_theme.colors;
  const theme = {
    fg: colorToHex(colors.text),
    border: colorToHex(colors.borderMuted),
    line: colorToHex(chart ? colors.borderMuted : colors.accent),
    arrow: colorToHex(colors.accent),
    corner: colorToHex(colors.accent),
    junction: colorToHex(colors.borderMuted),
    accent: colorToHex(colors.accent),
    bg: system_theme.appearance === "dark" ? "#000000" : "#ffffff",
  };
  const key = JSON.stringify([width, normalized, layout, colorMode, theme]);
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key);
    cache.set(key, previous);
    return { ...previous, warnings: [...previous.warnings] };
  }
  const runtime_args = process.versions.bun ? [] : ["--max-old-space-size=128"];
  const encoded = terminal_columns(chart?.source ?? normalized);
  const child = spawnSync(process.execPath, [...runtime_args, worker], {
    input: JSON.stringify({
      ...encoded,
      width,
      layout,
      colorMode,
      theme,
    }),
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
    maxBuffer: OUTPUT_LIMIT,
    windowsHide: true,
  });
  let result: MermaidRenderResult;
  if (child.error) {
    result = failure(
      mermaid_message("renderer_failed", {
        reason: diagnostic(child.error.message),
      }),
    );
  } else if (child.status !== 0) {
    result = failure(
      mermaid_message("renderer_exit", {
        status: child.signal ?? child.status,
        reason: diagnostic(child.stderr),
      }),
    );
  } else {
    try {
      const value: unknown = JSON.parse(child.stdout);
      if (typeof value !== "object" || value === null)
        throw new Error("Invalid renderer response.");
      const response = value as Record<string, unknown>;
      if (
        !Array.isArray(response.warnings) ||
        !response.warnings.every((warning) => typeof warning === "string")
      )
        throw new Error("Invalid renderer warnings.");
      if (
        typeof response.errorCode === "string" &&
        ["output_limit", "controls", "empty"].includes(response.errorCode)
      ) {
        result = failure(mermaid_message(response.errorCode));
      } else if (typeof response.error === "string") {
        result = failure(diagnostic(response.error));
      } else if (typeof response.text === "string" && response.text.trim()) {
        const text = chart
          ? format_xychart(chart, response.text, width, system_theme)
          : response.text;
        if (Buffer.byteLength(text) > OUTPUT_LIMIT)
          return failure(mermaid_message("output_limit"));
        const columns = text
          .split("\n")
          .reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
        result = {
          text,
          warnings:
            columns > width
              ? [mermaid_message("width", { columns, width })]
              : [],
        };
      } else {
        throw new Error("The renderer returned no diagram.");
      }
    } catch (error) {
      result = failure(
        mermaid_message("invalid_response", {
          reason: diagnostic(
            error instanceof Error ? error.message : String(error),
          ),
        }),
      );
    }
  }
  cache.set(key, { ...result, warnings: [...result.warnings] });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}
