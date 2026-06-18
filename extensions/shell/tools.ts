/**
 * Shell tool dependencies: fd + rg + shuck install and PATH augmentation.
 * Downloads binaries into the agent cache on first use.
 * Pure leaf module — no pi/tui imports.
 */

import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const DL_TIMEOUT = 60_000;
const CACHE_DIR = join(getAgentDir(), "cache", "shell-tools");
const BIN_DIR = join(CACHE_DIR, "bin");
const WASM_DIR = join(CACHE_DIR, "wasm");
const WASM_PATH = join(WASM_DIR, "tree-sitter-wasm.wasm");
const WASM_VERSION = "2026.06.18";
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
      try { await readFile(WASM_PATH); return true; } catch {}
      try {
        await mkdir(WASM_DIR, { recursive: true });
        await download(
          `https://github.com/bobcao3/cpi/releases/download/${WASM_VERSION}/tree-sitter-wasm.wasm`,
          WASM_PATH,
        );
        return true;
      } catch (err) { console.warn("[shell-ext] Failed to download tree-sitter-wasm:", err); return false; }
    })(),
  ]);
  return { fd, rg, shuck, treeSitter };
}

export function getToolEnv(): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  return { ...process.env, [key]: [BIN_DIR, process.env[key] ?? ""].join(delimiter) };
}

export function getShuckBinPath(): string | null {
  const p = join(BIN_DIR, binName("shuck"));
  return existsSync(p) ? p : null;
}

export function getWasmPath(): string | null {
  return existsSync(WASM_PATH) ? WASM_PATH : null;
}

