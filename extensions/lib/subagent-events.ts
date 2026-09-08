import type { Usage } from "./cost-ledger.ts";

export type SubagentEventData =
  | {
      type: "session";
      sessionId: string;
      sessionFile: string | null;
      model: string;
      effort: string;
    }
  | { type: "message"; role: "user" | "assistant" }
  | { type: "text"; channel: "text" | "thinking"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      isError: boolean;
      lines: string[];
      rendering: "tui" | "fallback";
    }
  | { type: "usage"; usage: Usage; turns: number; scope: "self" }
  | { type: "diagnostic"; message: string }
  | {
      type: "terminal";
      outcome: "completed" | "failed" | "cancelled";
      answer: string;
      error?: string;
    };

export type SubagentRunEvent = SubagentEventData & {
  kind: "run_event";
  version: 1;
  runId: string;
  sequence: number;
};

export interface SubagentObservationOptions {
  onEvent?: (event: SubagentRunEvent) => void;
  onMarkdown?: (chunk: string) => void;
}

export interface SubagentObservationResult {
  usage?: Usage;
  finalAnswer: string;
  markdownPath: string;
  diagnosticsPath: string;
}

export function assertSubagentEvent(
  value: unknown,
  id: string,
  sequence: number,
): asserts value is SubagentRunEvent {
  const event = value as SubagentRunEvent;
  if (
    !event ||
    event.kind !== "run_event" ||
    event.version !== 1 ||
    event.runId !== id ||
    event.sequence !== sequence ||
    Buffer.byteLength(JSON.stringify(event)) >
      (event.type === "terminal" ? 8 : 1) * 1024 * 1024
  )
    throw new Error("invalid subagent observation envelope");
  const text = (value: unknown): boolean => typeof value === "string";
  const valid = (() => {
    switch (event.type) {
      case "session":
        return (
          text(event.sessionId) &&
          (event.sessionFile === null || text(event.sessionFile)) &&
          text(event.model) &&
          text(event.effort)
        );
      case "message":
        return ["user", "assistant"].includes(event.role);
      case "text":
        return ["text", "thinking"].includes(event.channel) && text(event.text);
      case "tool_call":
        return (
          text(event.id) &&
          text(event.name) &&
          !!event.args &&
          typeof event.args === "object" &&
          !Array.isArray(event.args)
        );
      case "tool_result":
        return (
          text(event.id) &&
          text(event.name) &&
          typeof event.isError === "boolean" &&
          ["tui", "fallback"].includes(event.rendering) &&
          Array.isArray(event.lines) &&
          event.lines.length <= 12 &&
          event.lines.every(text)
        );
      case "usage":
        return (
          event.scope === "self" &&
          Number.isInteger(event.turns) &&
          event.turns >= 0 &&
          !!event.usage &&
          [event.usage.input, event.usage.output, event.usage.cost].every(
            (value) => Number.isFinite(value) && value >= 0,
          )
        );
      case "diagnostic":
        return text(event.message);
      case "terminal":
        return (
          ["completed", "failed", "cancelled"].includes(event.outcome) &&
          text(event.answer) &&
          Buffer.byteLength(event.answer) <= 1024 * 1024 &&
          (event.error === undefined || text(event.error))
        );
      default:
        return false;
    }
  })();
  if (!valid) throw new Error("invalid subagent observation payload");
}
