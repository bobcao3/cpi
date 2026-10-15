import { loadText, render, textPath } from "../lib/text.ts";

export function mermaid_message(
  key: string,
  values: Record<string, unknown> = {},
): string {
  const text = loadText<{ messages: Record<string, string> }>(
    "mermaid",
    textPath("mermaid"),
  );
  return render(text.messages[key], values);
}
