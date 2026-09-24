/** Per-language server installs: npm prefix, uv venv, `go install`, and zls release download. Each returns a binary whose version is re-checked after install. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type LspServerSpec } from "./registry.ts";
import {
  IS_WIN,
  download,
  extractArchive,
  platformKey,
  sha256File,
} from "./release.ts";
import { installZls } from "./zls.ts";
import {
  installedNpmTarget,
  launchTarget,
  npmCliTarget,
  runCapture,
  runToCompletion,
  whichOnPath,
} from "./process.ts";
import { type ResolveOptions, type ResolveResult } from "./provision.ts";

const execFileAsync = promisify(execFile);

// Linux uses musl assets for static binaries.
const UV_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

function parseSha256(content: string): string | null {
  const m = content
    .trim()
    .split("\n")[0]
    .match(/[0-9a-fA-F]{64}/);
  return m ? m[0].toLowerCase() : null;
}

async function ensureUv(
  opts: ResolveOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const want = opts.uv.version;
  const dir = join(getAgentDir(), "cache", "uv", "bin");
  const bin = join(dir, IS_WIN ? "uv.exe" : "uv");
  if (existsSync(bin)) {
    try {
      const v = await runCapture(
        launchTarget(bin, env),
        ["--version"],
        dir,
        env,
        opts.installTimeoutMs,
      );
      if (v.includes(want)) return bin;
    } catch {}
  }
  const target = UV_TARGETS[platformKey()];
  if (!target) throw new Error(`no uv asset for ${platformKey()}`);
  const aname = `uv-${target}${IS_WIN ? ".zip" : ".tar.gz"}`;
  const url = `https://github.com/${opts.uv.repo}/releases/download/${want}/${aname}`;
  const tmp = join(tmpdir(), `pi-uv-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  const archive = join(tmp, aname);
  try {
    await download(url, archive);
    await verifyUv(archive, aname, want, opts, tmp);
    await extractArchive(archive, IS_WIN ? "zip" : "tar.gz", tmp, env);
    const extracted = IS_WIN
      ? join(tmp, "uv.exe")
      : join(tmp, `uv-${target}`, "uv");
    await mkdir(dir, { recursive: true });
    await copyFile(extracted, bin);
    if (!IS_WIN) await chmod(bin, 0o755);
    const v = await runCapture(
      launchTarget(bin, env),
      ["--version"],
      dir,
      env,
      opts.installTimeoutMs,
    );
    if (!v.includes(want)) throw new Error(`uv version mismatch: ${v}`);
    return bin;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function verifyUv(
  archive: string,
  aname: string,
  want: string,
  opts: ResolveOptions,
  tmp: string,
): Promise<void> {
  // Attestation first, sha256 as fallback.
  if (opts.uv.verify === "attestation-then-sha256") {
    try {
      await execFileAsync(
        "gh",
        ["attestation", "verify", archive, "--repo", opts.uv.repo],
        {
          timeout: opts.installTimeoutMs,
          windowsHide: true,
        },
      );
      return;
    } catch {}
  }
  const shaUrl = `https://github.com/${opts.uv.repo}/releases/download/${want}/${aname}.sha256`;
  const shaTmp = join(tmp, `${aname}.sha256`);
  await download(shaUrl, shaTmp);
  const expected = parseSha256(await readFile(shaTmp, "utf8"));
  const actual = sha256File(archive);
  if (!expected || actual !== expected) {
    throw new Error(`uv sha256 mismatch: expected ${expected} got ${actual}`);
  }
}

async function installNpm(
  spec: LspServerSpec,
  opts: ResolveOptions,
  env: NodeJS.ProcessEnv,
): Promise<ResolveResult> {
  const envDir = join(getAgentDir(), "lsp_envs", "typescript");
  const packageName = spec.install.package!;
  const want = spec.install.version;
  await mkdir(envDir, { recursive: true });
  let target = installedNpmTarget(envDir, packageName, spec.binName);
  if (target) {
    try {
      const version = await runCapture(
        target,
        ["--version"],
        envDir,
        env,
        opts.installTimeoutMs,
      );
      if (want && version.includes(want))
        return { ...target, source: "installed" };
    } catch {}
  }
  const pkgJson = join(envDir, "package.json");
  if (!existsSync(pkgJson))
    await writeFile(
      pkgJson,
      JSON.stringify({ name: "cpi-lsp-typescript", private: true }),
    );
  const packages = [`${packageName}@${want}`];
  if (spec.install.tsVersion)
    packages.push(`typescript@${spec.install.tsVersion}`);
  const npm = npmCliTarget(env);
  if (!npm) throw new Error("npm CLI entry not found");
  await runToCompletion(
    npm,
    ["install", "--prefix", envDir, ...packages],
    envDir,
    env,
    opts.installTimeoutMs,
  );
  target = installedNpmTarget(envDir, packageName, spec.binName);
  if (!target) throw new Error("tsserver package entry missing after install");
  const version = await runCapture(
    target,
    ["--version"],
    envDir,
    env,
    opts.installTimeoutMs,
  );
  if (want && !version.includes(want))
    throw new Error(`tsserver version mismatch after install: ${version}`);
  return { ...target, source: "installed" };
}

async function installUvServer(
  spec: LspServerSpec,
  opts: ResolveOptions,
  env: NodeJS.ProcessEnv,
): Promise<ResolveResult> {
  const uvBin = await ensureUv(opts, env);
  const envDir = join(getAgentDir(), "lsp_envs", "python");
  await mkdir(envDir, { recursive: true });
  const bin = join(
    envDir,
    IS_WIN ? "Scripts" : "bin",
    IS_WIN ? "pyrefly.exe" : "pyrefly",
  );
  const want = spec.install.version;
  if (existsSync(bin)) {
    try {
      const v = await runCapture(
        launchTarget(bin, env),
        ["--version"],
        envDir,
        env,
        opts.installTimeoutMs,
      );
      if (want && v.includes(want))
        return { ...launchTarget(bin, env), source: "installed" };
    } catch {}
  }
  const venvPython = join(
    envDir,
    IS_WIN ? "Scripts" : "bin",
    IS_WIN ? "python.exe" : "python",
  );
  await runToCompletion(
    launchTarget(uvBin, env),
    ["venv", envDir],
    envDir,
    env,
    opts.installTimeoutMs,
  );
  await runToCompletion(
    launchTarget(uvBin, env),
    [
      "pip",
      "install",
      "--python",
      venvPython,
      `${spec.install.package}==${want}`,
    ],
    envDir,
    env,
    opts.installTimeoutMs,
  );
  if (!existsSync(bin)) throw new Error("pyrefly binary missing after install");
  const v = await runCapture(
    launchTarget(bin, env),
    ["--version"],
    envDir,
    env,
    opts.installTimeoutMs,
  );
  if (want && !v.includes(want))
    throw new Error(`pyrefly version mismatch after install: ${v}`);
  return { ...launchTarget(bin, env), source: "installed" };
}

async function installGo(
  spec: LspServerSpec,
  opts: ResolveOptions,
  env: NodeJS.ProcessEnv,
): Promise<ResolveResult> {
  const envDir = join(getAgentDir(), "lsp_envs", "go");
  const binDir = join(envDir, "bin");
  const bin = join(binDir, IS_WIN ? "gopls.exe" : "gopls");
  const target = launchTarget(bin, env);
  const want = spec.install.version;
  if (existsSync(bin)) {
    try {
      const v = await runCapture(
        target,
        ["version"],
        envDir,
        env,
        opts.installTimeoutMs,
      );
      if (want && v.includes(want)) return { ...target, source: "installed" };
    } catch {}
  }
  const go = whichOnPath("go", env);
  if (!go) throw new Error("go toolchain not found on PATH");
  await mkdir(binDir, { recursive: true });
  await runToCompletion(
    launchTarget(go, env),
    ["install", `${spec.install.package}@${want}`],
    envDir,
    { ...env, GOBIN: binDir },
    opts.installTimeoutMs,
  );
  if (!existsSync(bin)) throw new Error("gopls binary missing after install");
  const v = await runCapture(
    target,
    ["version"],
    envDir,
    env,
    opts.installTimeoutMs,
  );
  if (want && !v.includes(want))
    throw new Error(`gopls version mismatch after install: ${v.trim()}`);
  return { ...target, source: "installed" };
}

export async function installServer(
  spec: LspServerSpec,
  opts: ResolveOptions,
  env: NodeJS.ProcessEnv,
): Promise<ResolveResult> {
  switch (spec.install.method) {
    case "npm":
      return installNpm(spec, opts, env);
    case "uv":
      return installUvServer(spec, opts, env);
    case "go":
      return installGo(spec, opts, env);
    case "zls":
      return installZls(spec, opts, env);
    default:
      throw new Error(`unknown install method: ${spec.install.method}`);
  }
}
