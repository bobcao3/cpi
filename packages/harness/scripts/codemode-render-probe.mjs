import { hostCodingAgent, hostTui } from "../bin/host-pi.mjs";

const [{ ToolExecutionComponent }, { TuiMainScreen, ProcessTerminal }] =
  await Promise.all([hostCodingAgent(), hostTui()]);

export function create_render_probe({ session, manager, theme, work }) {
  const run = async (id, code, on_update) => {
    const name = "codemode";
    const args = { code };
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      api: session.model.api,
      provider: session.model.provider,
      model: session.model.id,
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    manager.appendMessage(assistant);
    session.agent.state.messages.push(assistant);
    const started = performance.now();
    const output = await session.agent.state.tools
      .find((tool) => tool.name === name)
      .execute(id, args, undefined, on_update);
    const result = { ...output, durationMs: performance.now() - started };
    manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      ...result,
      isError: result.isError ?? false,
      timestamp: Date.now(),
    });
    return result;
  };
  const states = new Map();
  const viewStates = new Map();
  const resolveToolRenderers = (name) =>
    session.extensionRunner.resolveToolRenderers(name, () =>
      session.getToolDefinition(name),
    );
  const context = (
    id,
    code,
    expanded = false,
    partial = false,
    is_error = false,
  ) => ({
    args: { code },
    toolCallId: id,
    state: states.get(id) ?? states.set(id, {}).get(id),
    viewState:
      viewStates.get(id) ??
      viewStates.set(id, { open: new Map(), shownChildren: new Map() }).get(id),
    toolRenderers: resolveToolRenderers,
    expanded,
    isPartial: partial,
    isError: is_error,
    outputPad: 1,
    durationMs: partial
      ? undefined
      : manager
          .getBranch()
          .findLast(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === id,
          )?.message.durationMs,
    showImages: false,
    cwd: work,
    executionStarted: true,
    argsComplete: true,
    lastComponent: undefined,
    invalidate() {},
  });
  const render = (
    definition,
    id,
    code,
    result,
    expanded = false,
    width = 80,
    partial = false,
  ) => {
    const ctx = context(id, code, expanded, partial, result.isError ?? false);
    ctx.state.toolRenderers = resolveToolRenderers;
    const ui = new TuiMainScreen(new ProcessTerminal());
    ui.stop();
    const component = new ToolExecutionComponent(
      "codemode",
      id,
      { code },
      { showImages: false, outputPad: 1, resolveToolRenderers },
      definition,
      ui,
      work,
    );
    try {
      component.updateResult(result, partial);
      component.setExpanded(expanded);
      return component.render(width).filter((line) => line !== "");
    } finally {
      component.dispose();
    }
  };
  return {
    run,
    context,
    render,
  };
}
