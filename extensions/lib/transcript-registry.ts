// Renderers live in globalThis because jiti module state is per-importer.

export interface ToolCallBlock {
  type: "toolCall";
  name: string;
  id?: string;
  // Providers may deliver `arguments` as a JSON string rather than an object.
  arguments?: unknown;
}

// Markdown lines for the block, or null to defer to the default summary renderer.
export type ToolCallMarkdownRenderer = (
  block: ToolCallBlock,
) => string[] | null;

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

const SUMMARY_KEYS = ["description", "describe", "instruction"];
const MAX_SUMMARY_CHARS = 160;

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

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// One-line call summary: `[edit|ed0007]: fix the bug · src/x.ts`.
export function toolCallSummaryLine(block: ToolCallBlock): string {
  const args = parseArgs(block);
  const fields: string[] = [];
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const rec = args as Record<string, unknown>;
    const desc = firstString(rec, SUMMARY_KEYS);
    if (desc)
      fields.push(truncate(desc.replace(/\s+/g, " "), MAX_SUMMARY_CHARS));
    if (typeof rec.path === "string" && rec.path) fields.push(rec.path);
  }
  const head = `[${block.name}|${shortToolCallId(block.id, block.name)}]`;
  return fields.length ? `${head}: ${fields.join(" · ")}` : head;
}

// Never throws: a throwing or empty renderer falls back to the default summary line.
export function renderToolCallMarkdown(block: ToolCallBlock): string[] {
  const custom = registry().get(block.name);
  if (custom) {
    try {
      const lines = custom(block);
      if (lines && lines.length) return lines;
    } catch {}
  }
  return [toolCallSummaryLine(block)];
}
