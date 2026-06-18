/**
 * Shared registry for markdown transcript rendering of tool calls.
 *
 * transcript.ts writes the live markdown transcript (one block per message).
 * For each tool call it asks this module: "how should this render?" Extensions
 * register a per-tool renderer (e.g. the shell extension renders `sh` calls as a
 * ```bash block). Tools without a registered renderer fall back to the default
 * pretty-printed XML serialization of their arguments.
 *
 * Sharing: pi loads each extension via jiti with `moduleCache: false`, so each
 * extension gets its own module graph — module-level state here would NOT be
 * shared between importers. The registry is therefore backed by a single
 * `globalThis` slot, process-wide and identical across jiti loads (same pattern
 * as lib/footer.ts).
 */

export interface ToolCallBlock {
  type: "toolCall";
  name: string;
  id?: string;
  // Upstream types `arguments` as an object, but openai-completions providers
  // deliver tool-call arguments as a JSON string at runtime, so accept either.
  arguments?: unknown;
}

// Markdown lines for the block, or null to defer to the default XML renderer.
export type ToolCallMarkdownRenderer = (block: ToolCallBlock) => string[] | null;

// Bound recursion: tool-call args are JSON-deserialized (no cycles possible),
// but a pathological nesting depth must not overflow the stack. Truncate beyond.
const MAX_XML_DEPTH = 32;
const GLOBAL_KEY = "__cpiTranscriptRenderers";
type Registry = Map<string, ToolCallMarkdownRenderer>;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`transcript-registry: ${msg}`);
}

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  let r = g[GLOBAL_KEY];
  if (!(r instanceof Map)) {
    r = new Map();
    g[GLOBAL_KEY] = r;
  }
  return r as Registry;
}

/** Register (or replace) a markdown renderer for tool calls of the given name. */
export function registerToolCallRenderer(
  toolName: string,
  renderer: ToolCallMarkdownRenderer,
): void {
  assert(
    typeof toolName === "string" && toolName.length > 0,
    "toolName must be a non-empty string",
  );
  assert(typeof renderer === "function", "renderer must be a function");
  registry().set(toolName, renderer);
}

// --- default renderer: pretty-printed XML of the arguments -----------------

function escapeXmlText(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

// XML names: NameStartChar then NameChars; collapse anything else to _, prefix
// when it would start with a digit/hyphen/dot.
function sanitizeTag(name: string): string {
  const t = String(name).replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (/^[0-9.-]/.test(t)) return "_" + t;
  return t || "_";
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function pushXml(tag: string, value: unknown, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  if (value === null || value === undefined) {
    out.push(`${pad}<${tag}/>`);
    return;
  }
  if (isScalar(value)) {
    out.push(`${pad}<${tag}>${escapeXmlText(String(value))}</${tag}>`);
    return;
  }
  // Object/array: truncate deep nesting instead of recursing further.
  if (depth >= MAX_XML_DEPTH) {
    out.push(`${pad}<${tag}>…</${tag}>`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${pad}<${tag}/>`);
      return;
    }
    out.push(`${pad}<${tag}>`);
    for (const item of value) pushXml("item", item, depth + 1, out);
    out.push(`${pad}</${tag}>`);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.push(`${pad}<${tag}/>`);
      return;
    }
    out.push(`${pad}<${tag}>`);
    for (const [k, v] of entries) pushXml(sanitizeTag(k), v, depth + 1, out);
    out.push(`${pad}</${tag}>`);
    return;
  }
  // function / symbol / bigint-ish: best-effort textual.
  out.push(`${pad}<${tag}>${escapeXmlText(String(value))}</${tag}>`);
}

// Arguments arrive as a parsed object (most providers) or a JSON string
// (openai-completions providers); normalize to a value. On a malformed JSON
// string, return the raw string so the serializer shows it as text.
export function parseArgs(block: ToolCallBlock): unknown {
  const a = block.arguments;
  if (typeof a === "string") {
    try {
      return JSON.parse(a);
    } catch {
      return a;
    }
  }
  return a ?? {};
}

function defaultXmlLines(block: ToolCallBlock): string[] {
  const head = `🔧 **${block.name}** \`${block.id ?? ""}\``;
  const xml: string[] = [];
  pushXml(sanitizeTag(block.name), parseArgs(block), 0, xml);
  return [head, "```xml", ...xml, "```", ""];
}

/**
 * Render a tool-call block to markdown lines. Never throws: a registered
 * renderer that throws or returns null/empty falls back to the default XML.
 */
export function renderToolCallMarkdown(block: ToolCallBlock): string[] {
  const custom = registry().get(block.name);
  if (custom) {
    try {
      const lines = custom(block);
      if (lines && lines.length) return lines;
    } catch {
      // A renderer must never break the transcript; fall back to default XML.
    }
  }
  return defaultXmlLines(block);
}
