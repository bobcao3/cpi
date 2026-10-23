import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ghostmuxSocket } from "./ghostmux.ts";
import { installReleaseBinary } from "../lib/lsp/release.ts";
import { storage_path } from "../lib/storage/paths.ts";
import {
  captureSessionOwner,
  inheritedSessionOwner,
  type SessionOwner,
} from "../lib/storage/owner.ts";
import {
  initTreeSitterWasm,
  ensureTreeSitterReady,
} from "../lib/tree-sitter.ts";
import { toolPackage } from "../lib/tool-package.ts";
import { parseDotEnv } from "../lib/dotenv.ts";
import { resolveCwdPath } from "../lib/cwd.ts";
import { runtimeEnv } from "../lib/runtime.ts";
import { CPI_SUBAGENT_RPC, getSubagentRpc } from "../lib/subagent-rpc.ts";
import { fileURLToPath } from "node:url";
import { refreshHostRoutingEnv } from "../../bin/host-pi.mjs";

const { getTreeSitterWasmPath, resolveTreeSitterWasm } = await toolPackage(
  "@cpi/tree-sitter-wasm/resolve",
);

const execFileAsync = promisify(execFile);
const CACHE_DIR = storage_path("cache", "shell-tools", { base: getAgentDir() });
const BIN_DIR = join(CACHE_DIR, "bin");
const VENDOR_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
);
const CPI_CONTROL_ENV_KEYS = [
  "CPI_ARTIFACT_SESSION_ID",
  "CPI_ARTIFACT_SESSION_DIR",
  "CPI_STORAGE_ROOT",
  "CPI_STORAGE_HOST_ID",
  "CPI_TEMP_DIR",
  "CPI_OUTPUT_DIR",
  "CPI_GHOSTMUX_SOCKET",
  "CPI_RUNTIME_BIN",
  "CPI_RUNTIME_KIND",
  "PI_AGENT_SRC",
  "CPI_HARNESS_SRC",
  CPI_SUBAGENT_RPC,
  "PI_SESSION",
  "PI_SESSION_ID",
  "PI_SESSION_DIR",
  "PI_SUBAGENT",
  "PI_SUBAGENT_ROLE",
  "PI_SUBAGENT_SUMMARY",
] as const;

const IS_WIN = process.platform === "win32";
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const binName = (n: string) => (IS_WIN ? `${n}.exe` : n);

async function verifyTool(binPath: string, version: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, ["--version"], {
      windowsHide: true,
    });
    const expected = version.replace(/^v/, "");
    return `${stdout}${stderr}`.trim().split(/\s+/).includes(expected);
  } catch {
    return false;
  }
}

export interface ToolAvailability {
  fd: boolean;
  rg: boolean;
  shuck: boolean;
  treeSitter: boolean;
}

interface ToolSpec {
  name: "fd" | "rg" | "shuck";
  version: string;
  repo: string;
  archiveExt: "tar.gz" | "tar.xz" | "zip";
  assetPrefix: string;
  targets: Record<string, string>;
}

const TOOLS: ToolSpec[] = [
  {
    name: "fd",
    version: "v10.5.0",
    repo: "sharkdp/fd",
    archiveExt: IS_WIN ? "zip" : "tar.gz",
    assetPrefix: "fd-v10.5.0-",
    targets: {
      "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-musl",
      "darwin-arm64": "aarch64-apple-darwin",
      "darwin-x64": "x86_64-apple-darwin",
      "win32-x64": "x86_64-pc-windows-msvc",
      "win32-arm64": "aarch64-pc-windows-msvc",
    },
  },
  {
    name: "rg",
    version: "15.2.0",
    repo: "BurntSushi/ripgrep",
    archiveExt: IS_WIN ? "zip" : "tar.gz",
    assetPrefix: "ripgrep-15.2.0-",
    targets: {
      "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-gnu",
      "darwin-arm64": "aarch64-apple-darwin",
      "darwin-x64": "x86_64-apple-darwin",
      "win32-x64": "x86_64-pc-windows-msvc",
      "win32-arm64": "aarch64-pc-windows-msvc",
    },
  },
  {
    name: "shuck",
    version: "v0.2.4",
    repo: "ewhauser/shuck",
    archiveExt: IS_WIN ? "zip" : "tar.xz",
    assetPrefix: "shuck-cli-",
    targets: {
      "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-musl",
      "darwin-arm64": "aarch64-apple-darwin",
      "win32-x64": "x86_64-pc-windows-msvc",
    },
  },
];

export type ManagedShellToolId = ToolSpec["name"];

export interface ManagedShellTool {
  id: ManagedShellToolId;
  path: string;
  supported: boolean;
  version: string;
}

export function listManagedShellTools(): ManagedShellTool[] {
  return TOOLS.map((tool) => ({
    id: tool.name,
    path: join(BIN_DIR, binName(tool.name)),
    supported: Boolean(tool.targets[PLATFORM_KEY]),
    version: tool.version.replace(/^v/, ""),
  }));
}

