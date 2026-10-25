import { existsSync } from "node:fs";

let parser;

const declarations = new Set([
  "function_declaration",
  "function_definition",
  "class_definition",
  "class_declaration",
  "method_definition",
  "method_declaration",
  "function_item",
  "impl_item",
  "struct_item",
  "enum_item",
  "namespace_definition",
  "variable_declaration",
  "container_field",
  "test_declaration",
]);

function children(node) {
  const result = node.children ?? [];
  if (!Array.isArray(result))
    throw new Error("Tree-sitter children must be an array");
  return result;
}

function named(node) {
  return (
    node.namedChildren ??
    children(node).filter((child) => child.isNamed !== false)
  );
}

function position(node, end = false) {
  const point = end ? node.endPosition : node.startPosition;
  const row = point?.row ?? node[end ? "endRow" : "startRow"];
  const byte_column = point?.column ?? node[end ? "endCol" : "startCol"];
  if (
    !Number.isSafeInteger(row) ||
    !Number.isSafeInteger(byte_column) ||
    row < 0 ||
    byte_column < 0
  )
    throw new Error(
      "Tree-sitter coordinates must be nonnegative row and UTF-8 byte columns",
    );
  return { row, byte_column };
}

function name_of(node) {
  return (
    node.childForFieldName?.("name")?.text ??
    children(node).find((child) => child.fieldName === "name")?.text ??
    named(node).find(
      (child) => child.type === "identifier" || child.type === "string",
    )?.text ??
    null
  );
}

function is_comment(node) {
  return typeof node.type === "string" && node.type.includes("comment");
}

function documentation(node) {
  let selected = node;
  if (node.type === "expression_statement") {
    const contents = named(node);
    if (contents.length !== 1) return null;
    selected = contents[0];
  }
  if (
    selected.type !== "string" ||
    children(selected).some((child) => child.type === "interpolation")
  )
    return null;
  const content = children(selected).filter(
    (child) => child.type === "string_content",
  );
  return content.length === 1 ? content[0] : selected;
}

function drop_space(text) {
  return text.startsWith(" ") ? text.slice(1) : text;
}

function comment_text(raw) {
  const doc =
    raw.startsWith("///") || raw.startsWith("//!") || raw.startsWith("/**");
  if (raw.startsWith("//"))
    return { text: drop_space(raw.slice(doc ? 3 : 2)), doc };
  if (raw.startsWith("#"))
    return { text: drop_space(raw.slice(1)), doc: false };
  if (raw.startsWith("/*") && raw.endsWith("*/")) {
    const body = raw.slice(doc ? 3 : 2, -2);
    const text = body
      .split("\n")
      .map((line) => {
        const trimmed = line.trimStart();
        return trimmed.startsWith("*") ? drop_space(trimmed.slice(1)) : line;
      })
      .join("\n");
    return { text, doc };
  }
  return { text: raw, doc };
}

function attachment(node, parent, language) {
  if (!parent || (language === "zig" && node.text.startsWith("//!")))
    return null;
  const siblings = named(parent);
  let index = siblings.indexOf(node) + 1;
  while (index < siblings.length && is_comment(siblings[index])) index++;
  const next = siblings[index];
  return next ? { kind: next.type, name: name_of(next) } : null;
}

export function extract_tree(root, language, source, warn = () => {}) {
  if (typeof language !== "string" || !language)
    throw new Error("Tree-sitter input requires a language");
  const pending = [
    { node: root, parent: null, scope: [], depth: 0, doc_position: false },
  ];
  const segments = [];
  let visited = 0;
  let parse_errors = 0;
  let first_error = null;
  while (pending.length) {
    let { node, parent, scope, depth, doc_position } = pending.pop();
    if (++visited > 10_000_000 || depth > 10_000)
      throw new Error(`Tree-sitter limits exceeded: ${source}`);
    if (!node || typeof node.type !== "string" || typeof node.text !== "string")
      throw new Error("Tree-sitter nodes require type and text strings");
    if (node.type === "ERROR" || node.isMissing) {
      if (!parse_errors) first_error = position(node);
      parse_errors++;
    }
    if (declarations.has(node.type)) {
      const name = name_of(node);
      if (name) scope = [...scope, { kind: node.type, name }];
    }
    const literal =
      language === "python" && doc_position ? documentation(node) : null;
    if (is_comment(node) || literal) {
      const selected = literal ?? node;
      const parsed = literal
        ? { text: selected.text, doc: true }
        : comment_text(node.text);
      const kind = literal
        ? "docstring"
        : parsed.doc
          ? "doc-comment"
          : "comment";
      const metadata = {
        lexical: scope,
        documents:
          parsed.doc && !literal ? attachment(node, parent, language) : null,
      };
      const start_point = position(selected),
        end_point = position(selected, true);
      const previous = segments.at(-1);
      if (
        previous &&
        previous.kind === kind &&
        previous.end_point.row + 1 === start_point.row &&
        JSON.stringify(previous.scope) === JSON.stringify(metadata)
      ) {
        previous.text += "\n" + parsed.text;
        previous.end_point = end_point;
      } else {
        segments.push({
          text: parsed.text,
          kind,
          scope: metadata,
          source,
          start_point,
          end_point,
        });
      }
    }
    const python_body =
      language === "python" &&
      (node.type === "module" || node.type === "block");
    const first = python_body
      ? named(node).find((child) => !is_comment(child))
      : null;
    for (const child of children(node).toReversed())
      pending.push({
        node: child,
        parent: node,
        scope,
        depth: depth + 1,
        doc_position: child === first,
      });
  }
  if (parse_errors)
    warn(
      `Tree-sitter parse error: ${source}:${first_error.row + 1} (${parse_errors} syntax ${parse_errors === 1 ? "error" : "errors"}); using recovered tree`,
    );
  return segments.filter((segment) => segment.text.trim());
}

export async function extract_source(language, text, source, warn) {
  const checkout = new URL("../../tree-sitter-wasm/index.ts", import.meta.url);
  parser ??= import(
    existsSync(checkout) ? checkout.href : "@cpi/tree-sitter-wasm"
  );
  const { parseLangCommand } = await parser;
  const parsed = await parseLangCommand(language, text);
  if (!parsed.available || !parsed.node)
    throw new Error(`Tree-sitter parser unavailable for ${language}`);
  return extract_tree(parsed.node, language, source, warn);
}
