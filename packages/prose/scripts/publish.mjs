import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verify_release_tag } from "../../cli/scripts/release-registry.mjs";
import {
  execute,
  json,
  public_version,
  release_tag,
  validate,
} from "./release.mjs";

assert.equal(
  process.argv.length,
  3,
  "Usage: publish.mjs VERIFIED_OUTPUT_DIRECTORY",
);
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Publication is restricted to GitHub Actions OIDC",
);
assert.equal(process.env.GITHUB_REPOSITORY, "bobcao3/cpi");
assert.equal(process.env.GITHUB_REF_TYPE, "tag");
assert(
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  "Publishing requires id-token: write",
);
assert(
  !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN,
  "Use OIDC, not an npm token",
);
const output = resolve(process.argv[2]);
const { packages, packagesSha256 } = await validate(output);
const tag = release_tag(packages[1].version);
assert(tag, "Publication requires a prose-vX.Y.Z tag");
assert.equal(verify_release_tag(), tag);
for (const pkg of packages) {
  assert.equal(pkg.source.tag, tag);
  assert.equal(
    pkg.source.revision,
    process.env.GITHUB_SHA,
    "Package source differs from the release tag",
  );
}
const report = await json(join(output, "prose-verification.json"));
assert.equal(
  report.packagesSha256,
  packagesSha256,
  "Verification belongs to different package bytes",
);
assert.equal(report.mode, "isolated");
assert.deepEqual(report.managers, ["npm", "bun"]);
assert.equal(report.lifecycleScripts, false);
assert.deepEqual(
  report.results.map((result) => result.manager),
  ["npm", "bun"],
);
for (const result of report.results) {
  assert.equal(result.daemonStopped, true);
  assert.match(result.version, /^v?\d+\.\d+\.\d+/);
  assert.deepEqual(
    result.analyses.map((analysis) => analysis.input),
    ["document.txt", "source.js"],
  );
  assert.deepEqual(
    result.analyses.map((analysis) => analysis.extraction),
    ["text", "doc-comment"],
  );
  for (const analysis of result.analyses)
    assert(analysis.tokens > 15 && analysis.sentences >= 2);
}
const version = (await execute("npm", ["--version"]))
  .trim()
  .split(".")
  .map(Number);
assert(
  version[0] > 11 ||
    (version[0] === 11 &&
      (version[1] > 5 || (version[1] === 5 && version[2] >= 1))),
  "npm >=11.5.1 is required for trusted publishing",
);
const pending = [];
for (const pkg of packages) if (!(await public_version(pkg))) pending.push(pkg);
const temporary = await mkdtemp(join(output, ".publish-"));
try {
  const userconfig = join(temporary, "npmrc");
  const globalconfig = join(temporary, "global-npmrc");
  await writeFile(userconfig, "");
  await writeFile(globalconfig, "");
  await mkdir(join(temporary, "cache"));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(?:npm_config_|NPM_CONFIG_|NODE_AUTH_TOKEN$|NPM_TOKEN$)/i.test(key))
      delete env[key];
  Object.assign(env, {
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: join(temporary, "cache"),
  });
  for (const pkg of pending) {
    assert.equal(verify_release_tag(), tag);
    const current = await validate(output);
    assert.equal(
      current.packagesSha256,
      packagesSha256,
      "Package metadata changed during publication",
    );
    if (await public_version(pkg)) continue;
    await execute(
      "npm",
      [
        "publish",
        join(output, pkg.filename),
        "--registry",
        "https://registry.npmjs.org/",
        "--access",
        "public",
        "--tag",
        "latest",
        "--ignore-scripts",
        "--provenance",
      ],
      { cwd: temporary, env, timeout: 180000 },
    );
    console.log(
      `Published ${pkg.name}@${pkg.version} through OIDC with provenance`,
    );
  }
  console.log(
    "Prose publication complete; WASM was checked and published before prose.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
