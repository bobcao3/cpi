import type {
  Theme,
  ToolDefinition as PiToolDefinition,
  ToolRenderers as PiToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type {
  ToolTreeBatchCall,
  ToolTreeContext,
  ToolTreeNode,
  ToolTreeSnapshot,
} from "./tool-tree.ts";

export interface ToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = any,
> extends PiToolDefinition<TParams, TDetails, TState> {
  renderTree?: (
    snapshot: ToolTreeSnapshot<Static<TParams>, TDetails>,
    theme: Theme,
    context: ToolTreeContext<TState>,
  ) => readonly ToolTreeNode[];
  renderBatchTree?: (
    calls: readonly ToolTreeBatchCall[],
    theme: Theme,
    context: ToolTreeContext<TState>,
  ) => readonly ToolTreeNode[];
}

export interface ToolRenderers extends PiToolRenderers {
  renderTree?: (
    snapshot: ToolTreeSnapshot<any, any>,
    theme: Theme,
    context: ToolTreeContext<any>,
  ) => readonly ToolTreeNode[];
  renderBatchTree?: (
    calls: readonly ToolTreeBatchCall[],
    theme: Theme,
    context: ToolTreeContext<any>,
  ) => readonly ToolTreeNode[];
}
