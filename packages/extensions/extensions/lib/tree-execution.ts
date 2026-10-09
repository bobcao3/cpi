import type {
  Theme,
  ToolExecutionBatchCall,
  ToolExecutionRenderContext,
  ToolExecutionSnapshot,
} from "@earendil-works/pi-coding-agent";
import type {
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  createTreeState,
  resolveToolTree,
  ToolPresentationJobs,
  ToolTreeComponent,
  type ToolRenderers,
  type ToolTreeContext,
  type ToolTreeNode,
  type TreeState,
} from "../tree/index.ts";
import {
  registerToolTreeComponent,
  unregisterToolTreeComponent,
  renderToolTreeHtml,
  toolTreeTicker,
} from "../presentation/index.ts";

function tree_context(context: ToolExecutionRenderContext): ToolTreeContext {
  context.state.toolRenderers = context.resolveToolRenderers;
  const state = context.state as Record<string, unknown> & {
    cpi_tree_view?: TreeState;
  };
  return {
    toolCallId: context.toolCallId,
    cwd: context.cwd,
    state: context.state,
    viewState: (state.cpi_tree_view ??= createTreeState()),
    invalidate: context.invalidate,
  };
}

function project_tree(
  renderers: ToolRenderers,
  snapshot: ToolExecutionSnapshot,
  theme: Theme,
  context: ToolTreeContext,
): readonly ToolTreeNode[] {
  return resolveToolTree("", snapshot, theme, context, renderers) ?? [];
}

class TreeExecution {
  private readonly tree: ToolTreeComponent;
  private readonly jobs = new ToolPresentationJobs();
  private readonly member_states = new Map<string, Record<string, unknown>>();
  private context: ToolExecutionRenderContext;
  private snapshot: ToolExecutionSnapshot;
  private theme: Theme;
  private readonly renderers: ToolRenderers;
  private calls?: readonly ToolExecutionBatchCall[];
  private expanded?: boolean;
  private rendered_at = 0;
  private disposed = false;
  private invalidating = false;

  constructor(
    renderers: ToolRenderers,
    snapshot: ToolExecutionSnapshot,
    theme: Theme,
    context: ToolExecutionRenderContext,
  ) {
    this.renderers = renderers;
    this.snapshot = snapshot;
    this.theme = theme;
    this.context = context;
    this.tree = new ToolTreeComponent([], theme, {
      state: tree_context(context).viewState,
      padding: 0,
      showImages: context.showImages,
      imageWidthCells: context.imageWidthCells,
      invalidate: () => {
        if (!this.invalidating) this.context.invalidate();
      },
    });
    registerToolTreeComponent(this);
  }

  update(
    snapshot: ToolExecutionSnapshot,
    theme: Theme,
    context: ToolExecutionRenderContext,
    calls?: readonly ToolExecutionBatchCall[],
  ): void {
    this.snapshot = snapshot;
    this.theme = theme;
    this.context = context;
    this.calls = calls;
    if (snapshot.phase === "complete") {
      this.jobs.dispose();
      toolTreeTicker.unregister(this);
    } else if (snapshot.phase !== "arguments" && !calls) {
      const name = context.state.cpi_tree_tool_name;
      this.jobs.update(
        typeof name === "string" ? name : "",
        snapshot.args,
        context.cwd,
        context.state,
        context.invalidate,
      );
    }
    this.tree.setImageOptions(context.showImages, context.imageWidthCells);
    const roots = this.project();
    this.tree.update(roots, theme);
    if (this.expanded !== context.expanded) this.setExpanded(context.expanded);
  }

  private project(): readonly ToolTreeNode[] {
    const context = tree_context(this.context);
    if (!this.calls || !this.renderers.renderBatchTree)
      return project_tree(this.renderers, this.snapshot, this.theme, context);
    const retained = new Set(this.calls.map((call) => call.toolCallId));
    for (const id of this.member_states.keys())
      if (!retained.has(id)) this.member_states.delete(id);
    const calls = this.calls.map((call) => {
      let state = this.member_states.get(call.toolCallId);
      if (!state) this.member_states.set(call.toolCallId, (state = {}));
      state.toolRenderers = this.context.resolveToolRenderers;
      return {
        ...call,
        roots: project_tree(this.renderers, call.snapshot, this.theme, {
          ...context,
          toolCallId: call.toolCallId,
          state,
        }),
      };
    });
    return this.renderers.renderBatchTree(calls, this.theme, context);
  }

  getTreeComponent(): ToolTreeComponent {
    return this.tree;
  }
  render(width: number): string[] {
    this.rendered_at = Date.now();
    if (!this.disposed && this.snapshot.phase === "running")
      toolTreeTicker.register(this);
    return this.tree.render(width);
  }
  setExpanded(expanded: boolean, force = false): void {
    this.expanded = expanded;
    this.tree.setExpanded(expanded, force);
  }
  needsAnimation(): boolean {
    if (this.disposed || Date.now() - this.rendered_at > 500) {
      toolTreeTicker.unregister(this);
      return false;
    }
    return this.tree.hasRunningRows();
  }
  tick(frame: number, elapsed: boolean): void {
    if (elapsed) this.tree.update(this.project(), this.theme);
    this.tree.setFrame(frame);
    this.context.invalidate();
  }
  handleInput(data: string): void {
    this.tree.handleInput(data);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.tree.handleMouse(event);
  }
  invalidate(): void {
    if (this.invalidating) return;
    this.invalidating = true;
    try {
      this.tree.invalidate();
    } finally {
      this.invalidating = false;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobs.dispose();
    toolTreeTicker.unregister(this);
    unregisterToolTreeComponent(this);
    this.tree.dispose();
  }
}

export function adapt_tree_renderers<T extends ToolRenderers>(
  renderers: T,
): T & ToolRenderers {
  if (!renderers.renderTree || renderers.renderExecution) return renderers;
  return {
    ...renderers,
    renderExecution(snapshot, theme, context) {
      context.state.cpi_tree_tool_name =
        "name" in renderers ? renderers.name : "";
      const component =
        context.lastComponent instanceof TreeExecution
          ? context.lastComponent
          : new TreeExecution(renderers, snapshot, theme, context);
      component.update(snapshot, theme, context);
      return component;
    },
    ...(renderers.renderBatchTree
      ? {
          renderBatchExecution(
            calls: readonly ToolExecutionBatchCall[],
            theme: Theme,
            context: ToolExecutionRenderContext,
          ) {
            const phase =
              calls.length &&
              calls.every((call) => call.snapshot.phase === "complete")
                ? "complete"
                : calls.some((call) => call.snapshot.phase === "running")
                  ? "running"
                  : calls.some((call) => call.snapshot.phase === "queued")
                    ? "queued"
                    : "arguments";
            const snapshot: ToolExecutionSnapshot = {
              args: {},
              phase,
              isError: calls.some((call) => call.snapshot.isError),
            };
            const component =
              context.lastComponent instanceof TreeExecution
                ? context.lastComponent
                : new TreeExecution(renderers, snapshot, theme, context);
            component.update(snapshot, theme, context, calls);
            return component;
          },
        }
      : {}),
    renderExecutionHtml(snapshot, theme, context) {
      return renderToolTreeHtml(
        project_tree(renderers, snapshot, theme, tree_context(context)),
        theme,
      );
    },
  };
}
