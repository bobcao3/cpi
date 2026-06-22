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
const IDS_KEY = "__cpiTranscriptIds";
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

// --- short tool-call ids --------------------------------------------------

/**
 * Providers assign long tool-use ids (`call_1985a6111ece41f1972ab897`,
 * `toolu_…`). cpi's subagent transcript renders every call head and result
 * block with that id, and the orchestrating agent tails that transcript into
 * its own context, so the long ids cost real tokens (twice per call).
 * `shortToolCallId` maps each real id to a short monotonic id (`sh0001`,
 * `re0002`, …) preserving call↔result correlation. Display-only — never
 * touches the provider API envelope's tool_use_id.
 *
 * State lives in a `globalThis` slot `__cpiTranscriptIds` holding
 * `{ map: Map<string,string>, counter: number }`, shared across jiti module
 * graphs and surviving reloads (same pattern as the `__cpiTranscriptRenderers`
 * registry). Each `pi -p` subagent process starts fresh, so ids are short and
 * per-transcript.
 */
interface IdState {
  map: Map<string, string>;
  counter: number;
}

function idState(): IdState {
  const g = globalThis as Record<string, unknown>;
  const existing = g[IDS_KEY];
  if (
    existing &&
    typeof existing === "object" &&
 (existing as IdState).map instanceof Map
  ) {
    return existing as IdState;
  }
  const fresh: IdState = { map: new Map(), counter: 0 };
  g[IDS_KEY] = fresh;
  return fresh;
}

/** First 2 alphanumeric chars of toolName lowercased, fallback `"tc"`. */
function prefixFor(toolName: string): string {
  const match = String(toolName).match(/[A-Za-z0-9]/g);
  if (match && match.length >= 2) return match.slice(0, 2).join("").toLowerCase();
  if (match && match.length === 1) return match[0].toLowerCase();
  return "tc";
}

/**
 * Map a real tool-use id to a short monotonic id, preserving call↔result
 * correlation across the transcript. Returns `""` for a falsy realId
 * (preserves current empty-id behavior). Display-only.
 */
export function shortToolCallId(realId: string | undefined, toolName: string): string {
  if (!realId) return "";
  const st = idState();
  const existing = st.map.get(realId);
  if (existing) return existing;
  const short = `${prefixFor(toolName)}${String(++st.counter).padStart(4, "0")}`;
  st.map.set(realId, short);
  return short;
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
  const head = `**${block.name}** \`${shortToolCallId(block.id, block.name)}\``;
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
