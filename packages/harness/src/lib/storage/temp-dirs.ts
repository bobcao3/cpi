import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  opendirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { reserve_owned_operation } from "./operations.ts";
import { storage_host_id } from "./paths.ts";
import {
  sessionArtifactDirectory,
  sessionArtifactPath,
  type SessionOwner,
} from "./owner.ts";
import {
  diagnostic,
  directory_identity,
  missing,
  private_directory,
  reject_nested_mounts,
  read_private_record,
  same_identity,
  sync_private_directory,
  write_private_record,
  type DirectoryIdentity,
} from "./temp-dir-records.ts";

export interface ManagedDirectory {
  readonly id: string;
  readonly path: string;
  readonly type: "scratch" | "retained";
  readonly lifecycle: "session-cleanup" | "explicit-release";
  readonly created_at: string;
  readonly purpose: string;
  readonly owner: SessionOwner;
}
export interface DirectoryInventory {
  directories: ManagedDirectory[];
  inventory_errors: string[];
}
interface DirectoryRecord extends ManagedDirectory {
  version: 1;
  slot: number;
  state: "allocating" | "ready";
  host_id?: string;
  root_identity: DirectoryIdentity;
  identity?: DirectoryIdentity;
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_DIRECTORIES = 64;
const HOST_ID = storage_host_id();

function capture_owner(owner: SessionOwner): SessionOwner {
  const captured = Object.freeze({
    session_id: owner.session_id,
    session_dir: owner.session_dir,
  });
  sessionArtifactPath(captured, "temp-dirs");
  private_directory(captured.session_dir, false);
  return captured;
}
function payload_root(
  owner: SessionOwner,
  type: ManagedDirectory["type"],
): string {
  return sessionArtifactPath(owner, `temp-dir-${type}`);
}
function valid_identity(value: DirectoryIdentity | undefined): boolean {
  return (
    !!value &&
    [value.dev, value.ino, value.birthtime_ns].every(
      (part) => typeof part === "string" && /^\d{1,24}$/.test(part),
    )
  );
}
function read_record(
  owner: SessionOwner,
  directory: string,
  id: string,
): DirectoryRecord {
  const value = read_private_record(
    join(directory, `${id}.json`),
  ) as DirectoryRecord;
  if (
    !value ||
    value.version !== 1 ||
    value.id !== id ||
    !UUID.test(id) ||
    !["scratch", "retained"].includes(value.type) ||
    (value.type === "scratch"
      ? !["session-cleanup", "release-before-finish"].includes(value.lifecycle)
      : value.lifecycle !== "explicit-release") ||
    value.owner?.session_id !== owner.session_id ||
    value.owner?.session_dir !== owner.session_dir ||
    !Number.isInteger(value.slot) ||
    value.slot < 0 ||
    value.slot >= MAX_DIRECTORIES ||
    !["allocating", "ready"].includes(value.state) ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    typeof value.purpose !== "string" ||
    !value.purpose ||
    Buffer.byteLength(value.purpose) > 256 ||
    value.purpose.includes("\0") ||
    (value.host_id !== undefined &&
      (typeof value.host_id !== "string" || value.host_id.length > 128)) ||
    value.path !== join(payload_root(owner, value.type), id) ||
    !valid_identity(value.root_identity) ||
    (value.state === "ready" && !valid_identity(value.identity))
  )
    throw new Error(`invalid directory record: ${id}`);
  return value;
}
function read_slot(directory: string, slot: number): string {
  const value = read_private_record(join(directory, `slot-${slot}`)) as {
    version: number;
    id: string;
  };
  if (
    !value ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !UUID.test(value.id)
  )
    throw new Error(`invalid directory slot: ${slot}`);
  return value.id;
}
function managed(record: DirectoryRecord): ManagedDirectory {
  return Object.freeze({
    id: record.id,
    path: record.path,
    type: record.type,
    lifecycle:
      record.type === "scratch" ? "session-cleanup" : "explicit-release",
    created_at: record.created_at,
    purpose: record.purpose,
    owner: Object.freeze({ ...record.owner }),
  });
}
function check_root(owner: SessionOwner, record: DirectoryRecord): void {
  const root = private_directory(payload_root(owner, record.type));
  if (!same_identity(root, record.root_identity))
    throw new Error(`directory payload root identity changed: ${record.id}`);
}

export async function create_temp_directory(
  owner: SessionOwner,
  type: ManagedDirectory["type"],
  purpose: string,
): Promise<ManagedDirectory> {
  owner = capture_owner(owner);
  if (!["scratch", "retained"].includes(type))
    throw new Error("invalid temporary directory type");
  if (
    typeof purpose !== "string" ||
    !purpose ||
    Buffer.byteLength(purpose) > 256 ||
    purpose.includes("\0")
  )
    throw new Error("invalid temporary directory purpose");
  const operation = reserve_owned_operation(owner, undefined, "external");
  const id = randomUUID();
  try {
    const directory = sessionArtifactDirectory(owner, "temp-dirs");
    private_directory(directory);
    const root = sessionArtifactDirectory(owner, `temp-dir-${type}`);
    const root_identity = directory_identity(private_directory(root));
    let slot = 0;
    for (; slot < MAX_DIRECTORIES; slot++) {
      try {
        write_private_record(join(directory, `slot-${slot}`), {
          version: 1,
          id,
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (slot === MAX_DIRECTORIES)
      throw new Error("temporary directory allocation limit reached");
    const record: DirectoryRecord = {
      version: 1,
      id,
      slot,
      state: "allocating",
      type,
      lifecycle: type === "scratch" ? "session-cleanup" : "explicit-release",
      created_at: new Date().toISOString(),
      purpose,
      owner,
      host_id: HOST_ID,
      path: join(root, id),
      root_identity,
    };
    const path = join(directory, `${id}.json`);
    write_private_record(path, record);
    check_root(owner, record);
    mkdirSync(record.path, { mode: 0o700 });
    record.identity = directory_identity(private_directory(record.path));
    record.state = "ready";
    const update = join(directory, `${id}.update`);
    write_private_record(update, record);
    renameSync(update, path);
    sync_private_directory(directory);
    return managed(record);
  } catch (error) {
    throw new Error(
      `temporary directory allocation ${id} failed; incomplete metadata is retained: ${diagnostic(error)}`,
      { cause: error },
    );
  } finally {
    operation.finish();
  }
}

export async function inventory_temp_directories(
  owner: SessionOwner,
): Promise<DirectoryInventory> {
  const result: DirectoryInventory = { directories: [], inventory_errors: [] };
  try {
    try {
      owner = capture_owner(owner);
    } catch (error) {
      if (missing(error)) return result;
      throw error;
    }
    const directory = sessionArtifactPath(owner, "temp-dirs");
    try {
      private_directory(directory);
    } catch (error) {
      if (missing(error)) return result;
      throw error;
    }
    const slots = new Map<number, string>();
    const records = new Map<string, DirectoryRecord>();
    const entries = opendirSync(directory);
    try {
      for (let count = 0; ; count++) {
        const entry = entries.readSync();
        if (!entry) break;
        if (count >= 256) {
          result.inventory_errors.push(
            "temporary directory inventory entry limit reached; inventory incomplete",
          );
          break;
        }
        try {
          if (
            /^slot-(0|[1-9]\d?)$/.test(entry.name) &&
            Number(entry.name.slice(5)) < MAX_DIRECTORIES
          ) {
            const slot = Number(entry.name.slice(5));
            slots.set(slot, read_slot(directory, slot));
          } else if (
            entry.name.endsWith(".json") &&
            UUID.test(entry.name.slice(0, -5))
          ) {
            const id = entry.name.slice(0, -5);
            records.set(id, read_record(owner, directory, id));
          } else {
            throw new Error(
              `unexpected directory metadata entry: ${entry.name}`,
            );
          }
        } catch (error) {
          result.inventory_errors.push(
            `${join(directory, entry.name)}: ${diagnostic(error)}`,
          );
        }
      }
    } finally {
      entries.closeSync();
    }
    for (const [slot, id] of slots) {
      if (records.get(id)?.slot !== slot)
        result.inventory_errors.push(
          `${join(directory, `slot-${slot}`)}: reservation has no matching directory record (${id})`,
        );
    }
    for (const record of records.values()) {
      try {
        if (slots.get(record.slot) !== record.id)
          throw new Error("directory reservation mismatch");
        if (record.state !== "ready")
          throw new Error("directory allocation incomplete");
        check_root(owner, record);
        if (!same_identity(private_directory(record.path), record.identity!))
          throw new Error("directory identity changed");
        result.directories.push(managed(record));
      } catch (error) {
        if (missing(error))
          await release_temp_directory(owner, record.id).catch((failure) =>
            result.inventory_errors.push(
              `${record.id}: ${diagnostic(failure)}`,
            ),
          );
        else
          result.inventory_errors.push(`${record.path}: ${diagnostic(error)}`);
      }
    }
  } catch (error) {
    result.inventory_errors.push(
      `temporary directory inventory failed: ${diagnostic(error)}`,
    );
  }
  return result;
}

export async function release_temp_directory_by_path(
  owner: SessionOwner,
  path: string,
): Promise<void> {
  owner = capture_owner(owner);
  if (typeof path !== "string" || !UUID.test(basename(path)))
    throw new Error("invalid temporary directory path");
  const directory = sessionArtifactPath(owner, "temp-dirs");
  private_directory(directory);
  const record = read_record(owner, directory, basename(path));
  if (record.path !== path)
    throw new Error("temporary directory path is not owned by this session");
  await release_temp_directory(owner, record.id);
}

export async function release_temp_directory(
  owner: SessionOwner,
  id: string,
  automatic = false,
): Promise<void> {
  owner = capture_owner(owner);
  if (typeof id !== "string" || !UUID.test(id))
    throw new Error("invalid temporary directory ID");
  const directory = sessionArtifactPath(owner, "temp-dirs");
  private_directory(directory);
  const record = read_record(owner, directory, id);
  if (automatic && record.host_id !== HOST_ID)
    throw new Error(
      `automatic scratch cleanup cannot confirm writers from another host: ${id}`,
    );
  if (read_slot(directory, record.slot) !== id)
    throw new Error("directory reservation mismatch");
  if (record.state !== "ready")
    throw new Error(
      `directory allocation incomplete; release requires manual reconciliation: ${id}`,
    );
  check_root(owner, record);
  try {
    if (!same_identity(private_directory(record.path), record.identity!))
      throw new Error(`directory identity changed: ${id}`);
    check_root(owner, record);
    reject_nested_mounts(record.path);
    await rm(record.path, { recursive: true, force: false, maxRetries: 0 });
  } catch (error) {
    if (!missing(error)) throw error;
  }
  check_root(owner, record);
  try {
    lstatSync(record.path);
    throw new Error(`directory remains after release: ${id}`);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  private_directory(directory);
  let current: DirectoryRecord;
  try {
    current = read_record(owner, directory, id);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (JSON.stringify(current) !== JSON.stringify(record))
    throw new Error(`directory metadata changed: ${id}`);
  try {
    unlinkSync(join(directory, `${id}.json`));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  sync_private_directory(directory);
  if (read_slot(directory, record.slot) !== id)
    throw new Error("directory reservation changed after release");
  unlinkSync(join(directory, `slot-${record.slot}`));
  sync_private_directory(directory);
}

export async function pending_temp_directories(
  owner: SessionOwner,
): Promise<string[]> {
  const inventory = await inventory_temp_directories(owner);
  return [
    ...inventory.inventory_errors,
    ...inventory.directories
      .filter((directory) => directory.type === "scratch")
      .map(
        (directory) => `${directory.path}: automatic scratch cleanup pending`,
      ),
  ];
}
