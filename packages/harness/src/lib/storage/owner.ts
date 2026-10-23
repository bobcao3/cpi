import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import { session_artifact_path } from "./paths.ts";

export interface SessionOwner {
  readonly session_id: string;
  readonly session_dir: string;
}

interface SessionIdentity {
  getSessionId(): string;
  getSessionDir(): string;
}

type Binding = { id: string; directory: string; owner: SessionOwner };
const globals = globalThis as Record<string, unknown>;
const bindings = (globals.__cpiSessionOwners ??= new WeakMap()) as WeakMap<
  SessionIdentity,
  Binding
>;

export function createSessionOwner(
  id: string,
  directory: string,
): SessionOwner {
  if (
    typeof id !== "string" ||
    !id ||
    Buffer.byteLength(id) > 128 ||
    id.includes("\0")
  )
    throw new Error("invalid artifact session ID");
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    directory.includes("\0")
  )
    throw new Error(
      "artifact session directory must be an explicit absolute path",
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return Object.freeze({
    session_id: id,
    session_dir: realpathSync(directory),
  });
}

export function inheritedSessionOwner(): SessionOwner | undefined {
  if (isMainThread) return undefined;
  const inherited = globals.__cpiInheritedSessionOwner as
    | SessionOwner
    | undefined;
  if (inherited) return inherited;
  const value: unknown = workerData?.storageOwner;
  if (!value || typeof value !== "object") return undefined;
  const owner = value as SessionOwner;
  const captured = createSessionOwner(owner.session_id, owner.session_dir);
  Object.defineProperty(workerData, "storageOwner", {
    value: captured,
    writable: false,
    configurable: false,
  });
  globals.__cpiInheritedSessionOwner = captured;
  return captured;
}

export function captureSessionOwner(
  source: SessionIdentity,
  job_storage_base?: string,
): SessionOwner {
  const inherited = inheritedSessionOwner();
  if (inherited) return inherited;
  const id = source.getSessionId();
  const directory = source.getSessionDir();
  const existing = bindings.get(source);
  if (existing?.id === id && existing.directory === directory)
    return existing.owner;
  if (!directory && !job_storage_base)
    throw new Error("in-memory sessions require an explicit job storage base");
  const owner = createSessionOwner(
    id,
    directory ? realpathSync(directory) : job_storage_base!,
  );
  bindings.set(source, { id, directory, owner });
  return owner;
}

export function sameSessionOwner(a: SessionOwner, b: SessionOwner): boolean {
  return a.session_id === b.session_id && a.session_dir === b.session_dir;
}
export function owner_key(owner: SessionOwner): string {
  return `${owner.session_dir}\0${owner.session_id}`;
}

export function sessionArtifactPath(
  owner: SessionOwner,
  purpose: string,
): string {
  return session_artifact_path(owner, purpose);
}

export function sessionArtifactDirectory(
  owner: SessionOwner,
  purpose: string,
): string {
  let directory = owner.session_dir;
  const path = sessionArtifactPath(owner, purpose);
  for (const part of relative(directory, path).split(sep)) {
    directory = join(directory, part);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw new Error(`artifact directory is not private: ${directory}`);
  }
  return directory;
}
