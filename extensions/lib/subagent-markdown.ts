import type { SubagentRunEvent } from "./subagent-events.ts";
import { sanitizeActivityText } from "./activity.ts";

export function createMarkdownWriter(emit: (chunk: string) => void) {
  let started = false;
  let lineStart = true;
  let pending = "";
  let breaks = 0;
  let channel = "text";
  let closed = false;
  let surrogate = "";
  let call_count = 0;
  const calls = new Map<string, { name: string; header: string }>();
  function write(text: string): void {
    if (closed) throw new Error("subagent markdown writer closed");
    text = surrogate + text;
    surrogate = /[\uD800-\uDBFF]$/.test(text) ? text.slice(-1) : "";
    if (surrogate) text = text.slice(0, -1);
    let output = "";
    for (const char of sanitizeActivityText(
      Buffer.from(text).toString("utf8"),
    )) {
      if (char === "\n") {
        breaks = Math.min(2, breaks + 1);
        pending = "";
        lineStart = true;
      } else if (/\s/u.test(char) || (lineStart && char === ">")) {
        if (pending.length < 256) pending += char;
      } else {
        output += (started ? "\n".repeat(breaks) : "") + pending + char;
        pending = "";
        breaks = 0;
        started = true;
        lineStart = false;
      }
    }
    if (output) emit(output);
  }
  const head = (value: unknown): string =>
    sanitizeActivityText(String(value ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  return {
    write,
    event(event: SubagentRunEvent): void {
      switch (event.type) {
        case "message":
          write(`\n\n## ${event.role === "user" ? "User" : "Assistant"}\n\n`);
          channel = "text";
          break;
        case "text":
          if (event.channel !== channel) {
            write(
              event.channel === "thinking"
                ? "\n\n### Thinking\n\n"
                : "\n\n### Response\n\n",
            );
            channel = event.channel;
          }
          write(event.text);
          break;
        case "tool_call": {
          if (calls.size >= 256 || calls.has(event.id))
            throw new Error("subagent markdown call limit or duplicate id");
          const args = event.args;
          const description =
            args.description ??
            args.describe ??
            args.instruction ??
            args.title ??
            args.query ??
            "";
          const label = [head(description), head(args.path)]
            .filter(Boolean)
            .join(" · ");
          calls.set(event.id, {
            name: event.name,
            header: `[${head(event.name)}|${++call_count}]:${label ? ` ${label}` : ""}`,
          });
          break;
        }
        case "tool_result": {
          const call = calls.get(event.id);
          if (!call || call.name !== event.name)
            throw new Error("subagent markdown result without matching call");
          calls.delete(event.id);
          const output =
            event.name === "read"
              ? ""
              : event.lines.map((line) => `> ${line}\n`).join("");
          write(
            `\n\n${call.header}${event.isError ? " [error]" : ""}\n${output}\n`,
          );
          break;
        }
      }
    },
    close(): void {
      if (closed) return;
      for (const call of calls.values())
        write(`\n\n${call.header} [result unavailable]\n`);
      calls.clear();
      if (surrogate) {
        surrogate = "";
        write("\uFFFD");
      }
      closed = true;
      if (started) emit("\n");
    },
  };
}
