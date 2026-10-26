export function readable_html(html: string): string {
  const parts: string[] = [];
  const hidden = new Set(["script", "style", "noscript", "svg"]);
  const breaks = new Set([
    "br",
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "tr",
  ]);
  let cursor = 0;
  let skipped: string | undefined;
  while (cursor < html.length) {
    if (skipped) {
      const close = new RegExp(`</${skipped}(?=[\\s/>])`, "gi");
      close.lastIndex = cursor;
      const match = close.exec(html);
      if (!match) break;
      cursor = match.index;
      skipped = undefined;
    }
    const start = html.indexOf("<", cursor);
    if (start < 0) {
      parts.push(html.slice(cursor));
      break;
    }
    if (start > cursor) parts.push(html.slice(cursor, start));
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    let end = start + 1;
    let quote: string | undefined;
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end === html.length) {
      parts.push(html.slice(start));
      break;
    }
    const closing = html[start + 1] === "/";
    const name_start = start + (closing ? 2 : 1);
    let name_end = name_start;
    while (name_end < end && /[a-z0-9:-]/i.test(html[name_end])) name_end++;
    const name = html.slice(name_start, name_end).toLowerCase();
    if (!closing && hidden.has(name) && html[end - 1] !== "/") skipped = name;
    else parts.push(breaks.has(name) ? "\n" : " ");
    cursor = end + 1;
  }
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return parts
    .join("")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (entity, key: string) => {
        if (!key.startsWith("#")) return entities[key.toLowerCase()] ?? entity;
        const point =
          key[1].toLowerCase() === "x"
            ? parseInt(key.slice(2), 16)
            : Number(key.slice(1));
        return point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : "";
      },
    )
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
