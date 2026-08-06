// Renderers live in globalThis because jiti module state is per-importer.

export interface ToolCallBlock {
  type: "toolCall";
  name: string;
  id?: string;
  // Providers may deliver `arguments` as a JSON string rather than an object.
  arguments?: unknown;
}

// Markdown lines for the block, or null to defer to the default XML renderer.
export type ToolCallMarkdownRenderer = (
  block: ToolCallBlock,
) => string[] | null;

// Bound recursion: pathological nesting must not overflow the stack (args are JSON, so no cycles).
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

// Long ids render twice per call — map to short monotonic ids to keep
// call↔result correlation. Display-only; never touches the envelope's tool_use_id.
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

function prefixFor(toolName: string): string {
  const match = String(toolName).match(/[A-Za-z0-9]/g);
  if (match && match.length >= 2)
    return match.slice(0, 2).join("").toLowerCase();
  if (match && match.length === 1) return match[0].toLowerCase();
  return "tc";
}

export function shortToolCallId(
  realId: string | undefined,
  toolName: string,
): string {
  if (!realId) return "";
  const st = idState();
  const existing = st.map.get(realId);
  if (existing) return existing;
  const short = `${prefixFor(toolName)}${String(++st.counter).padStart(4, "0")}`;
  st.map.set(realId, short);
  return short;
}

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

// XML names: collapse invalid chars to _, prefix when starting with digit/hyphen/dot.
function sanitizeTag(name: string): string {
  const t = String(name).replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (/^[0-9.-]/.test(t)) return "_" + t;
  return t || "_";
}

function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

function pushXml(
  tag: string,
  value: unknown,
  depth: number,
  out: string[],
): void {
  const pad = "  ".repeat(depth);
  if (value === null || value === undefined) {
    out.push(`${pad}<${tag}/>`);
    return;
  }
  if (isScalar(value)) {
    out.push(`${pad}<${tag}>${escapeXmlText(String(value))}</${tag}>`);
    return;
  }
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
  out.push(`${pad}<${tag}>${escapeXmlText(String(value))}</${tag}>`);
}

// Providers deliver args as object or JSON string; malformed JSON renders as raw text.
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

// Never throws: a throwing or empty renderer falls back to the default XML.
export function renderToolCallMarkdown(block: ToolCallBlock): string[] {
  const custom = registry().get(block.name);
  if (custom) {
    try {
      const lines = custom(block);
      if (lines && lines.length) return lines;
    } catch {}
  }
  return defaultXmlLines(block);
}
