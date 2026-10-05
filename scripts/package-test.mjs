import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

export function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

export function pack(directory, destination) {
  const result = JSON.parse(
    execute(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
      { cwd: directory, shell: process.platform === "win32" },
    ),
  );
  return join(destination, Object.values(result)[0].filename);
}

export async function registry(artifacts) {
  const entries = new Map();
  for (const { directory, archive } of artifacts) {
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    entries.set(manifest.name, { manifest, bytes: await readFile(archive) });
  }
  const requests = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    ).slice(1);
    requests.push(path);
    assert(requests.length < 200, "Unexpected registry request loop");
    const name = path.replace(/\/-\/package.tgz$/, "");
    const entry = entries.get(name);
    if (!entry) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    if (path.endsWith("/-/package.tgz")) {
      response.end(entry.bytes);
      return;
    }
    const { manifest, bytes } = entry;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: manifest.version },
        versions: {
          [manifest.version]: {
            ...manifest,
            dist: {
              tarball: `http://127.0.0.1:${server.address().port}/${name}/-/package.tgz`,
              integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
            },
          },
        },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function install(manager, directory, name, url, flags = []) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    '{"name":"isolated-consumer","private":true,"type":"module"}\n',
  );
  const command =
    manager === "npm" && process.platform === "win32" ? "npm.cmd" : manager;
  const args =
    manager === "npm"
      ? [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--fetch-retries=0",
        ]
      : ["add", "--ignore-scripts"];
  await new Promise((resolve, reject) => {
    const child = spawn(command, [...args, name, ...flags, "--registry", url], {
      cwd: directory,
      shell: manager === "npm" && process.platform === "win32",
      env: {
        ...process.env,
        npm_config_cache: join(directory, "cache"),
        BUN_INSTALL_CACHE_DIR: join(directory, "cache"),
      },
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output += chunk;
        if (output.length > 8 * 1024 * 1024) child.kill();
      });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(output)),
    );
  });
}
