import assert from "node:assert/strict";
import { list } from "tar";

export async function archive_manifest(archive) {
  let manifest;
  let pending;
  await list({
    file: archive,
    onReadEntry(entry) {
      if (entry.path !== "package/package.json") return;
      assert(!pending, "Duplicate package manifest");
      assert(entry.size < 1024 * 1024);
      pending = new Promise((resolve, reject) => {
        const chunks = [];
        entry.on("data", (chunk) => chunks.push(chunk));
        entry.on("error", reject);
        entry.on("end", () => {
          try {
            manifest = JSON.parse(Buffer.concat(chunks).toString());
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    },
  });
  await pending;
  assert(manifest, "Missing package manifest");
  return manifest;
}
