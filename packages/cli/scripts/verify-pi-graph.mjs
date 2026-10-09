import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function verifyPiGraph(installed, fork) {
  const expected = new Map(
    fork.artifacts.map((artifact) => [artifact.name, artifact]),
  );
  const upstream = new Map(Object.entries(fork.upstreamPackages));
  const foundForks = new Set();
  const foundUpstream = new Set();
  const queue = [installed];
  let files = 0;
  for (const directory of queue) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(++files < 60000, "Installed dependency scan exceeds file limit");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        assert(
          directory.endsWith("/.bin"),
          `Installed package contains a development link: ${path}`,
        );
      } else if (entry.isDirectory()) queue.push(path);
      else if (
        entry.name === "package.json" &&
        /\/node_modules\/(?:@[^/]+\/)?[^/]+$/.test(directory)
      ) {
        const manifest = JSON.parse(await readFile(path, "utf8"));
        if (
          !manifest.name?.startsWith("@earendil-works/") &&
          !manifest.name?.startsWith("@bobcao3/pi-")
        )
          continue;
        if (expected.has(manifest.name)) {
          assert(
            !foundForks.has(manifest.name),
            `Duplicate fork runtime: ${manifest.name}`,
          );
          assert.equal(
            manifest.version,
            expected.get(manifest.name).version,
            `Wrong fork version: ${manifest.name}`,
          );
          assert.equal(
            manifest.cpiFork?.integrity,
            expected.get(manifest.name).integrity,
            `Wrong fork provenance: ${manifest.name}`,
          );
          foundForks.add(manifest.name);
        } else {
          assert(
            upstream.has(manifest.name),
            `Unexpected upstream runtime: ${manifest.name}`,
          );
          assert(
            !foundUpstream.has(manifest.name),
            `Duplicate upstream runtime: ${manifest.name}`,
          );
          assert.equal(
            manifest.version,
            upstream.get(manifest.name),
            `Wrong upstream version: ${manifest.name}`,
          );
          assert.equal(
            manifest.cpiFork,
            undefined,
            `Upstream runtime has fork provenance: ${manifest.name}`,
          );
          foundUpstream.add(manifest.name);
        }
      }
    }
  }
  assert.deepEqual(
    foundForks,
    new Set(expected.keys()),
    "Missing fork runtime",
  );
  assert.deepEqual(
    foundUpstream,
    new Set(upstream.keys()),
    "Missing upstream runtime",
  );
}
