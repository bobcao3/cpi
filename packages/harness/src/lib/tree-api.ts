import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ToolDefinition, ToolRenderers } from "../tree/index.ts";
import { adapt_tree_renderers } from "./tree-execution.ts";

export type ExtensionAPI = Omit<
  PiExtensionAPI,
  "registerTool" | "registerToolRenderer"
> & {
  registerTool<
    TParams extends TSchema = TSchema,
    TDetails = unknown,
    TState = any,
  >(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void;
  registerToolRenderer(
    resolver: (
      name: string,
      next: () => ToolRenderers | undefined,
    ) => ToolRenderers | undefined,
  ): void;
};

export function tree_extension_api(pi: PiExtensionAPI): ExtensionAPI {
  return {
    ...pi,
    registerTool(tool) {
      pi.registerTool(adapt_tree_renderers(tool));
    },
    registerToolRenderer(resolver) {
      pi.registerToolRenderer((name, next) => {
        const renderers = resolver(name, next);
        return renderers && adapt_tree_renderers(renderers);
      });
    },
  };
}
