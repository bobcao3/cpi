import type {
  CodemodeToolDetails,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type ToolRenderers = Map<string, ToolDefinition<any, any, any>>;
export interface CallPreview {
  args: Record<string, unknown>;
  details: unknown;
  text: string;
  order: number;
  limited?: boolean;
}
export interface CodeDetails extends CodemodeToolDetails {
  cpi_calls?: Record<string, CallPreview>;
}

const MAX_VALUES = 512;
const MAX_TEXT = 1024;
const MAX_ENTRIES = 32;
const MAX_DEPTH = 4;
const OMIT_ARGUMENTS = new Map<string, readonly string[]>([
  ["sh", ["command"]],
  ["apply_patch", ["patch"]],
  ["write", ["file_text"]],
  ["edit", ["instruction"]],
]);

function bounded_value(
  value: unknown,
  omit_root: readonly string[] = [],
): { value: unknown; limited: boolean } {
  const holder: Record<string, unknown> = {};
  let limited = false;
  let text_remaining = 8192;
  const queue = [{ source: value, target: holder, key: "value", depth: 0 }];
  for (let index = 0; index < queue.length && index < MAX_VALUES; index++) {
    const { source, target, key, depth } = queue[index];
    if (typeof source === "string") {
      target[key] = source.slice(0, Math.min(MAX_TEXT, text_remaining));
      limited ||= (target[key] as string).length < source.length;
      text_remaining -= (target[key] as string).length;
    } else if (
      source === null ||
      typeof source === "number" ||
      typeof source === "boolean"
    )
      target[key] = source;
    else if (source && typeof source === "object" && depth < MAX_DEPTH) {
      const output: Record<string, unknown> = Array.isArray(source)
        ? ([] as unknown as Record<string, unknown>)
        : {};
      target[key] = output;
      let entries = 0;
      for (const child_key in source) {
        if (queue.length >= MAX_VALUES) {
          limited = true;
          break;
        }
        if (!Object.hasOwn(source, child_key)) continue;
        if (depth === 0 && omit_root.includes(child_key)) continue;
        if (entries++ >= MAX_ENTRIES) {
          limited = true;
          break;
        }
        if (
          ["__proto__", "constructor", "prototype", "data", "tsAst"].includes(
            child_key,
          )
        )
          continue;
        const child = (source as Record<string, unknown>)[child_key];
        queue.push({
          source: child,
          target: output,
          key: child_key,
          depth: depth + 1,
        });
      }
    } else if (source && typeof source === "object") limited = true;
  }
  return { value: holder.value, limited };
}

export function call_preview(
  name: string,
  args: unknown,
  details: unknown,
  content: ReadonlyArray<{ type: string; text?: string }>,
  order: number,
  is_error: boolean,
): CallPreview {
  const arguments_preview = bounded_value(args, OMIT_ARGUMENTS.get(name));
  const details_preview = bounded_value(details, ["text"]);
  return {
    args: (arguments_preview.value as Record<string, unknown>) ?? {},
    details: details_preview.value,
    limited: arguments_preview.limited || details_preview.limited,
    text:
      is_error || name === "alarm" || name === "lsp"
        ? content
            .filter((part) => part.type === "text")
            .slice(0, 4)
            .map((part) => (part.text ?? "").slice(0, 4096))
            .join("\n")
            .slice(0, 4096)
        : "",
    order,
  };
}
