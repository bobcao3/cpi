import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureShellTools, getShuckBinPath } from "../../shell/tools.ts";
import { resolveShell } from "../../shell/profile.ts";
import { type LspServerSpec } from "./registry.ts";
import {
  installedNpmTarget,
  launchTarget,
  npmCliTarget,
  npmPackageTarget,
  runCapture,
  runToCompletion,
  whichOnPath,
} from "./process.ts";

export { whichOnPath } from "./process.ts";

const execFileAsync = promisify(execFile);
const DL_TIMEOUT = 60_000;
const IS_WIN = process.platform === "win32";

const INSTALL_G = globalThis as unknown as {
  __cpiLspInstalls?: Map<string, Promise<void>>;
};

function installs(): Map<string, Promise<void>> {
  if (!INSTALL_G.__cpiLspInstalls) INSTALL_G.__cpiLspInstalls = new Map();
  return INSTALL_G.__cpiLspInstalls;
}

/**
 * Installs sharing a destination serialize; the callback rechecks the binary.
 */
async function withInstallLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const map = installs();
  const existing = map.get(key);
  if (existing) await existing.catch(() => {});
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  map.set(key, gate);
  try {
    return await fn();
  } finally {
    release();
    map.delete(key);
  }
}

export type ResolveSource = "env" | "installed" | "reuse" | "install-failed";

export interface ResolveResult {
  bin: string;
  args?: string[];
  source: ResolveSource;
  pathDir?: string;
  error?: string;
}

export interface ResolveOptions {
  installTimeoutMs: number;
  uv: { version: string; repo: string; verify: string };
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function download(url: string, dest: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DL_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    const ws = createWriteStream(dest);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        ws.write(Buffer.from(value));
      }
    } finally {
      ws.end();
      reader.releaseLock();
    }
    await new Promise<void>((res, rej) => {
      ws.on("finish", res);
      ws.on("error", rej);
    });
  } finally {
    clearTimeout(timer);
  }
}

function sha256file(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseSha256(content: string): string | null {
  const m = content
    .trim()
    .split("\n")[0]
    .match(/[0-9a-fA-F]{64}/);
  return m ? m[0].toLowerCase() : null;
}

// Linux uses musl assets for static binaries.
const UV_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
    if (IS_WIN) {
      const shell = resolveShell("auto", env);
      await execFileAsync(
        shell.executable,
        shell.commandArgs(
          `Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(tmp)} -Force`,
        ),
        { env, windowsHide: true },
      );
    } else {
      await execFileAsync("tar", ["-xzf", archive, "-C", tmp], {
        windowsHide: true,
      });
    }
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
  const actual = sha256file(archive);
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

async function installUv(
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

/**
 * Resolve the server binary for `spec`; lookup/install failures return
 * `{ source: "install-failed" }` rather than throwing.
 */
export async function resolveBin(
  spec: LspServerSpec,
  env: NodeJS.ProcessEnv,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const found = whichOnPath(spec.binName, env);
  if (found) {
    const target =
      spec.install.method === "npm"
        ? (npmPackageTarget(found, spec.install.package!, spec.binName) ??
          launchTarget(found, env))
        : launchTarget(found, env);
    return { ...target, source: "env" };
  }
  if (spec.install.method === "env-only")
    return {
      bin: "",
      source: "install-failed",
      error: `${spec.binName} not found on PATH (env-only: cpi does not auto-install it).`,
    };
  if (spec.install.method === "reuse") {
    let bin = getShuckBinPath();
    if (!bin) {
      await ensureShellTools();
      bin = getShuckBinPath();
    }
    if (bin) return { ...launchTarget(bin, env), source: "reuse" };
    return { bin: "", source: "install-failed", error: "shuck unavailable" };
  }
  try {
    if (spec.install.method === "npm")
      return await withInstallLock("npm", () =>
        withTimeout(opts.installTimeoutMs, installNpm(spec, opts, env)),
      );
    if (spec.install.method === "uv")
      return await withInstallLock("uv", () =>
        withTimeout(opts.installTimeoutMs, installUv(spec, opts, env)),
      );
    return {
      bin: "",
      source: "install-failed",
      error: `unknown install method: ${spec.install.method}`,
    };
  } catch (error) {
    return {
      bin: "",
      source: "install-failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
