import {
  getStructuredToolOutput,
  type AgentToolResult,
  type CodemodeToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type ToolRenderers = Map<string, ToolDefinition<any, any, any>>;
export interface CallPreview {
  args: Record<string, unknown>;
  details: unknown;
  text: string;
  order: number;
  structuredContent?: AgentToolResult<unknown>["structuredContent"];
  limited?: boolean;
}
export interface CodeDetails extends CodemodeToolDetails {
  cpi_calls?: Record<string, CallPreview>;
}

const MAX_VALUES = 512;
const MAX_TEXT = 1024;
const MAX_ENTRIES = 32;
const MAX_DEPTH = 4;
const MAX_PROPERTIES = 8192;
const OMIT_ARGUMENTS = new Map<string, readonly string[]>([
  ["sh", ["command"]],
  ["apply_patch", ["patch"]],
  ["write", ["file_text"]],
  ["edit", ["instruction"]],
]);

function bounded_value(
  value: unknown,
  omit_root: readonly string[] = [],
  structured = false,
): { value: unknown; limited: boolean } {
  const holder: Record<string, unknown> = {};
  let limited = false;
  let text_remaining = 8192;
  let properties = 0;
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
    else if (
      source &&
      typeof source === "object" &&
      depth < (structured ? 16 : MAX_DEPTH)
    ) {
      const output: Record<string, unknown> = Array.isArray(source)
        ? ([] as unknown as Record<string, unknown>)
        : Object.create(null);
      Object.defineProperty(target, key, {
        value: output,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      let entries = 0;
      for (const child_key in source) {
        if (queue.length >= MAX_VALUES || ++properties > MAX_PROPERTIES) {
          limited = true;
          break;
        }
        if (!Object.hasOwn(source, child_key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, child_key);
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) {
          limited = true;
          continue;
        }
        if (depth === 0 && omit_root.includes(child_key)) continue;
        if (entries++ >= MAX_ENTRIES) {
          limited = true;
          break;
        }
        if (
          !structured &&
          ["__proto__", "constructor", "prototype", "data", "tsAst"].includes(
            child_key,
          )
        )
          continue;
        if (child_key.length > 256 || child_key.length > text_remaining) {
          limited = true;
          break;
        }
        text_remaining -= child_key.length;
        let child = descriptor.value;
        const type = Object.getOwnPropertyDescriptor(source, "type")?.value;
        const mime = Object.getOwnPropertyDescriptor(source, "mimeType");
        if (
          (child_key === "data" &&
            (type === "image" || type === "audio") &&
            typeof mime?.value === "string" &&
            typeof child === "string") ||
          (child_key === "blob" &&
            typeof mime?.value === "string" &&
            typeof child === "string")
        ) {
          child = "[binary data]";
          limited = true;
        }
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
  result: AgentToolResult<unknown>,
  order: number,
  options: {
    custom: boolean;
    output_schema?: ToolDefinition["outputSchema"];
    is_error: boolean;
  },
): CallPreview {
  const arguments_preview = bounded_value(args, OMIT_ARGUMENTS.get(name));
  const details_preview = options.custom
    ? bounded_value(result.details, ["text"])
    : { value: undefined, limited: false };
  const structured =
    options.output_schema === undefined
      ? undefined
      : options.custom
        ? result.structuredContent
        : getStructuredToolOutput(
            options.output_schema,
            result.structuredContent,
          );
  const has_structured = structured !== undefined;
  const structured_preview = has_structured
    ? bounded_value(structured, [], true)
    : undefined;
  const preview: CallPreview = {
    args: (arguments_preview.value as Record<string, unknown>) ?? {},
    details: details_preview.value,
    limited:
      arguments_preview.limited ||
      details_preview.limited ||
      (structured_preview?.limited ?? false),
    text:
      options.is_error ||
      name === "alarm" ||
      name === "lsp" ||
      (!options.custom && !has_structured)
        ? result.content
            .filter((part) => part.type === "text")
            .slice(0, 4)
            .map((part) => (part.text ?? "").slice(0, 4096))
            .join("\n")
            .slice(0, 4096)
        : "",
    order,
  };
  if (structured_preview)
    preview.structuredContent =
      structured_preview.value as AgentToolResult<unknown>["structuredContent"];
  return preview;
}
