import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseInput } from "./sync-pi-release-input.mjs";
import {
  fetchBytes,
  publishedRelease,
  releaseAsset,
  releaseBase,
  validateArchive,
  validateManifest,
  validatePackage,
  validateReport,
} from "./sync-pi-release-validation.mjs";

test("verified release archives import exact pins and reject altered identity, URLs, reports and payloads", async () => {
  const work = await mkdtemp(join(tmpdir(), "cpi-pin-input-"));
  try {
    const input = releaseInput("cpi-1.1.1-17");
    const revision = "c".repeat(40);
    const name = "@earendil-works/pi-ai";
    const folder = join(work, "package");
    await mkdir(folder);
    const package_json = {
      name,
      version: input.version,
      type: "module",
      dependencies: {},
      files: ["index.js"],
    };
    await writeFile(join(folder, "package.json"), JSON.stringify(package_json));
    await writeFile(join(folder, "index.js"), "export const release = 17;\n");
    const packed = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", work],
      { cwd: folder, encoding: "utf8", timeout: 30000 },
    );
    assert.ifError(packed.error);
    assert.equal(packed.status, 0, packed.stderr);
    const [info] = Object.values(JSON.parse(packed.stdout));
    const bytes = await readFile(join(work, info.filename));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = `${sha256}.tgz`;
    const identity = {
      sha256,
      integrity: info.integrity,
      url: `${releaseBase(input.tag)}${filename}`,
    };
    const artifact = {
      name,
      version: input.version,
      filename,
      dependencies: {},
      ...identity,
      source: identity,
    };
    const manifest = {
      format: 1,
      version: input.version,
      forkRevision: revision,
      upstreamRevision: "d".repeat(40),
      upstreamVersion: "1.1.0",
      upstreamPackages: {},
      artifacts: [artifact],
    };
    const { names } = validateManifest(manifest, input, revision, [name]);
    const archive = await validateArchive(bytes, artifact);
    validatePackage(archive, artifact, manifest, names);
    validatePackage(archive, artifact, manifest, names, true);
    assert.equal(
      archive.payload.get("package/index.js"),
      `420:${createHash("sha256").update("export const release = 17;\n").digest("hex")}`,
    );
    const report = {
      version: input.version,
      forkRevision: revision,
      npm: "passed",
      bun: "passed",
    };
    validateReport(report, manifest);
    for (const mutation of [
      (value) => {
        value.forkRevision = "e".repeat(40);
      },
      (value) => {
        value.version = "1.1.1-cpi.18";
      },
      (value) => {
        value.artifacts[0].url = value.artifacts[0].url.replace(
          input.tag,
          "latest",
        );
      },
      (value) => {
        value.artifacts.push(value.artifacts[0]);
      },
      (value) => {
        value.artifacts[0].dependencies[name] = "latest";
      },
    ]) {
      const invalid = structuredClone(manifest);
      mutation(invalid);
      assert.throws(() => validateManifest(invalid, input, revision, [name]));
    }
    assert.throws(() => validateReport({ ...report, bun: "failed" }, manifest));
    assert.throws(() =>
      validateReport({ ...report, forkRevision: "e".repeat(40) }, manifest),
    );
    await assert.rejects(
      validateArchive(Buffer.from("corrupt bytes"), artifact),
      /SHA-256 mismatch/,
    );
    for (const tag of [
      "cpi-1.1.1-0",
      "cpi-1.1.1-01",
      "cpi-1.1.1-17\nbranch=x",
      "cpi-1.1.1-9007199254740992",
    ])
      assert.throws(() => releaseInput(tag));
    const assets = publishedRelease(
      {
        id: 1,
        tag_name: input.tag,
        draft: false,
        published_at: "2026-10-12T00:00:00Z",
        assets: [
          {
            name: filename,
            state: "uploaded",
            size: bytes.length,
            browser_download_url: identity.url,
          },
        ],
      },
      input.tag,
    );
    assert.equal(
      releaseAsset(assets, input.tag, filename, bytes.length).size,
      bytes.length,
    );
    assert.throws(() =>
      releaseAsset(assets, input.tag, filename, bytes.length - 1),
    );
    assert.throws(() =>
      publishedRelease({ tag_name: input.tag, draft: true }, input.tag),
    );
    const snapshot = join(work, "checkout");
    const scripts = join(snapshot, "packages/cli/scripts");
    await mkdir(scripts, { recursive: true });
    await mkdir(join(snapshot, "packages/harness"), { recursive: true });
    await copyFile(
      new URL("./import-pi.mjs", import.meta.url),
      join(scripts, "import-pi.mjs"),
    );
    await writeFile(
      join(snapshot, "package.json"),
      JSON.stringify({ dependencies: {}, overrides: {} }),
    );
    await writeFile(
      join(snapshot, "packages/cli/package.json"),
      JSON.stringify({ dependencies: {} }),
    );
    await writeFile(
      join(snapshot, "packages/harness/package.json"),
      JSON.stringify({ peerDependencies: { [name]: "old" } }),
    );
    const downloaded = join(work, "downloaded");
    await mkdir(downloaded);
    await writeFile(join(downloaded, filename), bytes);
    await writeFile(
      join(downloaded, "manifest.json"),
      JSON.stringify(manifest),
    );
    const imported = spawnSync(
      process.execPath,
      [join(scripts, "import-pi.mjs"), downloaded, releaseBase(input.tag)],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.ifError(imported.error);
    assert.equal(imported.status, 0, imported.stderr);
    const root = JSON.parse(
      await readFile(join(snapshot, "package.json"), "utf8"),
    );
    assert.equal(root.dependencies[name], identity.url);
    assert.equal(root.overrides[name], identity.url);
    assert.equal(
      JSON.parse(
        await readFile(join(snapshot, "packages/cli/package.json"), "utf8"),
      ).dependencies[name],
      identity.url,
    );
    assert.equal(
      JSON.parse(
        await readFile(join(snapshot, "packages/harness/package.json"), "utf8"),
      ).peerDependencies[name],
      input.version,
    );
    assert.equal(
      JSON.parse(
        await readFile(join(snapshot, "vendor/pi/manifest.json"), "utf8"),
      ).forkRevision,
      revision,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("download transport enforces trusted origins, redirect bounds and declared or streamed limits", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/payload" });
      response.end();
    } else if (request.url === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
    } else if (request.url === "/declared") {
      response.writeHead(200, { "content-length": "1000" });
      response.end("x");
    } else {
      response.write("exact ");
      response.end("payload");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (await fetchBytes(`${origin}/redirect`, 13, [origin])).toString(),
      "exact payload",
    );
    await assert.rejects(fetchBytes(`${origin}/payload`, 13, []), /origin/);
    await assert.rejects(
      fetchBytes(`${origin}/payload`, 5, [origin]),
      /size limit/,
    );
    await assert.rejects(
      fetchBytes(`${origin}/declared`, 5, [origin]),
      /size limit/,
    );
    await assert.rejects(
      fetchBytes(`${origin}/loop`, 13, [origin]),
      /redirect limit/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
