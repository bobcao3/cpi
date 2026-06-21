/**
 * Shell tool dependencies: fd + rg + shuck install and PATH augmentation.
 * Downloads binaries into the agent cache on first use.
 * Pure leaf module — no pi/tui imports.
 */

import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { initTreeSitterWasm, ensureTreeSitterReady } from "../lib/tree-sitter.ts";
import { parsePubKey, parseSig, verifyMinisign } from "../lib/minisig.ts";
import { parseDotEnv } from "../lib/dotenv.ts";
import { resolveCwdPath } from "../lib/cwd.ts";
import { brotliDecompressSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const DL_TIMEOUT = 60_000;
const CACHE_DIR = join(getAgentDir(), "cache", "shell-tools");
const BIN_DIR = join(CACHE_DIR, "bin");
const WASM_DIR = join(CACHE_DIR, "wasm");
const WASM_PATH = join(WASM_DIR, "tree-sitter-wasm.wasm");
const WASM_VERSION = "2026.06.20";
const WASM_PUBKEY_B64 = "RWQWdcLzFjpLqtjewtcZo71AHJVUFws3irxz2ColvNW/r0m4tHyxzDX5";
const WASM_SIG_PATH = join(WASM_DIR, "tree-sitter-wasm.wasm.minisig");
const WASM_URL = `https://github.com/bobcao3/cpi/releases/download/${WASM_VERSION}/tree-sitter-wasm.wasm.br`;
const WASM_SIG_URL = `https://github.com/bobcao3/cpi/releases/download/${WASM_VERSION}/tree-sitter-wasm.wasm.minisig`;
const WASM_PUB = parsePubKey(WASM_PUBKEY_B64);

/** True iff the cached wasm is present and its minisign signature verifies. */
function wasmVerifiedSync(): boolean {
  if (!existsSync(WASM_PATH) || !existsSync(WASM_SIG_PATH)) return false;
  try {
    return verifyMinisign(readFileSync(WASM_PATH), parseSig(readFileSync(WASM_SIG_PATH, "utf8")), WASM_PUB);
  } catch {
    return false;
  }
}
const IS_WIN = process.platform === "win32";
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const binName = (n: string) => (IS_WIN ? `${n}.exe` : n);

export interface ToolAvailability { fd: boolean; rg: boolean; shuck: boolean; treeSitter: boolean }

interface ToolSpec { name: "fd" | "rg" | "shuck"; version: string; repo: string; archiveExt: "tar.gz" | "tar.xz" | "zip"; assetPrefix: string; targets: Record<string, string> }

const TOOLS: ToolSpec[] = [
  { name: "fd", version: "v10.4.2", repo: "sharkdp/fd", archiveExt: IS_WIN ? "zip" : "tar.gz", assetPrefix: "fd-v10.4.2-", targets: {
    "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" } },
  { name: "rg", version: "15.1.0", repo: "BurntSushi/ripgrep", archiveExt: IS_WIN ? "zip" : "tar.gz", assetPrefix: "ripgrep-15.1.0-", targets: {
    "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-gnu",
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" } },
  { name: "shuck", version: "v0.0.41", repo: "ewhauser/shuck", archiveExt: IS_WIN ? "zip" : "tar.xz", assetPrefix: "shuck-cli-", targets: {
    "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc" } },
];

async function download(url: string, dest: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DL_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const ws = createWriteStream(dest);
    const reader = res.body.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; ws.write(Buffer.from(value)); } }
    finally { ws.end(); reader.releaseLock(); }
    await new Promise<void>((res, rej) => { ws.on("finish", res); ws.on("error", rej); });
  } finally { clearTimeout(timer); }
}

async function ensureTool(spec: ToolSpec): Promise<boolean> {
  const target = spec.targets[PLATFORM_KEY];
  if (!target) { console.warn(`[shell-ext] No ${spec.name} for ${PLATFORM_KEY}`); return false; }
  const aname = `${spec.assetPrefix}${target}.${spec.archiveExt}`;
  const binPath = join(BIN_DIR, binName(spec.name));
  try { await readFile(binPath); return true; } catch {}
  const baseName = aname.replace(/\.(tar\.(?:gz|xz)|zip)$/, "");
  const url = `https://github.com/${spec.repo}/releases/download/${spec.version}/${aname}`;
  const tmp = join(tmpdir(), `pi-sh-${spec.name}-${Date.now()}`);
  const archivePath = join(tmp, aname);
  await mkdir(tmp, { recursive: true });
  try {
    await download(url, archivePath);
    // Extract
    await mkdir(tmp, { recursive: true });
    if (spec.archiveExt === "zip") { try { await execFileAsync("tar", ["-xf", archivePath, "-C", tmp]); } catch { await execFileAsync("unzip", ["-q", archivePath, "-d", tmp]); } }
    else if (spec.archiveExt === "tar.xz") { try { await execFileAsync("tar", ["-xJf", archivePath, "-C", tmp]); } catch { await execFileAsync("tar", ["-xf", archivePath, "-C", tmp]); } }
    else { await execFileAsync("tar", ["-xzf", archivePath, "-C", tmp]); }
    await mkdir(BIN_DIR, { recursive: true });
    await copyFile(join(tmp, baseName, binName(spec.name)), binPath);
    if (!IS_WIN) await chmod(binPath, 0o755);
    await execFileAsync(binPath, ["--version"]);
    return true;
  } catch (err) { console.warn(`[shell-ext] Failed to install ${spec.name}:`, err); return false; }
  finally { await rm(tmp, { recursive: true, force: true }); }
}

