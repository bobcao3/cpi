/** Shared line helpers for Viewer/Editor model context. */

/** Logical line bodies without terminators or a phantom line after final EOL. */
export function lineBodies(content: string): string[] {
  if (content === "") return [];
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** Annotate every source line as `LINE_NUMBER<TAB>LINE_CONTENT`. */
export function numberLines(content: string): string {
  return lineBodies(content)
    .map((line, index) => `${index + 1}\t${line}`)
    .join("\n");
}
