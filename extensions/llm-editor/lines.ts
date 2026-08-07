export function lineBodies(content: string): string[] {
  if (content === "") return [];
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function numberLines(content: string): string {
  return lineBodies(content)
    .map((line, index) => `${index + 1}|${line}`)
    .join("\n");
}
