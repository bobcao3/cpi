import { readFileSync } from "node:fs";
import { renderMermaidASCII } from "beautiful-mermaid";
import { COLUMN_PADDING, refine_flowchart } from "./canvas.mjs";

const OUTPUT_LIMIT = 256 * 1024;
let result;
try {
  const { source, width, layout, colorMode, theme, replacements } = JSON.parse(
    readFileSync(0, "utf8"),
  );
  if (
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(source.replaceAll(COLUMN_PADDING, ""))
  )
    throw new Error("controls");
  const originals = new Map(replacements);
  let text = "";
  let columns = 0;
  for (const spacing of [
    layout,
    { compact: true, paddingX: 3, paddingY: 3, boxBorderPadding: 1 },
  ]) {
    const { compact, ...padding } = spacing;
    text = renderMermaidASCII(source, {
      useAscii: false,
      colorMode,
      theme,
      ...padding,
    });
    if (Buffer.byteLength(text) > OUTPUT_LIMIT) throw new Error("output_limit");
    const plain = text
      .replace(/\x1b\[[\d;]*m/g, "")
      .replaceAll(COLUMN_PADDING, "");
    if (/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(plain))
      throw new Error("controls");
    if (/^(?:flowchart|graph|stateDiagram(?:-v2)?)\b/.test(source))
      text = refine_flowchart(text, compact);
    columns = Math.max(
      ...text
        .replace(/\x1b\[[\d;]*m/g, "")
        .split("\n")
        .map((line) => [...line].length),
    );
    if (columns <= width) break;
  }
  text = text
    .replace(/[\ue000-\uf8ff]/g, (marker) => originals.get(marker) ?? marker)
    .replaceAll(COLUMN_PADDING, "");
  if (Buffer.byteLength(text) > OUTPUT_LIMIT) throw new Error("output_limit");
  if (!text.trim()) throw new Error("empty");
  result = { text, warnings: [] };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  result = {
    ...(["output_limit", "controls", "empty"].includes(message)
      ? { errorCode: message }
      : { error: message }),
    warnings: [],
  };
}
process.stdout.write(JSON.stringify(result));
