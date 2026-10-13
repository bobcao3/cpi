import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadLspConfig } from "../lib/config.ts";
import { ensureUv } from "../lib/lsp/install.ts";
import { discoverProjectRoot } from "../lib/lsp/discover.ts";
import {
  installedNpmTarget,
  launchTarget,
  runCapture,
} from "../lib/lsp/process.ts";
import {
  installManagedServer,
  type ResolveOptions,
} from "../lib/lsp/provision.ts";
import { getLspServerSpec } from "../lib/lsp/registry.ts";
import { selectCompatibleZlsVersion } from "../lib/lsp/zls.ts";
import {
  getToolEnv,
  installManagedShellTool,
  listManagedShellTools,
  type ManagedShellToolId,
} from "../shell/tools.ts";

export type ManagedToolStatus =
  | "current"
  | "update"
  | "missing"
  | "unsupported"
  | "error";

export interface ManagedToolState {
  id: string;
  label: string;
  category: "shell" | "runtime" | "language-server";
  desired: string;
  installed?: string;
  installedVersions?: string[];
  status: ManagedToolStatus;
  action: string;
  path?: string;
  detail?: string;
}

export interface InstallProgress {
  action: string;
  ids: string[];
  phase: "installing" | "complete" | "failed";
  error?: string;
}

interface Candidate {
  id: string;
  label: string;
  category: ManagedToolState["category"];
  desired: string;
  action: string;
  path?: string;
  args?: string[];
  supported?: boolean;
  packagePath?: string;
  installations?: { path: string; args?: string[] }[];
  detail?: string;
}

const VERSION_RE = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;
const INSTALLATION_LIMIT = 64;
const binName = (name: string) =>
  process.platform === "win32" ? `${name}.exe` : name;

function versionOf(output: string): string | undefined {
  return output.match(VERSION_RE)?.[1];
}

async function executableVersion(candidate: Candidate, timeout: number) {
  if (!candidate.path || !existsSync(candidate.path)) return undefined;
  const output = await runCapture(
    launchTarget(candidate.path, process.env),
    candidate.args ?? ["--version"],
    dirname(candidate.path),
    process.env,
    timeout,
  );
  return versionOf(output);
}

async function installationVersion(
  installation: { path: string; args?: string[] },
  timeout: number,
) {
  return executableVersion(
    {
      ...installation,
      id: "",
      label: "",
      category: "runtime",
      desired: "",
      action: "",
    },
    timeout,
  );
}

async function packageVersion(path: string | undefined) {
  if (!path || !existsSync(path)) return undefined;
  const value = JSON.parse(await readFile(path, "utf8")) as {
    version?: unknown;
  };
  return typeof value.version === "string" ? value.version : undefined;
}

async function zlsInstallations() {
  const root = join(getAgentDir(), "lsp_envs", "zig");
  if (!existsSync(root)) return [];
  const versions = (
    await readdir(root, { withFileTypes: true }).catch(() => [])
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => compareVersion(right, left))
    .slice(0, INSTALLATION_LIMIT);
  return versions
    .map((version) => ({ path: join(root, version, binName("zls")) }))
    .filter((installation) => existsSync(installation.path));
}

