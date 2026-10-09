import { type ToolDefinition } from "../tree/index.ts";
import { Type } from "typebox";
import { renderRepeatTree, type RepeatDetails } from "./repeat-render.ts";

import {
  getShuckBinPath,
  buildShellEnvWithDotenv,
  type ToolAvailability,
} from "./tools.ts";
import { resolveShell, type ShellProfile } from "./profile.ts";
import { analyzeCommand, unsupportedDialectMessage } from "./analyze.ts";
import {
  loadText,
  render,
  renderLines,
  textPath,
  type ToolText,
} from "../lib/text.ts";
import { getCwd } from "../lib/cwd.ts";
import { resolve } from "node:path";
import { startRepeat } from "./repeat.ts";

export function createRepeatTool(
  DESCRIBE_MAX: number,
  availability: ToolAvailability,
  shell: ShellProfile = resolveShell("bash"),
) {
  const truncateDescribe = (t: string) =>
    t.length <= DESCRIBE_MAX ? t : t.slice(0, DESCRIBE_MAX - 1) + "…";
  const T = loadText<ToolText>("sh-repeat", textPath("sh-repeat"));
  const results = loadText<{ results: Record<string, string> }>(
    "repeat-persistence",
    textPath("repeat-persistence"),
  ).results;
  const guidelines = renderLines(T.guidelines.bullets, {
    shell_invocation: shell.invocation,
    shell_name: shell.displayName,
  });
  const schema = Type.Object({
    command: Type.String({ description: T.schema!.command }),
    interval: Type.Number({
      minimum: 5,
      maximum: 60,
      description: T.schema!.interval,
    }),
    description: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: T.schema!.description,
    }),
    env: Type.Optional(Type.String({ description: T.schema!.env })),
  });

  const tool: ToolDefinition<typeof schema, RepeatDetails> = {
    name: "sh_repeat_until",
    label: "sh_repeat_until",
    description: render(T.tool.description, {
      shell_invocation: shell.invocation,
      shell_name: shell.displayName,
    }),
    promptSnippet: T.tool.prompt_snippet,
    promptGuidelines: guidelines,
    parameters: schema,
    renderShell: "self" as const,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const interval = params.interval;
      const description = params.description?.trim();
      const blocked = (
        reason: string,
        details: Record<string, unknown> = {},
        text = reason,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: { describe: description, blocked: reason, ...details },
        isError: true,
      });
      if (interval < 5 || interval > 60)
        return blocked(render(results.interval_invalid!, { interval }));

      const shuckPath = availability.shuck ? getShuckBinPath() : null;
      const analysis = await analyzeCommand({
        command: params.command,
        shell,
        availability,
        shuckPath,
      });
      if (analysis.status === "unsupported-dialect")
        return blocked(unsupportedDialectMessage(analysis.unsupported!));
      const { parse } = analysis;
      if (analysis.errorText) {
        const count = analysis.errorCount;
        return blocked(
          analysis.errorText,
          { shuckBlocked: true, tsAst: parse.ast },
          render(results.blocked!, {
            error: analysis.errorText,
            count,
            plural: count !== 1 ? "s" : "",
          }),
        );
      }
      const shuckWarnings = analysis.warningText || undefined;
      const warningPrefix = shuckWarnings
        ? render(results.warnings!, { warnings: shuckWarnings })
        : "";

      const id = startRepeat(
        params.command,
        interval,
        buildShellEnvWithDotenv(ctx?.sessionManager, params.env),
        description,
        shell,
        getCwd(),
        params.env ? resolve(getCwd(), params.env) : undefined,
      );

      const tag = description ? ` (${truncateDescribe(description)})` : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              warningPrefix + render(results.started!, { id, interval, tag }),
          },
        ],
        details: {
          id,
          status: "repeating",
          interval,
          description,
          shuckWarnings,
          tsAst: parse.ast,
        },
        isError: false,
      };
    },
    renderTree: renderRepeatTree,
  };
  return tool;
}
