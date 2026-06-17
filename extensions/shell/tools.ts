/**
 * Shell tool dependencies: fd + rg install and PATH augmentation.
 *
 * Downloads fd and ripgrep into the agent cache on first use and exposes a
 * PATH-augmented env so `bash -c` invocations can find them. No zmx, no pi/tui
 * imports — this is a leaf module consumed by the exec engine and the entry.
 */

import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const FD_VERSION = "v10.4.2";
const RG_VERSION = "15.1.0";

const CACHE_DIR = join(getAgentDir(), "cache", "shell-tools");
const BIN_DIR = join(CACHE_DIR, "bin");

const execFileAsync = promisify(execFile);

export interface ToolAvailability {
  fd: boolean;
  rg: boolean;
}

function getPlatform(): { os: string; arch: string } {
  return { os: process.platform, arch: process.arch };
}

function getFdTarget(os: string, arch: string): string | null {
  if (os === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
  }
  if (os === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "aarch64-apple-darwin";
  }
  if (os === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }
  return null;
}

function getRgTarget(os: string, arch: string): string | null {
  if (os === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
  }
  if (os === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
  }
  if (os === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }
  return null;
}

function getFdAssetName(os: string, arch: string): string | null {
  const target = getFdTarget(os, arch);
  if (!target) return null;
  const ext = os === "win32" ? "zip" : "tar.gz";
  return `fd-${FD_VERSION}-${target}.${ext}`;
}

function getRgAssetName(os: string, arch: string): string | null {
  const target = getRgTarget(os, arch);
  if (!target) return null;
  const ext = os === "win32" ? "zip" : "tar.gz";
  return `ripgrep-${RG_VERSION}-${target}.${ext}`;
}

function binaryName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS);
  const fileStream = createWriteStream(dest);
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
    }
  } finally {
    fileStream.end();
    reader.releaseLock();
  }
  await new Promise<void>((resolve, reject) => {
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });
}

async function extractArchive(
  archivePath: string,
  destDir: string,
  archiveType: "tar.gz" | "zip",
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  if (archiveType === "tar.gz") {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", destDir]);
  } else {
    try {
      await execFileAsync("tar", ["-xf", archivePath, "-C", destDir]);
    } catch {
      await execFileAsync("unzip", ["-q", archivePath, "-d", destDir]);
    }
  }
}

async function ensureTool(
  toolName: "fd" | "rg",
  version: string,
  repo: string,
  getAssetName: (os: string, arch: string) => string | null,
): Promise<boolean> {
  const { os, arch } = getPlatform();
  const assetName = getAssetName(os, arch);
  if (!assetName) {
    console.warn(`[shell-ext] No ${toolName} binary available for ${os}/${arch}`);
    return false;
  }

  const binPath = join(BIN_DIR, binaryName(toolName));

  try {
    await readFile(binPath);
    return true;
  } catch {
    // proceed to download
  }

  const archiveType = assetName.endsWith(".zip") ? "zip" : "tar.gz";
  const assetBaseName = archiveType === "zip" ? assetName.slice(0, -4) : assetName.slice(0, -7);
  const url = `https://github.com/${repo}/releases/download/${version}/${assetName}`;

  const tempDir = join(tmpdir(), `pi-sh-tools-${toolName}-${Date.now()}`);
  const archivePath = join(tempDir, assetName);
  await mkdir(tempDir, { recursive: true });

  try {
    await downloadFile(url, archivePath);
    await extractArchive(archivePath, tempDir, archiveType);

    const extractedBinaryPath = join(tempDir, assetBaseName, binaryName(toolName));
    await mkdir(BIN_DIR, { recursive: true });
    await copyFile(extractedBinaryPath, binPath);
    if (process.platform !== "win32") {
      await chmod(binPath, 0o755);
    }

    await execFileAsync(binPath, ["--version"]);
    return true;
  } catch (err) {
    console.warn(`[shell-ext] Failed to install ${toolName}:`, err);
    return false;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function ensureShellTools(): Promise<ToolAvailability> {
  const [fd, rg] = await Promise.all([
    ensureTool("fd", FD_VERSION, "sharkdp/fd", getFdAssetName),
    ensureTool("rg", RG_VERSION, "BurntSushi/ripgrep", getRgAssetName),
  ]);
  return { fd, rg };
}

export function getToolEnv(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  return {
    ...process.env,
    [pathKey]: [BIN_DIR, currentPath].filter(Boolean).join(delimiter),
  };
}
