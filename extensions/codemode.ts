import {
  createCodemodeExtension,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { codemode_renderers } from "./codemode/render.ts";
import {
  call_preview,
  type CallPreview,
  type CodeDetails,
  type ToolRenderers,
} from "./codemode/preview.ts";

export default function codemode(
  pi: ExtensionAPI,
  renderers: ToolRenderers = new Map(),
): void {
  createCodemodeExtension()({
    ...pi,
    registerTool(tool) {
      if (tool.name !== "codemode") {
        pi.registerTool(tool);
        return;
      }
      const definition = tool as ToolDefinition<any, CodeDetails | undefined>;
      const execute = definition.execute;
      pi.registerTool({
        ...definition,
        defaultActive: true,
        ...codemode_renderers(renderers),
        async execute(tool_call_id, params, signal, on_update, context) {
          const previews = new Map<string, CallPreview>();
          const annotate = (details: unknown): CodeDetails => ({
            ...((details as CodeDetails) ?? { calls: [] }),
            cpi_calls: Object.fromEntries(previews),
          });
          const tool_context = Object.create(context, {
            executeTool: {
              value: async (
                ...args: Parameters<typeof context.executeTool>
              ) => {
                const outcome = await context.executeTool(...args);
                if (previews.size < 256 && renderers.has(args[0]))
                  previews.set(
                    outcome.toolCall.id,
                    call_preview(
                      args[0],
                      args[1],
                      outcome.result.details,
                      outcome.result.content,
                      previews.size,
                      outcome.isError,
                    ),
                  );
                return outcome;
              },
            },
          });
          const result = await execute(
            tool_call_id,
            params,
            signal,
            on_update
              ? (update) =>
                  on_update({ ...update, details: annotate(update.details) })
              : undefined,
            tool_context,
          );
          return { ...result, details: annotate(result.details) };
        },
      });
    },
  });
}
