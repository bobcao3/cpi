/**
 * LSP server provisioning (design §6.6, Layer 3).
 *
 * `resolveBin` answers "where is this language's server binary?" for the
 * manager, in three tiers:
 *   (a) env-PATH-first reuse — `which(spec.binName)` against the merged spawn
 *       env (`getToolEnv()` + dotenv). A project's own toolchain wins; no
 *       install. This also picks up the cached shuck via `getToolEnv`'s PATH.
 *   (b) shell reuse — `getShuckBinPath()` (+ `ensureShellTools()` if missing).
 *   (c) install user-scoped — typescript via bare `npm install --prefix`; python
 *       via a downloaded static `uv` (GitHub Artifact Attestation primary,
 *       sha256 fallback — NEVER minisign for uv) then `uv venv` + `uv pip
 *       install`. Idempotent: skip when `--version` matches the pin; reinstall
 *       on mismatch so a pin bump re-provisions.
 *
 * All installs are bounded by `installTimeoutMs`; on timeout/failure the
 * result is `{ source:"install-failed" }` and the caller degrades (design §9).
 * Returns `{ bin, source, pathDir? }` where `pathDir` is prepended to the
 * server's PATH so it can spawn its own tooling (tsc/pyrefly/python). Pure node
 * except `getAgentDir` (pi) + `shell/tools.ts` reuse (design §5 correction).
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureShellTools, getShuckBinPath } from "../../shell/tools.ts";
import { type LspServerSpec } from "./registry.ts";

const execFileAsync = promisify(execFile);
const DL_TIMEOUT = 60_000;
const IS_WIN = process.platform === "win32";

export type ResolveSource = "env" | "installed" | "reuse" | "install-failed";

export interface ResolveResult {
  bin: string;
  source: ResolveSource;
  /** Dir prepended to the server PATH so it finds its own tooling. */
  pathDir?: string;
  error?: string;
}

export interface ResolveOptions {
  installTimeoutMs: number;
  uv: { version: string; repo: string; verify: string };
}

/** Locate `name` on PATH (env-PATH-first). Returns null when absent. */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const dirs = (env[key] ?? "").split(delimiter).filter(Boolean);
  const cands = IS_WIN ? [`${name}.exe`, name] : [name];
  for (const d of dirs) {
    for (const c of cands) {
      const p = join(d, c);
      if (existsSync(p)) return p;
    }
  }
  return null;
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

async function runCapture(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const r = await withTimeout(
    timeoutMs,
    execFileAsync(cmd, args, { env, maxBuffer: 4 * 1024 * 1024 }),
  );
  return (r.stdout ?? "") + (r.stderr ?? "");
}

/** Run to completion (exit 0) or reject. tsc/pyrefly exit non-zero on errors. */
async function runToCompletion(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return withTimeout(
    timeoutMs,
    new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout?.on("data", (d) => {
        stdout += d.toString("utf8");
      });
      p.stderr?.on("data", (d) => {
        stderr += d.toString("utf8");
      });
      p.on("error", reject);
      p.on("exit", (code) => {
        if (code !== 0) reject(new Error(`exit ${code}: ${(stderr || "").slice(0, 500)}`));
        else resolve({ stdout, stderr, code });
      });
    }),
  );
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

/** First hex token of a `<hash>  <name>` checksum file. */
function parseSha256(content: string): string | null {
  const m = content
    .trim()
    .split("\n")[0]
    .match(/[0-9a-fA-F]{64}/);
  return m ? m[0].toLowerCase() : null;
}

// astral-sh/uv release asset per platform (musl on linux for a static binary).
const UV_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

