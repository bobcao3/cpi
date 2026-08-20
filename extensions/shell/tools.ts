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
import { delimiter, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveShell } from "./profile.ts";
import {
  initTreeSitterWasm,
  ensureTreeSitterReady,
} from "../lib/tree-sitter.ts";
import { parsePubKey, parseSig, verifyMinisign } from "../lib/minisig.ts";
import { parseDotEnv } from "../lib/dotenv.ts";
import { resolveCwdPath } from "../lib/cwd.ts";
import { runtimeEnv } from "../lib/runtime.ts";
import { CPI_SUBAGENT_RPC, getSubagentRpc } from "../lib/subagent-rpc.ts";
import { brotliDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const DL_TIMEOUT = 60_000;
const CACHE_DIR = join(getAgentDir(), "cache", "shell-tools");
const BIN_DIR = join(CACHE_DIR, "bin");
const VENDOR_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
);
const WASM_DIR = join(CACHE_DIR, "wasm");
const WASM_PATH = join(WASM_DIR, "tree-sitter-wasm.wasm");
const WASM_VERSION = "2026.06.20";
const WASM_PUBKEY_B64 =
  "RWQWdcLzFjpLqtjewtcZo71AHJVUFws3irxz2ColvNW/r0m4tHyxzDX5";
const WASM_SIG_PATH = join(WASM_DIR, "tree-sitter-wasm.wasm.minisig");
const WASM_URL = `https://github.com/bobcao3/cpi/releases/download/${WASM_VERSION}/tree-sitter-wasm.wasm.br`;
const WASM_SIG_URL = `https://github.com/bobcao3/cpi/releases/download/${WASM_VERSION}/tree-sitter-wasm.wasm.minisig`;
const WASM_PUB = parsePubKey(WASM_PUBKEY_B64);
const CPI_CONTROL_ENV_KEYS = [
  "CPI_RUNTIME_BIN",
  "CPI_RUNTIME_KIND",
  CPI_SUBAGENT_RPC,
  "PI_SESSION",
  "PI_SESSION_ID",
  "PI_SESSION_DIR",
  "PI_SUBAGENT",
  "PI_SUBAGENT_COMPLETION",
  "PI_SUBAGENT_ROLE",
  "PI_SUBAGENT_SUMMARY",
] as const;

function wasmVerifiedSync(): boolean {
  if (!existsSync(WASM_PATH) || !existsSync(WASM_SIG_PATH)) return false;
  try {
    return verifyMinisign(
      readFileSync(WASM_PATH),
      parseSig(readFileSync(WASM_SIG_PATH, "utf8")),
      WASM_PUB,
    );
  } catch {
    return false;
  }
}
const IS_WIN = process.platform === "win32";
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const binName = (n: string) => (IS_WIN ? `${n}.exe` : n);

async function verifyTool(binPath: string): Promise<boolean> {
  try {
    await execFileAsync(binPath, ["--version"], { windowsHide: true });
    return true;
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
    version: "v10.4.2",
    repo: "sharkdp/fd",
    archiveExt: IS_WIN ? "zip" : "tar.gz",
    assetPrefix: "fd-v10.4.2-",
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
    version: "15.1.0",
    repo: "BurntSushi/ripgrep",
    archiveExt: IS_WIN ? "zip" : "tar.gz",
    assetPrefix: "ripgrep-15.1.0-",
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
    version: "v0.0.41",
    repo: "ewhauser/shuck",
    archiveExt: IS_WIN ? "zip" : "tar.xz",
    assetPrefix: "shuck-cli-",
    targets: {
      "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-musl",
      "darwin-arm64": "aarch64-apple-darwin",
      "darwin-x64": "aarch64-apple-darwin",
      "win32-x64": "x86_64-pc-windows-msvc",
    },
  },
];

