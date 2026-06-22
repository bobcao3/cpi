/**
 * Pretty-printed XML builder for llm_editor tool results.
 *
 * Every result is a `<editor_result>` element: one field per line, 2-space
 * indent. Text fields are inlined RAW (never XML-escaped); attribute values
 * are still escaped. Newlines inside text (diff, ranges, listings) are
 * preserved. Replaces the old ad-hoc text format so results are structured +
 * greppable. The call `id` is no longer emitted here — it lives in
 * `result.details` and the persisted transcript filename.
 *
 * Pure leaf: no imports.
 *
 * Why text is raw: this is a zero-copy data plane — nothing parses the XML.
 * The TUI renders from result.details. Content/diff lines carry a `N\t` /
 * `+ N ` / `- N ` line-number prefix while tree lines carry a 📁/📄 glyph
 * prefix, so a file line like `</content>` renders as `123\t</content>` and is
 * distinguishable from the 2-space-indented tag `  </content>`. Escaping would
 * corrupt the payload for no benefit.
 */

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
  return `  <${tag}${a}>${text}</${tag}>`;
}

/** Wrap pre-built field lines in the result root element. */
export function resultXml(fields: string[]): string {
  return `<editor_result>\n${fields.join("\n")}\n</editor_result>`;
}