async function ensureUv(opts: ResolveOptions, env: NodeJS.ProcessEnv): Promise<string> {
  const want = opts.uv.version;
  const dir = join(getAgentDir(), "cache", "uv", "bin");
  const bin = join(dir, IS_WIN ? "uv.exe" : "uv");
  if (existsSync(bin)) {
    try {
      const v = await runCapture(bin, ["--version"], env, opts.installTimeoutMs);
      if (v.includes(want)) return bin;
    } catch {
      /* stale; re-provision */
    }
  }
  const target = UV_TARGETS[platformKey()];
  if (!target) throw new Error(`no uv asset for ${platformKey()}`);
  const aname = `uv-${target}.tar.gz`;
  const url = `https://github.com/${opts.uv.repo}/releases/download/${want}/${aname}`;
  const tmp = join(tmpdir(), `pi-uv-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  const archive = join(tmp, aname);
  try {
    await download(url, archive);
    await verifyUv(archive, aname, want, opts, tmp);
    await execFileAsync("tar", ["-xzf", archive, "-C", tmp]);
    const extracted = join(tmp, `uv-${target}`, IS_WIN ? "uv.exe" : "uv");
    await mkdir(dir, { recursive: true });
    await copyFile(extracted, bin);
    if (!IS_WIN) await chmod(bin, 0o755);
    const v = await runCapture(bin, ["--version"], env, opts.installTimeoutMs);
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
  // Primary: GitHub Artifact Attestation (keyless Sigstore). Fallback: sha256.
  if (opts.uv.verify === "attestation-then-sha256") {
    try {
      await execFileAsync("gh", ["attestation", "verify", archive, "--repo", opts.uv.repo], {
        timeout: opts.installTimeoutMs,
      });
      return;
    } catch {
      /* gh absent or attestation absent → sha256 fallback */
    }
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
  await mkdir(envDir, { recursive: true });
  const bin = join(
    envDir,
    "node_modules",
    ".bin",
    IS_WIN ? "typescript-language-server.cmd" : "typescript-language-server",
  );
  const want = spec.install.version;
  if (existsSync(bin)) {
    try {
      const v = await runCapture(bin, ["--version"], env, opts.installTimeoutMs);
      if (want && v.includes(want)) return { bin, source: "installed", pathDir: dirname(bin) };
    } catch {
      /* stale; reinstall */
    }
  }
  const pkgJson = join(envDir, "package.json");
  if (!existsSync(pkgJson))
    await writeFile(pkgJson, JSON.stringify({ name: "cpi-lsp-typescript", private: true }));
  const pkgs = [`${spec.install.package}@${want}`];
  if (spec.install.tsVersion) pkgs.push(`typescript@${spec.install.tsVersion}`);
  await runToCompletion(
    "npm",
    ["install", "--prefix", envDir, ...pkgs],
    envDir,
    env,
    opts.installTimeoutMs,
  );
  if (!existsSync(bin)) throw new Error("tsserver binary missing after install");
  const v = await runCapture(bin, ["--version"], env, opts.installTimeoutMs);
  if (want && !v.includes(want)) throw new Error(`tsserver version mismatch after install: ${v}`);
  return { bin, source: "installed", pathDir: dirname(bin) };
}

async function installUv(
  spec: LspServerSpec,
  opts: ResolveOptions,
  env: NodeJS.ProcessEnv,
): Promise<ResolveResult> {
  const uvBin = await ensureUv(opts, env);
  const envDir = join(getAgentDir(), "lsp_envs", "python");
  await mkdir(envDir, { recursive: true });
  const bin = join(envDir, "bin", IS_WIN ? "pyrefly.exe" : "pyrefly");
  const want = spec.install.version;
  if (existsSync(bin)) {
    try {
      const v = await runCapture(bin, ["--version"], env, opts.installTimeoutMs);
      if (want && v.includes(want)) return { bin, source: "installed", pathDir: dirname(bin) };
    } catch {
      /* stale; reinstall */
    }
  }
  const venvPython = join(envDir, "bin", IS_WIN ? "python.exe" : "python");
  await runToCompletion(uvBin, ["venv", envDir], envDir, env, opts.installTimeoutMs);
  await runToCompletion(
    uvBin,
    ["pip", "install", "--python", venvPython, `${spec.install.package}==${want}`],
    envDir,
    env,
    opts.installTimeoutMs,
  );
  if (!existsSync(bin)) throw new Error("pyrefly binary missing after install");
  const v = await runCapture(bin, ["--version"], env, opts.installTimeoutMs);
  if (want && !v.includes(want)) throw new Error(`pyrefly version mismatch after install: ${v}`);
  return { bin, source: "installed", pathDir: dirname(bin) };
}

/**
 * Resolve the server binary for `spec`. Never throws: install/lookup failure is
 * returned as `{ source:"install-failed" }` so the manager degrades (§9).
 */
export async function resolveBin(
  spec: LspServerSpec,
  env: NodeJS.ProcessEnv,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const found = whichOnPath(spec.binName, env);
  if (found) return { bin: found, source: "env", pathDir: dirname(found) };
  if (spec.install.method === "reuse") {
    let bin = getShuckBinPath();
    if (!bin) {
      await ensureShellTools();
      bin = getShuckBinPath();
    }
    if (bin) return { bin, source: "reuse", pathDir: dirname(bin) };
    return { bin: "", source: "install-failed", error: "shuck unavailable" };
  }
  try {
    if (spec.install.method === "npm")
      return await withTimeout(opts.installTimeoutMs, installNpm(spec, opts, env));
    if (spec.install.method === "uv")
      return await withTimeout(opts.installTimeoutMs, installUv(spec, opts, env));
    return {
      bin: "",
      source: "install-failed",
      error: `unknown install method: ${spec.install.method}`,
    };
  } catch (err) {
    const e = err as { message?: string };
    return { bin: "", source: "install-failed", error: String(e?.message || err) };
  }
}
