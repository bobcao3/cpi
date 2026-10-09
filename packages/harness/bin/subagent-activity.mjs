import {
  publish,
  publishText,
  updateUsage,
  setFinalAnswer,
  observationFailure,
} from "./subagent-events.mjs";
import { createToolDisplay } from "./subagent-display.mjs";

export function observeSession(session) {
  let turns = 0;
  const usage = { input: 0, output: 0, cost: 0 };
  const streamed = new Set();
  const calls = new Set();
  const diagnostic = (message) => {
    publish({ type: "diagnostic", message: String(message).slice(0, 4096) });
    process.stderr.write(`${String(message).slice(0, 4096)}\n`);
  };
  const display = createToolDisplay(session, diagnostic);
  const toolCall = (call) => {
    if (calls.has(call.id)) return;
    if (calls.size >= 256) throw new Error("subagent tool call limit");
    const args = {};
    for (const key of [
      "description",
      "describe",
      "instruction",
      "title",
      "query",
      "path",
    ]) {
      if (typeof call.arguments?.[key] === "string")
        args[key] = call.arguments[key].slice(0, 4096);
    }
    publish({
      type: "tool_call",
      id: call.id,
      name: call.name,
      args,
    });
    display.call(call);
    calls.add(call.id);
  };
  const metadata = () =>
    publish({
      type: "session",
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      model: session.model
        ? `${session.model.provider}/${session.model.id}`
        : "unknown",
      effort: session.thinkingLevel ?? "",
    });
  metadata();
  let failed = false;
  const unsubscribe = session.subscribe((event) => {
    if (failed) return;
    try {
      if (
        event.type === "message_start" &&
        event.message.role === "assistant"
      ) {
        streamed.clear();
        calls.clear();
        metadata();
        publish({ type: "message", role: "assistant" });
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "toolcall_end") toolCall(update.toolCall);
        if (["text_delta", "thinking_delta"].includes(update.type)) {
          if (streamed.size >= 1024)
            throw new Error("subagent message content limit");
          streamed.add(update.contentIndex);
          publishText(
            update.type === "text_delta" ? "text" : "thinking",
            update.delta,
          );
        }
      }
      if (event.type === "message_end") {
        const message = event.message;
        if (message.role === "user") {
          publish({ type: "message", role: "user" });
          const content =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n");
          publishText("text", content);
        } else if (message.role === "assistant") {
          usage.input += message.usage?.input ?? 0;
          usage.output += message.usage?.output ?? 0;
          usage.cost += message.usage?.cost?.total ?? 0;
          updateUsage(usage, turns);
          for (const [index, part] of message.content.entries()) {
            if (part.type === "toolCall") {
              toolCall(part);
            } else if (
              !streamed.has(index) &&
              ["text", "thinking"].includes(part.type)
            ) {
              publishText(part.type, part.text ?? part.thinking);
            }
          }
          setFinalAnswer(
            message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
            message.errorMessage,
          );
          if (message.errorMessage) diagnostic(message.errorMessage);
        } else if (message.role === "toolResult") {
          publish({
            type: "tool_result",
            id: message.toolCallId,
            name: message.toolName,
            isError: !!message.isError,
            ...display.result(message),
          });
        }
      }
      if (event.type === "turn_end") updateUsage(usage, ++turns);
      if (event.type === "auto_retry_start") diagnostic(event.errorMessage);
    } catch (error) {
      failed = true;
      observationFailure(error);
      void session.abort();
    }
  });
  return unsubscribe;
}
