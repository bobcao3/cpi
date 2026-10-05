/** Hosted release assets: download, extract, install, hash. Verification policy belongs to the caller so it sits beside its trust anchor. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveShell } from "../../shell/profile.ts";

const execFileAsync = promisify(execFile);
const DL_TIMEOUT = 60_000;

export const IS_WIN = process.platform === "win32";
export type ArchiveExt = "tar.gz" | "tar.xz" | "zip";

export interface ReleaseInstall {
  url: string;
  archiveExt: ArchiveExt;
  /** Archive-relative binary paths, most specific first. */
  binPaths: string[];
  dest: string;
  env: NodeJS.ProcessEnv;
  verify?: (archive: string) => Promise<void>;
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function archiveExtOf(url: string): ArchiveExt {
  if (url.endsWith(".zip")) return "zip";
  return url.endsWith(".tar.gz") ? "tar.gz" : "tar.xz";
}

export async function download(url: string, dest: string): Promise<void> {
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
    await new Promise<void>((res2, rej) => {
      ws.on("finish", res2);
      ws.on("error", rej);
    });
  } finally {
    clearTimeout(timer);
  }
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function expandZip(
  archive: string,
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!IS_WIN) {
    await execFileAsync("tar", ["-xf", archive, "-C", dir], {
      windowsHide: true,
    });
    return;
  }
  const shell = resolveShell("auto", env);
  await execFileAsync(
    shell.executable,
    shell.commandArgs(
      `Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(dir)} -Force`,
    ),
    { env, windowsHide: true },
  );
}

export async function extractArchive(
  archive: string,
  ext: ArchiveExt,
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (ext === "zip") return expandZip(archive, dir, env);
  if (ext === "tar.xz") {
    try {
      await execFileAsync("tar", ["-xJf", archive, "-C", dir], {
        windowsHide: true,
      });
      return;
    } catch {
      await execFileAsync("tar", ["-xf", archive, "-C", dir], {
        windowsHide: true,
      });
      return;
    }
  }
  await execFileAsync("tar", ["-xzf", archive, "-C", dir], {
    windowsHide: true,
  });
}

/** Downloads, optionally verifies, extracts and installs one release asset; returns the installed binary path. */
export async function installReleaseBinary(o: ReleaseInstall): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cpi-release-"));
  const assetName = basename(new URL(o.url).pathname);
  try {
    const archive = join(dir, assetName);
    await download(o.url, archive);
    if (o.verify) await o.verify(archive);
    await extractArchive(archive, o.archiveExt, dir, o.env);
    const found = o.binPaths
      .map((p) => join(dir, p))
      .find((p) => existsSync(p));
    if (!found)
      throw new Error(
        `${assetName}: none of ${o.binPaths.join(", ")} in archive`,
      );
    await mkdir(dirname(o.dest), { recursive: true });
    await copyFile(found, o.dest);
    if (!IS_WIN) await chmod(o.dest, 0o755);
    return o.dest;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
