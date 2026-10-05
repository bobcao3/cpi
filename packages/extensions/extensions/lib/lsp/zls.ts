/** zls provisioning: the zigtools release worker maps a Zig version (project pin, then local `zig`, then config) to the zls build for this platform; the artifact is sha256- and minisign-verified. */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parsePubKey, parseSig, verifyMinisign } from "../minisig.ts";
import { ZIG_VERSION_RE } from "./discover.ts";
import { launchTarget, runCapture, whichOnPath } from "./process.ts";
import { type LspServerSpec } from "./registry.ts";
import {
  IS_WIN,
  archiveExtOf,
  download,
  installReleaseBinary,
  platformKey,
  sha256File,
} from "./release.ts";
import { type ResolveOptions, type ResolveResult } from "./provision.ts";

const API_TIMEOUT = 15_000;
const ZIG_PROBE_TIMEOUT = 10_000;
// zls is executed against the project's zig, never rebuilt by it.
const COMPATIBILITY = "only-runtime";

const ZLS_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-linux",
  "linux-arm64": "aarch64-linux",
  "darwin-arm64": "aarch64-macos",
  "darwin-x64": "x86_64-macos",
  "win32-x64": "x86_64-windows",
  "win32-arm64": "aarch64-windows",
};

interface ZlsBuild {
  version: string;
  tarball: string;
  shasum: string;
}

function recoverHint(reason: string): string {
  return `${reason}; install zls yourself and pass env= with it on PATH`;
}

async function probeZigVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  const zig = whichOnPath("zig", env);
  if (!zig) return null;
  try {
    const out = await runCapture(
      launchTarget(zig, env),
      ["version"],
      dirname(zig),
      env,
      ZIG_PROBE_TIMEOUT,
    );
    const version = out.trim().split(/\s+/)[0];
    return ZIG_VERSION_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

async function selectZlsBuild(
  releases: string,
  zigVersion: string,
): Promise<ZlsBuild> {
  const target = ZLS_TARGETS[platformKey()];
  if (!target)
    throw new Error(recoverHint(`no zls build published for ${platformKey()}`));
  const url = `${releases}/v1/zls/select-version?zig_version=${encodeURIComponent(zigVersion)}&compatibility=${COMPATIBILITY}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT);
  let body: Record<string, unknown>;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "cpi-lsp" },
    });
    body = (await res.json()) as Record<string, unknown>;
    if (!res.ok)
      throw new Error(String(body.error ?? body.message ?? res.status));
  } finally {
    clearTimeout(timer);
  }
  const asset = body[target] as { tarball?: unknown; shasum?: unknown };
  const version = body.version;
  if (typeof version !== "string" || typeof asset?.tarball !== "string")
    throw new Error(
      recoverHint(
        `zig ${zigVersion}: ${String(body.message ?? body.error ?? "no zls build")}`,
      ),
    );
  return {
    version,
    tarball: asset.tarball,
    shasum: typeof asset.shasum === "string" ? asset.shasum : "",
  };
}

function zlsBinPath(version: string): string {
  return join(
    getAgentDir(),
    "lsp_envs",
    "zig",
    version,
    IS_WIN ? "zls.exe" : "zls",
  );
}

async function cachedZls(
  version: string,
  opts: ResolveOptions,
  env: NodeJS.ProcessEnv,
): Promise<ResolveResult | null> {
  const bin = zlsBinPath(version);
  if (!existsSync(bin)) return null;
  const target = launchTarget(bin, env);
  try {
    const v = await runCapture(
      target,
      ["--version"],
      dirname(bin),
      env,
      opts.installTimeoutMs,
    );
    if (v.includes(version)) return { ...target, source: "installed" };
  } catch {}
  return null;
}

export async function installZls(
  spec: LspServerSpec,
  opts: ResolveOptions,
  env: NodeJS.ProcessEnv,
): Promise<ResolveResult> {
  const zigVersion =
    spec.install.pin ?? (await probeZigVersion(env)) ?? spec.install.version;
  if (!zigVersion) throw new Error("no zig version pin, probe, or default");
  // A cached build for the pin skips the release lookup entirely.
  const exact = await cachedZls(zigVersion, opts, env);
  if (exact) return exact;
  const build = await selectZlsBuild(spec.install.releases!, zigVersion);
  if (build.version !== zigVersion) {
    const resolved = await cachedZls(build.version, opts, env);
    if (resolved) return resolved;
  }
  const bin = zlsBinPath(build.version);
  const pub = parsePubKey(spec.install.pubkey!);
  await installReleaseBinary({
    url: build.tarball,
    archiveExt: archiveExtOf(build.tarball),
    binPaths: [IS_WIN ? "zls.exe" : "zls"],
    dest: bin,
    env,
    verify: async (archive) => {
      const digest = sha256File(archive);
      if (build.shasum && digest !== build.shasum)
        throw new Error(
          `zls ${build.version}: sha256 ${digest} does not match ${build.shasum}`,
        );
      const sigPath = `${archive}.minisig`;
      try {
        await download(`${build.tarball}.minisig`, sigPath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          recoverHint(
            `zls ${build.version}: no minisign signature (${reason})`,
          ),
        );
      }
      const ok = verifyMinisign(
        await readFile(archive),
        parseSig(await readFile(sigPath, "utf8")),
        pub,
      );
      if (!ok)
        throw new Error(`zls ${build.version}: minisign verification failed`);
    },
  });
  const v = await runCapture(
    launchTarget(bin, env),
    ["--version"],
    dirname(bin),
    env,
    opts.installTimeoutMs,
  );
  if (!v.includes(build.version))
    throw new Error(`zls version mismatch after install: ${v.trim()}`);
  return { ...launchTarget(bin, env), source: "installed" };
}
