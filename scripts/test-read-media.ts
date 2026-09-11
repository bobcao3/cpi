import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readTool } from "../extensions/llm-editor/tool.ts";
import {
  detectImageMimeType,
  sniffMediaType,
} from "../extensions/lib/media.ts";

const directory = await mkdtemp(join(tmpdir(), "cpi-read-media-"));
const context = (vision: boolean) =>
  ({ model: { input: vision ? ["image"] : ["text"] } }) as ExtensionContext;
try {
  for (const format of ["avif", "png", "webp"] as const) {
    const path = join(directory, `image.${format.toUpperCase()}`);
    await sharp({
      create: { width: 64, height: 32, channels: 4, background: "red" },
    })
      .toFormat(format)
      .toFile(path);
    assert.deepEqual(await sniffMediaType(path), {
      kind: "image",
      mime: `image/${format}`,
    });
    const result = await readTool.execute(
      "test",
      { path },
      undefined,
      undefined,
      context(true),
    );
    const image = result.content.find((part) => part.type === "image");
    assert.ok(image && image.type === "image", JSON.stringify(result));
    assert.equal(
      image.mimeType,
      format === "avif" ? "image/webp" : `image/${format}`,
    );
    const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
    assert.equal(metadata.width, 64);
    assert.equal(metadata.height, 32);
    const text = await readTool.execute(
      "test",
      { path },
      undefined,
      undefined,
      context(false),
    );
    assert.ok(text.content.every((part) => part.type === "text"));
  }
  const header = Buffer.alloc(24);
  header.writeUInt32BE(24);
  header.write("ftypmif1", 4);
  header.write("avif", 20);
  assert.equal(detectImageMimeType(header), "image/avif");
  header.write("avis", 20);
  assert.equal(detectImageMimeType(header), "image/avif");
  header.write("mp42", 20);
  assert.equal(detectImageMimeType(header), null);
  header.write("avif", 12);
  assert.equal(detectImageMimeType(header), null);
  const textPath = join(directory, "text.avif");
  await writeFile(textPath, "not an image");
  assert.equal(await sniffMediaType(textPath), null);
  console.log(
    "Media reads: AVIF conversion, PNG/WebP, non-vision, and signature checks passed.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
