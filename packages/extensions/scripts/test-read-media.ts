import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@cpi/cli";
import { localFixture } from "./local-fixture.mjs";
import {
  detectImageMimeType,
  sniffMediaType,
} from "../extensions/lib/media.ts";

const directory = await mkdtemp(join(tmpdir(), "cpi-read-media-"));
const fixtures: Awaited<ReturnType<typeof localFixture>>[] = [];
try {
  for (const vision of [true, false]) {
    const local = await localFixture(
      () => {
        throw new Error("Media reads must not prompt a model");
      },
      { input: vision ? ["text", "image"] : ["text"] },
    );
    fixtures.push(local);
    const services = await createAgentSessionServices({
      cwd: directory,
      agentDir: local.agentDir,
      modelRuntime: local.runtime,
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(directory),
      model: local.model,
      tools: ["read"],
    });
    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          throw new Error(error.error);
        },
      });
      const read = session.extensionRunner.getToolDefinition("read")!;
      assert.ok(read);
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
        const result = await read.execute(
          "media",
          { path },
          undefined,
          undefined,
          session.extensionRunner.createToolContext("media", undefined),
        );
        if (vision) {
          const image = result.content.find((part) => part.type === "image");
          assert.ok(image && image.type === "image", JSON.stringify(result));
          assert.equal(
            image.mimeType,
            format === "avif" ? "image/webp" : `image/${format}`,
          );
          const metadata = await sharp(
            Buffer.from(image.data, "base64"),
          ).metadata();
          assert.equal(metadata.width, 64);
          assert.equal(metadata.height, 32);
        } else assert.ok(result.content.every((part) => part.type === "text"));
      }
      assert.equal(local.requests.length, 0);
    } finally {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    }
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
    "Media reads: real SDK tool contexts, AVIF conversion, PNG/WebP, non-vision, and signatures passed.",
  );
} finally {
  for (const fixture of fixtures.reverse()) await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