export async function ensureShellTools(): Promise<ToolAvailability> {
  const [fd, rg, shuck, treeSitter] = await Promise.all([
    ...TOOLS.map(ensureTool),
    (async () => {
      let have = wasmVerifiedSync();
      if (!have) {
        try {
          await mkdir(WASM_DIR, { recursive: true });
          const tmpBr = join(tmpdir(), `pi-sh-wasm-${Date.now()}.br`);
          await download(WASM_URL, tmpBr);
          const compressed = await readFile(tmpBr);
          await rm(tmpBr, { force: true });
          await writeFile(WASM_PATH, brotliDecompressSync(compressed));
          try { await download(WASM_SIG_URL, WASM_SIG_PATH); } catch (err) { /* sig fetch failed; verify will fail below */ }
          have = wasmVerifiedSync();
          if (!have) {
            await rm(WASM_PATH, { force: true });
            await rm(WASM_SIG_PATH, { force: true });
            console.warn("[shell-ext] tree-sitter-wasm signature verification failed; highlighting disabled");
          }
        } catch (err) { console.warn("[shell-ext] Failed to download tree-sitter-wasm:", err); }
      }
      if (have) await ensureTreeSitterReady(); // eager: lets renderCall highlight sync on first paint
      return have;
    })(),
  ]);
  return { fd, rg, shuck, treeSitter };
}

export function getToolEnv(): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  return { ...process.env, [key]: [BIN_DIR, process.env[key] ?? ""].join(delimiter) };
}

/**
 * Env for the `sh` tool: base PATH env plus the parent session identity so
 * sub-agents (launched via subagent.sh) can nest their sessions under the
 * parent's session dir in `subagents_${PI_SESSION}/` — hidden from the
 * parent's `/resume` (flat listers don't recurse subfolders).
 *
 *   PI_SESSION     short id of the parent's pi session (first 8 of its uuid;
 *                  stable across resume so sub-agent sessions persist)
 *   PI_SESSION_DIR the parent's session dir (default or custom); absent for
 *                  ephemeral (--no-session) parents
 *
 * `sm` is duck-typed to keep this module a pure leaf (no pi imports).
 */
export function buildShellEnv(
  sm?: { getSessionId(): string | undefined; getSessionDir(): string | undefined },
): NodeJS.ProcessEnv {
  const env = getToolEnv();
  if (sm) {
    const id = sm.getSessionId();
    if (id) env.PI_SESSION = id.slice(0, 8);
    const dir = sm.getSessionDir();
    if (dir) env.PI_SESSION_DIR = dir;
  }
  return env;
}

/**
 * Env for `sh` / `sh_repeat_until` with an optional dotenv overlay.
 *
 * Base = `buildShellEnv(sm)` (process env ← tool PATH bins ← `PI_SESSION*`).
 * When `envPath` is given, `parseDotEnv(resolveCwdPath(envPath))` is merged on
 * top so dotenv wins over process env. `envPath` undefined/null → base only.
 */
export function buildShellEnvWithDotenv(
  sm?: { getSessionId(): string | undefined; getSessionDir(): string | undefined },
  envPath?: string | null,
): NodeJS.ProcessEnv {
  const env = buildShellEnv(sm);
  if (!envPath) return env;
  const parsed = parseDotEnv(resolveCwdPath(envPath));
  for (const [k, v] of Object.entries(parsed)) env[k] = v;
  return env;
}

export function getShuckBinPath(): string | null {
  const p = join(BIN_DIR, binName("shuck"));
  return existsSync(p) ? p : null;
}

export function getWasmPath(): string | null {
  return wasmVerifiedSync() ? WASM_PATH : null;
}

initTreeSitterWasm(getWasmPath);

