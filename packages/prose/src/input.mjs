import { createReadStream } from "node:fs";
import { chmod, open, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { once } from "node:events";
import { extract_source, extract_tree } from "./extract.mjs";

const languages = new Map([
  [".zig", "zig"],
  [".py", "python"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".hpp", "cpp"],
  [".cc", "cpp"],
  [".cu", "cuda"],
  [".cuh", "cuda"],
  [".rs", "rust"],
  [".go", "go"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".ps1", "powershell"],
  [".toml", "toml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);
const text_extensions = new Set([".md", ".markdown", ".txt", ".rst", ".adoc"]);
const excluded = new Set(["node_modules", "zig-out", "zig-pkg", "__pycache__"]);

async function read_text(path) {
  const chunks = [];
  const stream = path === "-" ? process.stdin : createReadStream(path);
  for await (const chunk of stream) chunks.push(chunk);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

async function paths_in(directory) {
  const pending = [directory],
    files = [];
  while (pending.length) {
    const path = pending.pop();
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (
        entry.name.startsWith(".") ||
        excluded.has(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (
        entry.isFile() &&
        (languages.has(extname(child)) || text_extensions.has(extname(child)))
      )
        files.push(child);
    }
  }
  return files.sort();
}

async function read_file(path, warn = () => {}) {
  const text = await read_text(path);
  const source = path === "-" ? "<stdin>" : path;
  const language = languages.get(extname(path));
  let document;
  if (language) {
    let segments = [];
    if (text.trim()) {
      try {
        segments = await extract_source(language, text, source, warn);
      } catch (error) {
        warn(`Skipping ${source}: ${error.message}`);
      }
    }
    document = {
      segments,
    };
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      ["text", "segments", "blocks", "tree"].some((name) =>
        Object.hasOwn(parsed, name),
      )
    ) {
      document = parsed.tree
        ? {
            segments: extract_tree(parsed.tree, parsed.language, source, warn),
          }
        : parsed;
    } else document = { segments: [{ text, kind: "text", source }] };
  }
  if (!document.segments && typeof document.text === "string")
    document = {
      ...document,
      segments: [{ text: document.text, kind: "text", source }],
    };
  if (!document.segments) return { segments: [], sources: [] };
  const sources = document.sources ?? [
    {
      path: source,
      language: language ?? "text",
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  ];
  return { segments: document.segments, sources };
}

async function write_stream(path) {
  const handle = await open(path, "wx", 0o600);
  await chmod(path, 0o600);
  const stream = handle.createWriteStream();
  return {
    async write(line) {
      if (!stream.write(line)) await once(stream, "drain");
    },
    async close() {
      stream.end();
      await once(stream, "finish");
      await handle.close();
    },
  };
}

export async function stage_document(filename, destination, warn = () => {}) {
  const path = filename === "-" ? filename : await realpath(resolve(filename));
  const output = await write_stream(destination);
  const digest = createHash("sha256");
  const sources = [];
  let count = 0;
  let characters = 0;
  const ingest = async (file, keep_source = false) => {
    const document = await read_file(file, warn);
    for (const segment of document.segments) {
      const line = JSON.stringify(segment) + "\n";
      digest.update(line);
      await output.write(line);
      count++;
      characters += segment.text.length;
    }
    if (document.segments.length || keep_source)
      sources.push(...document.sources);
  };
  try {
    if (path === "-" || !(await stat(path)).isDirectory())
      await ingest(path, true);
    else {
      const files = await paths_in(path);
      if (!files.length)
        throw new Error(
          `Reference directory has no supported source or text files: ${path}`,
        );
      for (const file of files)
        try {
          await ingest(file);
        } catch (error) {
          warn(`Skipping ${file}: ${error.message}`);
        }
    }
  } finally {
    await output.close();
  }
  return {
    corpus: destination,
    sources,
    segment_count: count,
    characters,
    sha256: digest.digest("hex"),
  };
}
