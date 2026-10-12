import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { archive_manifest } from "./registry-archive.mjs";
import { release_assets } from "./release-registry.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function run(script, args, env = process.env) {
  const child = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(child.error);
  return child;
}

test(
  "version tags control every staged cpi package without changing source or Pi pins",
  { timeout: 300000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "cpi-registry-tag-"));
    const source_paths = [
      "package.json",
      "packages/cli/package.json",
      "vendor/pi/manifest.json",
    ];
    const originals = await Promise.all(
      source_paths.map((path) => readFile(join(root, path))),
    );
    try {
      const invalid = join(work, "invalid");
      for (const tag of ["0.0.4", "v01.2.3", "v1.2.3-beta", "v1.2.3/other"]) {
        const child = run(
          "packages/cli/scripts/package-registry.mjs",
          ["missing-native", invalid],
          {
            ...process.env,
            CPI_RELEASE_TAG: tag,
          },
        );
        assert.notEqual(child.status, 0);
        assert.match(child.stderr, /Invalid cpi release tag/);
        await assert.rejects(access(invalid), { code: "ENOENT" });
      }
      const native =
        process.env.CPI_NATIVE_TEST_DIRECTORY ?? join(work, "native");
      if (!process.env.CPI_NATIVE_TEST_DIRECTORY) {
        const fetched = run("scripts/ci-native-artifacts.mjs", [
          native,
          "--all",
        ]);
        assert.equal(fetched.status, 0, fetched.stdout + fetched.stderr);
      }
      const destination = join(work, "registry");
      const built = run(
        "packages/cli/scripts/package-registry.mjs",
        [native, destination],
        {
          ...process.env,
          CPI_RELEASE_TAG: "v9.8.7",
        },
      );
      assert.equal(built.status, 0, built.stdout + built.stderr);
      const packages = JSON.parse(
        await readFile(join(destination, "packages.json"), "utf8"),
      );
      const fork = JSON.parse(originals[2]);
      const fork_versions = new Map(
        fork.artifacts.map((artifact) => [
          artifact.name.replace("@earendil-works/", "@bobcao3/"),
          artifact.version,
        ]),
      );
      for (const pkg of packages) {
        const manifest = await archive_manifest(
          join(destination, pkg.filename),
        );
        assert.equal(manifest.version, pkg.version);
        const first_party =
          pkg.name === "@bobcao3/cpi" || pkg.name.startsWith("@bobcao3/cpi-");
        assert.equal(
          pkg.version,
          first_party ? "9.8.7" : fork_versions.get(pkg.name),
        );
        for (const field of ["dependencies", "optionalDependencies"])
          for (const [name, value] of Object.entries(manifest[field] ?? {}))
            if (name.startsWith("@cpi/")) assert.match(value, /@9\.8\.7$/);
      }
      const assets = await release_assets(destination, "v9.8.7");
      assert.equal(assets.length, packages.length + 3);
      await assert.rejects(
        release_assets(destination, "v9.8.8"),
        /Version disagrees/,
      );
      const archive = join(destination, packages.at(-1).filename);
      const damaged = await readFile(archive);
      damaged[damaged.length - 1] ^= 1;
      await writeFile(archive, damaged);
      await assert.rejects(release_assets(destination, "v9.8.7"));
      assert.deepEqual(
        await Promise.all(
          source_paths.map((path) => readFile(join(root, path))),
        ),
        originals,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
