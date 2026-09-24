import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  detachChild,
  getShellBackgrounds,
  signalChild,
  silenceChild,
} from "./exec.ts";
import { getActiveRepeats } from "./repeat.ts";
import { render, renderLines } from "../lib/text.ts";

interface BackgroundToolText {
  sh_signal: { description: string; prompt_snippet: string };
  sh_detach: { description: string; prompt_snippet: string };
  sh_background_ps: { description: string; prompt_snippet: string };
  guidelines: {
    sh_signal: string[];
    sh_detach: string[];
    sh_background_ps: string[];
  };
  schema: {
    sh_signal: Record<string, string>;
    sh_detach: Record<string, string>;
  };
  results: { sh_signal: Record<string, string> };
}

export function registerBackgroundControlTools(
  pi: ExtensionAPI,
  text: BackgroundToolText,
  switches: Record<string, unknown>,
): void {
  pi.registerTool({
    name: "sh_signal",
    label: "sh_signal",
    description: render(text.sh_signal.description, switches),
    promptSnippet: text.sh_signal.prompt_snippet,
    promptGuidelines: renderLines(text.guidelines.sh_signal, switches),
    parameters: Type.Object({
      id: Type.String({ description: text.schema.sh_signal.id }),
      signal: Type.Optional(
        Type.String({ description: text.schema.sh_signal.signal }),
      ),
    }),
    async execute(_toolCallId, params) {
      const signal = params.signal ?? "SIGINT";
      if (!signalChild(params.id, signal))
        return {
          content: [
            { type: "text", text: `Background ${params.id} not active.` },
          ],
          isError: true,
        };
      // Only SIGKILL guarantees process-group exit; other POSIX signals may be ignored,
      // so their completion notices must still fire. Windows signals terminate the tree.
      const isKill = signal === "SIGKILL" || signal === "9";
      const isShell = !params.id.startsWith("rpt-");
      const isWindows = process.platform === "win32";
      const isTerminating = isKill || isWindows;
      if (isShell && isTerminating) silenceChild(params.id);
      const message =
        isShell && isWindows
          ? render(text.results.sh_signal.windows_terminated, {
              id: params.id,
              signal,
            })
          : isShell && isKill
            ? render(text.results.sh_signal.posix_killed, {
                id: params.id,
                signal,
              })
            : render(text.results.sh_signal.posix_sent, {
                id: params.id,
                signal,
              });
      return {
        content: [{ type: "text", text: message }],
        details: {
          id: params.id,
          signal,
          completionNoticeSuppressed: isShell && isTerminating,
        },
      };
    },
  });

  pi.registerTool({
    name: "sh_detach",
    label: "sh_detach",
    description: render(text.sh_detach.description, switches),
    promptSnippet: text.sh_detach.prompt_snippet,
    promptGuidelines: renderLines(text.guidelines.sh_detach, switches),
    parameters: Type.Object({
      id: Type.String({ description: text.schema.sh_detach.id }),
    }),
    async execute(_toolCallId, params) {
      const logPath = detachChild(params.id);
      if (!logPath)
        return {
          content: [
            { type: "text", text: `Background ${params.id} not active.` },
          ],
          isError: true,
        };
      return {
        content: [
          {
            type: "text",
            text: `Detached ${params.id}: runs untracked, survives this pi process; no completion notification fires. Output continues to drain to ${logPath}.`,
          },
        ],
        details: { id: params.id, detached: true, logPath },
      };
    },
  });
}

export function registerBackgroundListTool(
  pi: ExtensionAPI,
  text: BackgroundToolText,
  switches: Record<string, unknown>,
  truncateDescribe: (description: string) => string,
): void {
  pi.registerTool({
    name: "sh_background_ps",
    label: "sh_background_ps",
    description: render(text.sh_background_ps.description, switches),
    promptSnippet: text.sh_background_ps.prompt_snippet,
    promptGuidelines: renderLines(text.guidelines.sh_background_ps, switches),
    parameters: Type.Object({}),
    async execute() {
      const bgs = getShellBackgrounds();
      const rpts = getActiveRepeats();
      const total = bgs.length + rpts.length;
      if (total === 0) {
        return {
          content: [
            { type: "text", text: "no active background shells or monitors" },
          ],
          isError: false,
        };
      }
      const parts: string[] = [];
      if (bgs.length)
        parts.push(`${bgs.length} bg shell${bgs.length !== 1 ? "s" : ""}`);
      if (rpts.length)
        parts.push(`${rpts.length} monitor${rpts.length !== 1 ? "s" : ""}`);
      const entries = [...bgs, ...rpts]
        .map(
          (e) =>
            `[${e.id}${e.describe ? " " + truncateDescribe(e.describe) : ""}]`,
        )
        .join(" ");
      return {
        content: [{ type: "text", text: `${parts.join(", ")}: ${entries}` }],
        details: { backgrounds: bgs, repeats: rpts },
        isError: false,
      };
    },
  });
}
