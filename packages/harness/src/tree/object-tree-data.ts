import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface ObjectTreeNode {
  path: string;
  key: string;
  kind:
    | "object"
    | "array"
    | "string"
    | "number"
    | "boolean"
    | "null"
    | "notice";
  value: string;
  children: ObjectTreeNode[];
  limited: boolean;
}

export function tree_text(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\t/g, "  ");
}

export function parseTreeOutput(text: string): unknown {
  if (text.length > 262144) return text;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length > 1 && lines.length <= 2048) {
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {}
  }
  return text;
}

export function tree_snapshot(input: unknown): ObjectTreeNode {
  const root: ObjectTreeNode = {
    path: "",
    key: "",
    kind: "null",
    value: "null",
    children: [],
    limited: false,
  };
  const queue = [{ input, node: root, depth: 0 }];
  const seen = new WeakMap<object, string>();
  let characters = 262144;
  let properties = 0;
  for (let index = 0; index < queue.length; index++) {
    const { input: value, node, depth } = queue[index];
    if (value === null) continue;
    if (typeof value === "string") {
      node.kind = "string";
      const length = Math.min(value.length, 65536, characters);
      node.value = tree_text(value.slice(0, length));
      node.limited = length < value.length;
      characters -= length;
    } else if (typeof value === "number" || typeof value === "boolean") {
      node.kind = typeof value as "number" | "boolean";
      node.value = String(value);
    } else if (typeof value !== "object") {
      node.kind = "notice";
      node.value = `[${typeof value}]`;
    } else if (seen.has(value) || depth >= 32) {
      node.kind = "notice";
      node.value = seen.has(value)
        ? `[reference: ${seen.get(value) || "/"}]`
        : "[depth limit]";
    } else {
      seen.set(value, node.path);
      node.kind = Array.isArray(value) ? "array" : "object";
      node.value = node.kind === "array" ? "[]" : "{}";
      const mime = Object.getOwnPropertyDescriptor(value, "mimeType")?.value;
      const image =
        Object.getOwnPropertyDescriptor(value, "type")?.value === "image" &&
        typeof mime === "string" &&
        mime.startsWith("image/");
      for (const key in value) {
        if (++properties > 8192) {
          node.limited = true;
          break;
        }
        if (!Object.hasOwn(value, key)) continue;
        if (
          queue.length >= 2048 ||
          node.children.length >= 512 ||
          characters <= 0
        ) {
          node.limited = true;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        if (key.length > 256 || key.length > characters) {
          node.limited = true;
          break;
        }
        characters -= key.length;
        const child: ObjectTreeNode = {
          path: `${node.path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
          key,
          kind: "null",
          value: "null",
          children: [],
          limited: false,
        };
        node.children.push(child);
        if (!("value" in descriptor) || (image && key === "data")) {
          child.kind = "notice";
          child.value = image && key === "data" ? "[image data]" : "[accessor]";
        } else
          queue.push({
            input: descriptor.value,
            node: child,
            depth: depth + 1,
          });
      }
    }
  }
  return root;
}
