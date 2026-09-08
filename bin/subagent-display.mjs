import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";

export function createToolDisplay(session, diagnostic) {
  initTheme(session.settingsManager.getTheme());
  const rows = new Map();
  const clean = (value) =>
    stripVTControlCharacters(String(value)).replace(/\r/g, "");
  function context(id, args, isError = false) {
    return {
      args,
      toolCallId: id,
      cwd: session.sessionManager.getCwd(),
      state: {},
      invalidate() {},
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError,
    };
  }
  return {
    call(call) {
      if (rows.size >= 256 || rows.has(call.id))
        throw new Error("subagent tool correlation limit or duplicate id");
      const row = context(call.id, call.arguments);
      rows.set(call.id, row);
      try {
        const definition = session.getToolDefinition(call.name);
        definition
          ?.renderCall?.(
            call.arguments,
            session.extensionRunner.getUIContext().theme,
            row,
          )
          ?.render(100);
      } catch (error) {
        diagnostic(`Tool call renderer (${call.name}): ${error}`);
      }
    },
    result(message) {
      const row =
        rows.get(message.toolCallId) ?? context(message.toolCallId, {});
      rows.delete(message.toolCallId);
      row.isError = message.isError;
      const definition = session.getToolDefinition(message.toolName);
      let lines;
      let rendering = "fallback";
      try {
        if (definition?.renderResult) {
          const component = definition.renderResult(
            message,
            { expanded: false, isPartial: false },
            session.extensionRunner.getUIContext().theme,
            row,
          );
          lines = component.render(100);
          rendering = "tui";
        }
      } catch (error) {
        diagnostic(`Tool result renderer (${message.toolName}): ${error}`);
      }
      if (!lines) {
        const texts = (message.content ?? []).filter(
          (part) => part.type === "text",
        );
        const count = texts.reduce(
          (total, part, index) =>
            total + Buffer.byteLength(part.text) + (index ? 1 : 0),
          0,
        );
        const first = clean((texts[0]?.text ?? "").slice(0, 8192))
          .split("\n", 1)[0]
          .trim();
        lines = [
          `${Array.from(first).slice(0, 60).join("")}...[${count} bytes]`,
        ];
        if (message.isError)
          diagnostic(
            texts
              .map((part) => part.text)
              .join("\n")
              .slice(0, 4096),
          );
      }
      const bounded = lines
        .slice(0, 10)
        .map((line) => clean(line).slice(0, 240));
      if (lines.length > 10)
        bounded.push(`… (${lines.length - 10} more display lines)`);
      return { lines: bounded, rendering };
    },
  };
}
