/** `<editor_result>` XML for llm_editor results. Text fields are inlined RAW, never escaped: nothing parses this XML (the TUI renders from result.details), and diff/tree payload lines carry N\t / 📁 / 📄 prefixes that escaping would corrupt; attribute values are escaped. */

function escapeAttr(v: string | number): string {
  return String(v).replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

export function field(
  tag: string,
  text?: string,
  attrs?: Record<string, string | number>,
): string {
  const a = attrs
    ? " " +
      Object.entries(attrs)
        .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
        .join(" ")
    : "";
  if (text === undefined) return `  <${tag}${a}/>`;
  return `  <${tag}${a}>${text}</${tag}>`;
}

export function resultXml(fields: string[]): string {
  return `<editor_result>\n${fields.join("\n")}\n</editor_result>`;
}
