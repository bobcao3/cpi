import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";

export type StorageArea = "scratch" | "runtime" | "state" | "cache";
export interface StorageOptions {
  base?: string;
  env?: NodeJS.ProcessEnv;
}

function validate_purpose(purpose: string): void {
  if (typeof purpose !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(purpose))
    throw new Error("invalid storage purpose");
}

function absolute_root(root: string): string {
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))
    throw new Error("storage root must be an explicit absolute path");
  if (root.split(/[\\/]/).includes(".."))
    throw new Error("storage root must not contain parent traversal");
  return resolve(root);
}

function placement(options: StorageOptions): {
  root: string;
  private_root: boolean;
} {
  const override = (options.env ?? process.env).CPI_STORAGE_ROOT;
  if (override !== undefined)
    return { root: absolute_root(override), private_root: true };
  if (options.base !== undefined)
    return { root: absolute_root(options.base), private_root: false };
  return {
    root: absolute_root(join(tmpdir(), `cpi-${process.getuid?.() ?? "user"}`)),
    private_root: true,
  };
}

export function storage_path(
  area: StorageArea,
  purpose: string,
  options: StorageOptions = {},
): string {
  if (!["scratch", "runtime", "state", "cache"].includes(area))
    throw new Error("invalid storage area");
  validate_purpose(purpose);
  return join(placement(options).root, area, purpose);
}

function ensure_directory(directory: string, private_directory: boolean): void {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`storage directory is not a real directory: ${directory}`);
  if (
    private_directory &&
    ((process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
  )
    throw new Error(`storage directory is not private: ${directory}`);
}

function ensure_root(root: string, private_root: boolean): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  ensure_directory(root, private_root);
}

export function storage_directory(
  area: StorageArea,
  purpose: string,
  options: StorageOptions = {},
): string {
  const path = storage_path(area, purpose, options);
  const { root, private_root } = placement(options);
  ensure_root(root, private_root);
  ensure_directory(dirname(path), true);
  ensure_directory(path, true);
  return path;
}

export function storage_host_id(): string {
  const shared = globalThis as typeof globalThis & {
    __cpiStorageHostToken?: string;
  };
  const token = (shared.__cpiStorageHostToken ??=
    (!isMainThread && process.env.CPI_STORAGE_HOST_ID) || randomUUID());
  process.env.CPI_STORAGE_HOST_ID = token;
  return `${process.pid}:${token}`;
}

export function configure_storage_environment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  storage_host_id();
  env.CPI_STORAGE_HOST_ID = process.env.CPI_STORAGE_HOST_ID;
  if (env.CPI_STORAGE_ROOT !== undefined) {
    env.CPI_TEMP_DIR = storage_directory("scratch", "pi", { env });
    env.CPI_OUTPUT_DIR = storage_directory("state", "pi-output", { env });
    return;
  }
  env.CPI_TEMP_DIR ??= storage_directory("scratch", "pi", { env });
  env.CPI_OUTPUT_DIR ??= storage_directory("state", "pi-output", { env });
}

export function socket_directory(
  purpose: string,
  filename: string,
  options: StorageOptions = {},
): string {
  if (
    !filename ||
    isAbsolute(filename) ||
    filename.includes("\0") ||
    filename
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error("invalid socket filename");
  validate_purpose(purpose);
  const env = options.env ?? process.env;
  let directory: string | undefined;
  if (env.CPI_STORAGE_ROOT !== undefined || options.base !== undefined) {
    directory = storage_directory("runtime", purpose, options);
  } else {
    const candidates = [
      env.XDG_RUNTIME_DIR && {
        parent: env.XDG_RUNTIME_DIR,
        root: join(env.XDG_RUNTIME_DIR, "cpi"),
      },
      env.PI_SESSION_DIR && {
        parent: env.PI_SESSION_DIR,
        root: env.PI_SESSION_DIR,
      },
      env.HOME && { parent: env.HOME, root: join(env.HOME, ".cpi") },
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const stat = lstatSync(candidate.parent);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (process.getuid && stat.uid !== process.getuid())
        )
          continue;
        directory = storage_directory("runtime", purpose, {
          env: { ...env, CPI_STORAGE_ROOT: candidate.root },
        });
        break;
      } catch {}
    }
    if (!directory) directory = storage_directory("runtime", purpose, options);
  }
  if (
    process.platform === "win32" ||
    Buffer.byteLength(join(directory, filename)) <= 100
  )
    return directory;
  const uid = process.getuid?.();
  if (typeof uid !== "number")
    throw new Error("no numeric uid for private socket directory");
  const shortRoot = join("/tmp", `cpi-${uid}`);
  const shortPurpose = `ipc-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`;
  const shortDirectory = storage_directory("runtime", shortPurpose, {
    env: { CPI_STORAGE_ROOT: shortRoot },
  });
  if (Buffer.byteLength(join(shortDirectory, filename)) > 100)
    throw new Error("socket path exceeds Unix byte limit");
  return shortDirectory;
}

export async function with_temporary_directory<T>(
  purpose: string,
  work: (dir: string) => Promise<T>,
  options: StorageOptions = {},
): Promise<T> {
  const root = storage_directory("scratch", purpose, options);
  const directory = await mkdtemp(join(root, "scope-"));
  let failed = false;
  let failure: unknown;
  try {
    return await work(directory);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await rm(directory, { recursive: true, force: false });
    } catch (error) {
      throw new AggregateError(
        failed ? [failure, error] : [error],
        `temporary directory cleanup failed: ${directory}`,
      );
    }
  }
}

export function staging_path(destination: string): string {
  if (
    typeof destination !== "string" ||
    !destination ||
    destination.includes("\0")
  )
    throw new Error("invalid staging destination");
  const target = resolve(destination);
  if (target === parse(target).root)
    throw new Error("staging destination must name a file");
  return join(dirname(target), `.cpi-stage-${randomUUID()}.tmp`);
}

export function session_artifact_path(
  owner: { session_id: string; session_dir: string },
  purpose: string,
): string {
  validate_purpose(purpose);
  if (
    typeof owner.session_id !== "string" ||
    !owner.session_id ||
    Buffer.byteLength(owner.session_id) > 128 ||
    owner.session_id.includes("\0")
  )
    throw new Error("invalid artifact session ID");
  return join(
    absolute_root(owner.session_dir),
    "artifacts",
    createHash("sha256").update(owner.session_id).digest("hex"),
    purpose,
  );
}