function compareVersion(left: string, right: string): number {
  const parse = (value: string) => {
    const [core, prerelease] = value.replace(/^v/, "").split("-", 2);
    return {
      core: core.split(".").map((part) => Number(part) || 0),
      prerelease: prerelease?.split(".") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference) return difference;
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  return left.localeCompare(right, undefined, { numeric: true });
}

function orderVersions(versions: string[], desired: string): string[] {
  const unique = [...new Set(versions)].sort((a, b) => compareVersion(b, a));
  return unique.includes(desired)
    ? [desired, ...unique.filter((version) => version !== desired)]
    : unique;
}

async function candidates(cwd: string): Promise<Candidate[]> {
  const agent = getAgentDir();
  const cfg = loadLspConfig(cwd);
  const npmRoot = join(agent, "lsp_envs", "typescript");
  const tsSpec = getLspServerSpec("typescript", cwd);
  const tsTarget = installedNpmTarget(
    npmRoot,
    tsSpec.install.package!,
    tsSpec.binName,
  );
  const zlsSpec = getLspServerSpec("zig", discoverProjectRoot(cwd, "zig"));
  let zlsDesired = "unknown";
  let zlsDetail: string | undefined;
  try {
    zlsDesired = (await selectCompatibleZlsVersion(zlsSpec, getToolEnv()))
      .zlsVersion;
  } catch (error) {
    zlsDetail = `Compatibility lookup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const shell: Candidate[] = listManagedShellTools().map((tool) => ({
    id: tool.id,
    label: tool.id === "rg" ? "ripgrep" : tool.id,
    category: "shell",
    desired: tool.version,
    action: tool.id,
    path: tool.path,
    supported: tool.supported,
  }));
  return [
    ...shell,
    {
      id: "uv",
      label: "uv",
      category: "runtime",
      desired: cfg.tools.uv.version,
      action: "uv",
      path: join(agent, "cache", "uv", "bin", binName("uv")),
    },
    {
      id: "typescript-language-server",
      label: "typescript-language-server",
      category: "language-server",
      desired: cfg.servers.typescript.version,
      action: "typescript",
      path: tsTarget?.bin,
      args: tsTarget ? [...tsTarget.args, "--version"] : undefined,
    },
    {
      id: "typescript",
      label: "TypeScript",
      category: "runtime",
      desired: cfg.servers.typescript.tsVersion,
      action: "typescript",
      packagePath: join(npmRoot, "node_modules", "typescript", "package.json"),
    },
    {
      id: "pyrefly",
      label: "Pyrefly",
      category: "language-server",
      desired: cfg.servers.python.version,
      action: "python",
      path: join(
        agent,
        "lsp_envs",
        "python",
        process.platform === "win32" ? "Scripts" : "bin",
        binName("pyrefly"),
      ),
    },
    {
      id: "gopls",
      label: "gopls",
      category: "language-server",
      desired: cfg.servers.go.version.replace(/^v/, ""),
      action: "go",
      path: join(agent, "lsp_envs", "go", "bin", binName("gopls")),
      args: ["version"],
    },
    {
      id: "zls",
      label: "ZLS",
      category: "language-server",
      desired: zlsDesired,
      action: "zig",
      installations: await zlsInstallations(),
      detail: zlsDetail,
    },
  ];
}

async function inspectCandidate(
  candidate: Candidate,
  timeout: number,
): Promise<ManagedToolState> {
  const base = {
    id: candidate.id,
    label: candidate.label,
    category: candidate.category,
    desired: candidate.desired.replace(/^v/, ""),
    action: candidate.action,
    path: candidate.path,
    ...(candidate.detail ? { detail: candidate.detail } : {}),
  };
  if (candidate.supported === false) return { ...base, status: "unsupported" };
  try {
    const found = candidate.installations
      ? await Promise.all(
          candidate.installations.map(async (installation) => ({
            ...installation,
            version: await installationVersion(installation, timeout),
          })),
        )
      : [];
    const installedVersions = orderVersions(
      found.flatMap((installation) =>
        installation.version ? [installation.version] : [],
      ),
      base.desired,
    );
    const installed = candidate.installations
      ? installedVersions.join(", ") || undefined
      : candidate.packagePath
        ? await packageVersion(candidate.packagePath)
        : await executableVersion(candidate, timeout);
    if (!installed)
      return { ...base, status: candidate.detail ? "error" : "missing" };
    const selectedPath = found.find(
      (installation) => installation.version === installedVersions[0],
    )?.path;
    return {
      ...base,
      path: selectedPath ?? base.path,
      installed,
      ...(candidate.installations ? { installedVersions } : {}),
      status: candidate.detail
        ? "error"
        : candidate.installations
          ? installedVersions.includes(base.desired)
            ? "current"
            : "update"
          : installed === base.desired
            ? "current"
            : "update",
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inspectManagedTools(
  cwd: string = process.cwd(),
): Promise<ManagedToolState[]> {
  const cfg = loadLspConfig(cwd);
  return Promise.all(
    (await candidates(cwd)).map((candidate) =>
      inspectCandidate(candidate, cfg.installTimeoutMs),
    ),
  );
}

async function installAction(action: string, cwd: string): Promise<void> {
  if (["fd", "rg", "shuck"].includes(action)) {
    const ok = await installManagedShellTool(action as ManagedShellToolId);
    if (!ok) throw new Error(`${action} installation failed`);
    return;
  }
  const cfg = loadLspConfig(cwd);
  const opts: ResolveOptions = {
    installTimeoutMs: cfg.installTimeoutMs,
    uv: cfg.tools.uv,
  };
  const env = getToolEnv();
  if (action === "uv") {
    await ensureUv(opts, env);
    return;
  }
  const language = {
    typescript: "typescript",
    python: "python",
    go: "go",
    zig: "zig",
  }[action] as "typescript" | "python" | "go" | "zig" | undefined;
  if (!language) throw new Error(`unknown tool action: ${action}`);
  const projectRoot =
    language === "zig" ? discoverProjectRoot(cwd, "zig") : cwd;
  await installManagedServer(
    getLspServerSpec(language, projectRoot),
    env,
    opts,
  );
}

export async function installManagedTools(
  ids: string[],
  cwd: string = process.cwd(),
  progress?: (event: InstallProgress) => void,
): Promise<ManagedToolState[]> {
  const initial = await inspectManagedTools(cwd);
  const requested = new Set(ids);
  const actions = new Map<string, string[]>();
  for (const tool of initial) {
    if (!requested.has(tool.id)) continue;
    const group = actions.get(tool.action) ?? [];
    group.push(tool.id);
    actions.set(tool.action, group);
  }
  const unknown = ids.filter((id) => !initial.some((tool) => tool.id === id));
  if (unknown.length) throw new Error(`unknown tools: ${unknown.join(", ")}`);
  for (const [action, selected] of actions) {
    const affected = initial
      .filter((tool) => tool.action === action)
      .map((tool) => tool.id);
    progress?.({ action, ids: affected, phase: "installing" });
    try {
      await installAction(action, cwd);
      progress?.({ action, ids: affected, phase: "complete" });
    } catch (error) {
      progress?.({
        action,
        ids: selected,
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return inspectManagedTools(cwd);
}