async function download(url: string, dest: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DL_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
    if (await verifyTool(binPath)) return true;
    await rm(binPath, { force: true });
  } catch {}
  const baseName = aname.replace(/\.(tar\.(?:gz|xz)|zip)$/, "");
  const url = `https://github.com/${spec.repo}/releases/download/${spec.version}/${aname}`;
  const tmp = join(tmpdir(), `pi-sh-${spec.name}-${Date.now()}`);
  const archivePath = join(tmp, aname);
  await mkdir(tmp, { recursive: true });
  try {
    await download(url, archivePath);
    await mkdir(tmp, { recursive: true });
    if (spec.archiveExt === "zip") {
      if (IS_WIN) {
        const profile = resolveShell("auto");
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
        await execFileAsync(
          profile.executable,
          profile.commandArgs(
            `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(tmp)} -Force`,
          ),
          { windowsHide: true },
        );
      } else {
        try {
          await execFileAsync("tar", ["-xf", archivePath, "-C", tmp]);
        } catch {
          await execFileAsync("unzip", ["-q", archivePath, "-d", tmp]);
        }
      }
    } else if (spec.archiveExt === "tar.xz") {
      try {
        await execFileAsync("tar", ["-xJf", archivePath, "-C", tmp]);
      } catch {
        await execFileAsync("tar", ["-xf", archivePath, "-C", tmp]);
      }
    } else {
      await execFileAsync("tar", ["-xzf", archivePath, "-C", tmp]);
    }
    await mkdir(BIN_DIR, { recursive: true });
    const extractedBin = join(tmp, binName(spec.name));
    const nestedBin = join(tmp, baseName, binName(spec.name));
    await copyFile(existsSync(nestedBin) ? nestedBin : extractedBin, binPath);
    if (!IS_WIN) await chmod(binPath, 0o755);
    if (!(await verifyTool(binPath)))
      throw new Error("tool verification failed");
    return true;
  } catch (err) {
    console.warn(`[shell-ext] Failed to install ${spec.name}:`, err);
    return false;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const TOOLS_G = globalThis as unknown as {
  __cpiShellTools?: Promise<ToolAvailability>;
};

async function doEnsureShellTools(): Promise<ToolAvailability> {
  const [fd, rg, shuck, treeSitter] = await Promise.all([
    ...TOOLS.map(ensureTool),
    IS_WIN
      ? Promise.resolve(false)
      : (async () => {
          let have = wasmVerifiedSync();
          if (!have) {
            try {
              await mkdir(WASM_DIR, { recursive: true });
              const tmpBr = join(tmpdir(), `pi-sh-wasm-${Date.now()}.br`);
              await download(WASM_URL, tmpBr);
              const compressed = await readFile(tmpBr);
              await rm(tmpBr, { force: true });
              await writeFile(WASM_PATH, brotliDecompressSync(compressed));
              try {
                await download(WASM_SIG_URL, WASM_SIG_PATH);
              } catch (err) {
                /* sig fetch failed; verify will fail below */
              }
              have = wasmVerifiedSync();
              if (!have) {
                await rm(WASM_PATH, { force: true });
                await rm(WASM_SIG_PATH, { force: true });
                console.warn(
                  "[shell-ext] tree-sitter-wasm signature verification failed; highlighting disabled",
                );
              }
            } catch (err) {
              console.warn(
                "[shell-ext] Failed to download tree-sitter-wasm:",
                err,
              );
            }
          }
          if (have) await ensureTreeSitterReady(); // keep first-paint highlighting synchronous
          return have;
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
export function buildShellEnv(sm?: {
  getSessionId(): string | undefined;
  getSessionDir(): string | undefined;
}): NodeJS.ProcessEnv {
  const env = getToolEnv();
  if (sm) {
    const id = sm.getSessionId();
    if (id) env.PI_SESSION = id.slice(0, 8);
    if (id) env.PI_SESSION_ID = id;
    const dir = sm.getSessionDir();
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
): NodeJS.ProcessEnv {
  const env = buildShellEnv(sm);
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
  return wasmVerifiedSync() ? WASM_PATH : null;
}

initTreeSitterWasm(getWasmPath);
