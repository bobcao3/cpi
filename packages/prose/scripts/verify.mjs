import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import { registry_server } from "../../cli/scripts/registry-server.mjs";
import {
  digest,
  execute,
  json,
  names,
  public_version,
  validate,
} from "./release.mjs";

assert(
  process.argv.length === 3 ||
    (process.argv.length === 4 && process.argv[3] === "--public"),
  "Usage: verify.mjs OUTPUT_DIRECTORY [--public]",
);
const output = resolve(process.argv[2]);
const public_registry = process.argv[3] === "--public";
const { packages, packagesSha256 } = await validate(output);
const report_path = join(
  output,
  public_registry ? "public-verification.json" : "prose-verification.json",
);
await rm(report_path, { force: true });
if (public_registry) {
  const deadline = Date.now() + 300000;
  for (const pkg of packages) {
    for (let attempt = 0; attempt < 31; attempt++) {
      if (await public_version(pkg)) break;
      assert(
        attempt < 30 && Date.now() < deadline,
        `${pkg.name}: public registry availability deadline exceeded`,
      );
      await setTimeout(10000);
    }
  }
}
const temporary = await mkdtemp(join(output, ".verify-"));
let server;
const results = [];
try {
  if (!public_registry)
    server = await registry_server(output, packages, new Set());
  for (const manager of ["npm", "bun"]) {
    const prefix = join(temporary, manager);
    const runtime = join(prefix, "r");
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const home = join(prefix, "home");
    await mkdir(home);
    await mkdir(join(prefix, "tmp"));
    await writeFile(
      join(prefix, "package.json"),
      '{"name":"prose-consumer","private":true,"type":"module"}\n',
    );
    await writeFile(join(prefix, "npmrc"), "");
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^(?:CPI_|PI_|GHOSTMUX_|JITI_|UV_|PYTHON|VIRTUAL_ENV|CONDA|BUN_|npm_config_|NPM_CONFIG_|NODE_|XDG_|HF_|HUGGINGFACE_|TORCH|OMP_|MKL_)/i.test(
          key,
        )
      )
        delete env[key];
    delete env.NPM_TOKEN;
    Object.assign(env, {
      HOME: home,
      PATH: process.env.PATH.split(delimiter)
        .filter((path) => !path.includes("node_modules"))
        .join(delimiter),
      NODE_PATH: "",
      NODE_OPTIONS: "",
      PYTHONNOUSERSITE: "1",
      XDG_CONFIG_HOME: join(prefix, "config"),
      XDG_CACHE_HOME: join(prefix, "cache"),
      XDG_RUNTIME_DIR: ".",
      TMPDIR: join(prefix, "tmp"),
      npm_config_userconfig: join(prefix, "npmrc"),
      npm_config_globalconfig: join(prefix, "npmrc-global"),
      npm_config_cache: join(prefix, "npm-cache"),
      npm_config_ignore_scripts: "true",
      BUN_INSTALL_CACHE_DIR: join(prefix, "bun-cache"),
      UV_CACHE_DIR: join(temporary, "uv-cache"),
      UV_PYTHON_INSTALL_DIR: join(temporary, "python"),
      CPI_PROSE_IDLE_SECONDS: "30",
      CPI_PROSE_DEVICE: "cpu",
      CPI_PROSE_TONE_MODEL: "",
      CPI_PROSE_STYLE_MODEL: "",
      CPI_PROSE_COMPILE: "0",
      OMP_NUM_THREADS: "2",
      MKL_NUM_THREADS: "2",
    });
    await writeFile(env.npm_config_globalconfig, "");
    const registry = server?.url ?? "https://registry.npmjs.org";
    const args =
      manager === "npm"
        ? ["install", "--no-audit", "--no-fund", "--fetch-retries=0"]
        : ["add"];
    console.log(
      `Installing ${names[1]}@${packages[1].version} by name using ${manager}, lifecycle scripts disabled`,
    );
    await execute(
      manager,
      [
        ...args,
        "--ignore-scripts",
        `${names[1]}@${packages[1].version}`,
        "--registry",
        registry,
      ],
      { cwd: prefix, env, timeout: 300000 },
    );
    const installed = await realpath(join(prefix, "node_modules", names[1]));
    assert(installed.startsWith(`${prefix}${sep}`));
    const require = createRequire(join(installed, "package.json"));
    const dependency = await realpath(
      require.resolve("@cpi/tree-sitter-wasm/package.json"),
    );
    assert(
      dependency.startsWith(`${prefix}${sep}`),
      "Dependency escaped the isolated consumer",
    );
    assert.equal((await json(dependency)).name, names[0]);
    assert.equal((await json(dependency)).version, packages[0].version);
    const pending = [join(prefix, "node_modules")];
    let entries = 0;
    while (pending.length) {
      for (const entry of await readdir(pending.pop(), {
        withFileTypes: true,
      })) {
        assert(++entries < 5000);
        assert(
          ![
            "@earendil-works",
            "@mariozechner",
            "pi-coding-agent",
            "pi-ai",
            "pi-tui",
          ].includes(entry.name),
          "Unexpected Pi peer in consumer",
        );
        if (entry.isDirectory() && entry.name !== ".cache")
          pending.push(join(entry.parentPath, entry.name));
      }
    }
    const command = join(prefix, "node_modules/.bin/cpi-prose");
    const run = (args, timeout = 900000) =>
      execute(
        manager === "npm" ? command : "bun",
        manager === "npm" ? args : ["--bun", command, ...args],
        { cwd: runtime, env, timeout },
      );
    const flags = [
      "--no-tone",
      "--no-style",
      "--no-compile",
      "--device",
      "cpu",
      "--json",
    ];
    const prose =
      "The orchard keeper checks each branch before sunrise. She removes damaged fruit because healthy trees need room to grow. When the rain stops, the workers carry their baskets home.";
    const comment =
      "The parser keeps each comment beside its declaration. Readers can inspect the source because every span retains its original position.";
    const fixtures = [
      {
        name: "document.txt",
        text: prose,
        extracted: prose,
        kind: "text",
        language: "text",
      },
      {
        name: "source.js",
        text: `/** ${comment} */\nfunction orchard() { return "EXECUTABLE_SENTINEL must never become prose"; }\n`,
        extracted: comment,
        kind: "doc-comment",
        language: "javascript",
      },
    ];
    const analyses = [];
    let primary_error, daemon_pid;
    try {
      assert.match(await run(["--help"], 30000), /Usage: cpi-prose/);
      await run(["cache", "stats", ...flags]);
      const initial = JSON.parse(await run(["status", ...flags], 120000));
      assert.equal(initial.running, true);
      assert(Number.isSafeInteger(initial.pid) && initial.pid > 1);
      daemon_pid = initial.pid;
      for (const fixture of fixtures) {
        const path = join(prefix, fixture.name);
        await writeFile(path, fixture.text);
        const result = JSON.parse(await run(["analyze", path, ...flags]));
        const analysis = result.analysis;
        assert(analysis && analysis.segment_count === 1);
        assert.equal(analysis.sources.length, 1);
        assert.equal(analysis.sources[0].path, path);
        assert.equal(analysis.sources[0].language, fixture.language);
        assert.equal(
          analysis.sources[0].sha256,
          digest(Buffer.from(fixture.text)),
        );
        assert.equal(analysis.segments[0].text.trim(), fixture.extracted);
        assert.equal(analysis.segments[0].kind, fixture.kind);
        assert(
          !analysis.segments.some((segment) =>
            segment.text.includes("EXECUTABLE_SENTINEL"),
          ),
        );
        if (fixture.language === "javascript") {
          assert.equal(analysis.segments[0].scope.documents.name, "orchard");
          assert.equal(analysis.segments[0].start_point.row, 0);
        }
        const metrics = analysis.statistics.descriptive_stats;
        assert(metrics.n_tokens > 15 && metrics.n_sentences >= 2);
        assert(
          Number.isFinite(analysis.statistics.readability.flesch_reading_ease),
        );
        assert.equal(analysis.clauses.status, "enabled");
        assert.equal(analysis.tone.status, "disabled");
        assert.equal(analysis.style.status, "disabled");
        assert(
          analysis.provenance.spacy && analysis.provenance.spacy_model_version,
        );
        analyses.push({
          input: fixture.name,
          tokens: metrics.n_tokens,
          sentences: metrics.n_sentences,
          extraction: fixture.kind,
        });
      }
      const status = JSON.parse(await run(["status", ...flags], 120000));
      assert.equal(status.running, true);
      assert.equal(status.settings.device, "cpu");
    } catch (error) {
      primary_error = error;
    }
    try {
      const stopped = JSON.parse(await run(["stop", ...flags], 120000));
      assert.equal(stopped.running, false);
      assert.equal(
        JSON.parse(await run(["status", ...flags], 120000)).running,
        false,
      );
    } catch (error) {
      if (daemon_pid) {
        try {
          process.kill(-daemon_pid, "SIGKILL");
        } catch (kill_error) {
          if (kill_error.code !== "ESRCH") throw kill_error;
        }
      }
      throw new AggregateError(
        [primary_error, error].filter(Boolean),
        "Installed daemon cleanup failed",
      );
    }
    if (primary_error) throw primary_error;
    results.push({
      manager,
      version: (
        await execute(
          manager === "npm" ? process.execPath : "bun",
          ["--version"],
          { env, cwd: runtime },
        )
      ).trim(),
      analyses,
      daemonStopped: true,
    });
  }
  if (server)
    for (const pkg of packages)
      assert(
        server.requests.includes(`${pkg.name}/-/package.tgz`),
        `Registry tarball was not fetched: ${pkg.name}`,
      );
  await validate(output);
  await writeFile(
    report_path,
    `${JSON.stringify({ packagesSha256, mode: public_registry ? "public" : "isolated", platform: process.platform, arch: process.arch, managers: ["npm", "bun"], lifecycleScripts: false, results, verifiedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(
    `Verified installed Node/Bun CLI and CPU Python text/comment analysis: ${report_path}`,
  );
} finally {
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
