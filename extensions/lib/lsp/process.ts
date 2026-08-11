import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";

export interface LaunchTarget {
  bin: string;
  args: string[];
  pathDir: string;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const keys = Object.keys(env);
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = keys[index];
    if (key.toLowerCase() === name) return env[key];
  }
  return undefined;
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = envValue(env, "pathext") ?? ".COM;.EXE;.BAT;.CMD";
  const values = configured
    .split(";")
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`));
  return [
    "",
    ...new Set(values.flatMap((value) => [value, value.toLowerCase()])),
  ];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function whichOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (name.includes("/") || name.includes("\\"))
    return isExecutable(name) ? resolve(name) : null;
  const path = envValue(env, "path") ?? "";
  const extensions =
    process.platform === "win32" && !extname(name)
      ? windowsExtensions(env)
      : [""];
  for (const value of path.split(delimiter).filter(Boolean)) {
    const directory = value.replace(/^"|"$/g, "");
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function launchTarget(
  bin: string,
  env: NodeJS.ProcessEnv,
): LaunchTarget {
  const extension = extname(bin).toLowerCase();
  if (process.platform === "win32" && extension === ".ps1") {
    const host = whichOnPath("pwsh", env) ?? whichOnPath("powershell", env);
    if (host)
      return {
        bin: host,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", bin],
        pathDir: dirname(bin),
      };
  }
  if (process.platform === "win32" && [".bat", ".cmd"].includes(extension)) {
    const command = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    return {
      bin: command,
      args: ["/d", "/s", "/v:off", "/c", "call", bin],
      pathDir: dirname(bin),
    };
  }
  return { bin, args: [], pathDir: dirname(bin) };
}

export function nodeTarget(entry: string, pathDir?: string): LaunchTarget {
  return {
    bin: process.execPath,
    args: [entry],
    pathDir: pathDir ?? dirname(entry),
  };
}

function packageBin(packageDir: string, binName: string): string | null {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const relative =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
    if (!relative) return null;
    const entry = resolve(packageDir, relative);
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

export function npmPackageTarget(
  shim: string,
  packageName: string,
  binName: string,
): LaunchTarget | null {
  const binDir = dirname(shim);
  const roots = [
    join(binDir, "node_modules", packageName),
    join(dirname(binDir), packageName),
  ];
  for (const root of roots) {
    const entry = packageBin(root, binName);
    if (entry) return nodeTarget(entry, binDir);
  }
  return null;
}

export function installedNpmTarget(
  envDir: string,
  packageName: string,
  binName: string,
): LaunchTarget | null {
  const packageDir = join(envDir, "node_modules", packageName);
  const entry = packageBin(packageDir, binName);
  return entry ? nodeTarget(entry, join(envDir, "node_modules", ".bin")) : null;
}

export function npmCliTarget(env: NodeJS.ProcessEnv): LaunchTarget | null {
  const configured = envValue(env, "npm_execpath");
  const npm = whichOnPath("npm", env);
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    configured,
    npm && join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const entry of candidates) {
    if (
      entry &&
      [".js", ".cjs", ".mjs"].includes(extname(entry).toLowerCase()) &&
      existsSync(entry)
    )
      return nodeTarget(entry, dirname(entry));
  }
  return process.platform === "win32" || !npm ? null : launchTarget(npm, env);
}

export function runToCompletion(
  target: LaunchTarget,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(target.bin, [...target.args, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (data) => (stdout += data.toString("utf8")));
    child.stderr?.on("data", (data) => (stderr += data.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr, code });
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

export async function runCapture(
  target: LaunchTarget,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const result = await runToCompletion(target, args, cwd, env, timeoutMs);
  return result.stdout + result.stderr;
}
