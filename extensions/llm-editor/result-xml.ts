/**
 * Pretty-printed XML builder for llm_editor tool results.
 *
 * Every result is a `<editor_result>` element: one field per line, 2-space
 * indent. Text fields are XML-escaped (code/diff with `<`, `>`, `&` is safe);
 * newlines inside text (diff, ranges, listings) are preserved. Replaces the old
 * ad-hoc text format so results are structured + greppable, with a stable
 * `<id>` field (short-sha of the call's args) correlating to a transcript.
 *
 * Pure leaf: no imports.
 */

function escapeXml(s: string): string {
  return s.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"));
}

function escapeAttr(v: string | number): string {
  return String(v).replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/**
 * One indented element. `text` omitted ⇒ self-closing (`<tag attrs/>`).
 * `attrs` map to `k="v"` pairs (attribute values escaped).
 */
export function field(tag: string, text?: string, attrs?: Record<string, string | number>): string {
  const a = attrs
    ? " " +
      Object.entries(attrs)
        .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
        .join(" ")
    : "";
  if (text === undefined) return `  <${tag}${a}/>`;
  return `  <${tag}${a}>${escapeXml(text)}</${tag}>`;
}

/** Wrap pre-built field lines in the result root element. */
export function resultXml(fields: string[]): string {
  return `<editor_result>\n${fields.join("\n")}\n</editor_result>`;
}
