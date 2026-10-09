import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { archive_manifest } from "./registry-archive.mjs";

export async function registry_server(directory, packages, upstream_packages) {
  const entries = new Map();
  for (const pkg of packages)
    entries.set(pkg.name, {
      manifest: await archive_manifest(join(directory, pkg.filename)),
      bytes: await readFile(join(directory, pkg.filename)),
      integrity: pkg.integrity,
    });
  const requests = [];
  let url;
  const server = createServer((request, response) => {
    serve(request, response).catch((error) => {
      response.writeHead(502);
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  async function serve(request, response) {
    const path = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    ).slice(1);
    requests.push(path);
    assert(requests.length <= 5000, "Registry request limit exceeded");
    const name = path.replace(/\/-\/package.tgz$/, "");
    const entry = entries.get(name);
    if (entry) {
      if (path.endsWith("/-/package.tgz")) return response.end(entry.bytes);
      response.setHeader("content-type", "application/json");
      return response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: entry.manifest.version },
          versions: {
            [entry.manifest.version]: {
              ...entry.manifest,
              dist: {
                tarball: `${url}/${name}/-/package.tgz`,
                integrity: entry.integrity,
              },
            },
          },
        }),
      );
    }
    if (
      path.startsWith("@bobcao3/") ||
      (path.startsWith("@earendil-works/") &&
        !upstream_packages.has(path.split("/-/")[0])) ||
      path.startsWith("@cpi/")
    ) {
      response.writeHead(404);
      return response.end("{}");
    }
    const upstream = await fetch(
      `https://registry.npmjs.org/${request.url.slice(1)}`,
      {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(60000),
      },
    );
    response.statusCode = upstream.status;
    if (path.endsWith(".tgz")) {
      const bytes = Buffer.from(await upstream.arrayBuffer());
      assert(bytes.length < 128 * 1024 * 1024);
      return response.end(bytes);
    }
    const document = await upstream.json();
    for (const version of Object.values(document.versions ?? {})) {
      if (version.dist?.tarball) {
        const tarball = new URL(version.dist.tarball);
        assert.equal(tarball.origin, "https://registry.npmjs.org");
        version.dist.tarball = `${url}${tarball.pathname}`;
      }
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(document));
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