async function ensureTool(spec: ToolSpec): Promise<boolean> {
  const target = spec.targets[PLATFORM_KEY];
  if (!target) {
    console.warn(`[shell-ext] No ${spec.name} for ${PLATFORM_KEY}`);
    return false;
  }
  const aname = `${spec.assetPrefix}${target}.${spec.archiveExt}`;
  const binPath = join(BIN_DIR, binName(spec.name));
  try {
    await readFile(binPath);
    if (await verifyTool(binPath, spec.version)) return true;
  } catch {}
  const baseName = aname.replace(/\.(tar\.(?:gz|xz)|zip)$/, "");
  const url = `https://github.com/${spec.repo}/releases/download/${spec.version}/${aname}`;
  try {
    await installReleaseBinary({
      url,
      archiveExt: spec.archiveExt,
      binPaths: [join(baseName, binName(spec.name)), binName(spec.name)],
      dest: binPath,
      env: process.env,
    });
    if (!(await verifyTool(binPath, spec.version)))
      throw new Error("tool verification failed");
    return true;
  } catch (err) {
    console.warn(`[shell-ext] Failed to install ${spec.name}:`, err);
    return false;
  }
}

export async function installManagedShellTool(
  id: ManagedShellToolId,
): Promise<boolean> {
  const tool = TOOLS.find((candidate) => candidate.name === id);
  if (!tool) throw new Error(`unknown managed shell tool: ${String(id)}`);
  return ensureTool(tool);
}

const TOOLS_G = globalThis as unknown as {
  __cpiShellTools?: Promise<ToolAvailability>;
};

async function doEnsureShellTools(): Promise<ToolAvailability> {
  const [fd, rg, shuck, treeSitter] = await Promise.all([
    ...TOOLS.map(ensureTool),
    (async () => {
      try {
        await resolveTreeSitterWasm();
        return await ensureTreeSitterReady();
      } catch (err) {
        console.warn("[shell-ext] Failed to initialize tree-sitter-wasm:", err);
        return false;
      }
    })(),
  ]);
  return { fd, rg, shuck, treeSitter };
}

export async function ensureShellTools(): Promise<ToolAvailability> {
  const existing = TOOLS_G.__cpiShellTools;
  if (existing) return existing;
  const p = doEnsureShellTools().finally(() => {
    delete TOOLS_G.__cpiShellTools;
  });
  TOOLS_G.__cpiShellTools = p;
  return p;
}

export function getToolEnv(): NodeJS.ProcessEnv {
  const key =
    Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const subagentRpc = getSubagentRpc();
  return {
    ...process.env,
    ...runtimeEnv(),
    ...(subagentRpc ? { [CPI_SUBAGENT_RPC]: subagentRpc } : {}),
    [key]: [VENDOR_BIN, BIN_DIR, process.env[key] ?? ""].join(delimiter),
  };
}

/** Session identity scopes nested subagent shell records and resume visibility. */
export function buildShellEnv(
  sm?: {
    getSessionId(): string | undefined;
    getSessionDir(): string | undefined;
  },
  artifact_owner?: SessionOwner,
): NodeJS.ProcessEnv {
  const env = getToolEnv();
  const id = sm?.getSessionId();
  const dir = sm?.getSessionDir();
  const owner =
    artifact_owner ??
    inheritedSessionOwner() ??
    (id
      ? captureSessionOwner(
          {
            getSessionId: () => id,
            getSessionDir: () => dir ?? "",
          },
          join(getAgentDir(), "jobs"),
        )
      : undefined);
  delete env.CPI_ARTIFACT_SESSION_ID;
  delete env.CPI_ARTIFACT_SESSION_DIR;
  if (owner) {
    env.CPI_ARTIFACT_SESSION_ID = owner.session_id;
    env.CPI_ARTIFACT_SESSION_DIR = owner.session_dir;
  }
  if (sm) {
    if (id) env.PI_SESSION = id.slice(0, 8);
    if (id) env.PI_SESSION_ID = id;
    if (id)
      env.CPI_GHOSTMUX_SOCKET = ghostmuxSocket({
        ...env,
        CPI_GHOSTMUX_SOCKET: undefined,
      });
    if (dir) env.PI_SESSION_DIR = dir;
  }
  return env;
}

export function buildShellEnvWithDotenv(
  sm?: {
    getSessionId(): string | undefined;
    getSessionDir(): string | undefined;
  },
  envPath?: string | null,
  artifact_owner?: SessionOwner,
): NodeJS.ProcessEnv {
  const env = buildShellEnv(sm, artifact_owner);
  if (!envPath) return env;
  const controlEnv = new Map(
    CPI_CONTROL_ENV_KEYS.map((key) => [key, env[key]]),
  );
  const parsed = parseDotEnv(resolveCwdPath(envPath));
  for (const [k, v] of Object.entries(parsed)) env[k] = v;
  for (const [key, value] of controlEnv) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  refreshHostRoutingEnv(env);
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === "path");
  const pathKey = IS_WIN ? (pathKeys[pathKeys.length - 1] ?? "PATH") : "PATH";
  if (IS_WIN) {
    for (const key of pathKeys) {
      if (key !== pathKey) delete env[key];
    }
  }
  const path = (env[pathKey] ?? "")
    .split(delimiter)
    .filter((p) => p !== VENDOR_BIN && p !== BIN_DIR);
  env[pathKey] = [VENDOR_BIN, BIN_DIR, ...path].join(delimiter);
  return env;
}

export function getShuckBinPath(): string | null {
  const p = join(BIN_DIR, binName("shuck"));
  return existsSync(p) ? p : null;
}

export function getWasmPath(): string | null {
  return getTreeSitterWasmPath();
}

initTreeSitterWasm(getWasmPath);
