import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transform_mermaid } from "./markdown.ts";

export default function mermaid_extension(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType === "assistant-thinking") return markdown;
    return transform_mermaid(
      markdown,
      context.availableWidth,
      undefined,
      context.isStreaming,
    );
  });
}
