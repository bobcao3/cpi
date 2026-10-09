import { ensureShellTools, getShuckBinPath } from "../../shell/tools.ts";
import { type LspServerSpec } from "./registry.ts";
import { installServer } from "./install.ts";
import { launchTarget, npmPackageTarget, whichOnPath } from "./process.ts";

export { whichOnPath } from "./process.ts";

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

function failed(error: string): ResolveResult {
  return { bin: "", source: "install-failed", error };
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
    return failed(
      `${spec.binName} not found on PATH (env-only: cpi does not auto-install it).`,
    );
  if (spec.install.method === "reuse") {
    let bin = getShuckBinPath();
    if (!bin) {
      await ensureShellTools();
      bin = getShuckBinPath();
    }
    if (bin) return { ...launchTarget(bin, env), source: "reuse" };
    return failed("shuck unavailable");
  }
  try {
    return await withInstallLock(spec.install.method, () =>
      withTimeout(opts.installTimeoutMs, installServer(spec, opts, env)),
    );
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
