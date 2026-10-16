import type { Diagnostic } from "../lib/lsp/diagnostics.ts";
import {
  diagram_result,
  file_diagrams,
  MERMAID_WIDTH,
  MERMAID_DIAGRAM_LIMIT,
} from "./markdown.ts";
import { mermaid_message } from "./text.ts";

export async function check_mermaid_file(path: string): Promise<Diagnostic[]> {
  const diagnostic = (
    message: string,
    line: number,
    severity: "error" | "warning",
  ): Diagnostic => ({
    severity,
    message,
    source: "mermaid",
    file: path,
    startLine: line,
    startCol: 1,
    endLine: line,
    endCol: 1,
  });
  try {
    const found = file_diagrams(path);
    if (!found.length) return [];
    const result: Diagnostic[] = [];
    const deadline = Date.now() + 2000;
    for (const [index, diagram] of found.entries()) {
      if (index >= MERMAID_DIAGRAM_LIMIT || Date.now() > deadline) {
        result.push(
          diagnostic(mermaid_message("diagram_limit"), diagram.line, "warning"),
        );
        break;
      }
      const rendered = diagram_result(diagram, MERMAID_WIDTH);
      if (rendered.error)
        result.push(diagnostic(rendered.error, diagram.line, "error"));
      for (const warning of rendered.warnings)
        result.push(diagnostic(warning, diagram.line, "warning"));
    }
    return result;
  } catch (error) {
    return [
      diagnostic(
        error instanceof Error ? error.message : String(error),
        1,
        "error",
      ),
    ];
  }
}
