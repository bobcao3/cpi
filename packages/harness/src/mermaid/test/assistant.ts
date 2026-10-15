import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import type { Panel } from "./screenshots.ts";

export function message(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "mermaid-visual-fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

export function assistant(
  transformers: MarkdownTransformer[],
): AssistantMessageComponent {
  return new AssistantMessageComponent(
    undefined,
    false,
    getMarkdownTheme(),
    "Thinking...",
    1,
    transformers,
  );
}

export function panel(
  component: AssistantMessageComponent,
  title: string,
  text: string,
  width: number,
  streaming = false,
  stopReason: AssistantMessage["stopReason"] = streaming ? "pending" : "stop",
): Panel {
  component.updateContent(message(text, stopReason), streaming);
  return { title, width, lines: component.render(width) };
}
