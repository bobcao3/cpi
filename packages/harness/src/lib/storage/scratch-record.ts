import { isAbsolute, join, resolve } from "node:path";
import {
  read_private_record,
  type DirectoryIdentity,
} from "./temp-dir-records.ts";

export type ScratchState = "pending" | "closed" | "retained";
export type ScratchEvidence = "none" | "controller_close" | "host_exit";

export interface ScratchRecord {
  version: 1;
  owner_uid: number;
  guardian_pid: number;
  host_pid: number;
  session_id: string;
  session_dir: string;
  root: string;
  journal: string;
  id: string;
  path: string;
  identity: DirectoryIdentity | null;
  scope_removed: boolean;
  root_identity: DirectoryIdentity;
  retain: boolean;
  state: ScratchState;
  host_closed: boolean;
  closure_evidence: ScratchEvidence;
  error_name: string | null;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= limit &&
    !value.includes("\0")
  );
}
function absolute(value: unknown): value is string {
  return text(value, 4096) && isAbsolute(value) && value === resolve(value);
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function identity(value: unknown): value is DirectoryIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as DirectoryIdentity;
  return [candidate.dev, candidate.ino, candidate.birthtime_ns].every(
    (part) => typeof part === "string" && /^\d{1,24}$/.test(part),
  );
}
function normalized_identity(value: unknown): DirectoryIdentity | undefined {
  if (identity(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const legacy = value as Record<string, unknown>;
  if (
    !integer(legacy.inode) ||
    !integer(legacy.device_major) ||
    !integer(legacy.device_minor) ||
    !integer(legacy.birth_seconds) ||
    !integer(legacy.birth_nanoseconds) ||
    legacy.birth_nanoseconds > 999999999
  )
    return undefined;
  const major = BigInt(legacy.device_major);
  const minor = BigInt(legacy.device_minor);
  const dev =
    ((major & 0xfffn) << 8n) |
    ((major & ~0xfffn & 0xffffffffn) << 32n) |
    (minor & 0xffn) |
    ((minor & ~0xffn) << 12n);
  return {
    dev: String(dev),
    ino: String(legacy.inode),
    birthtime_ns: String(
      BigInt(legacy.birth_seconds) * 1000000000n +
        BigInt(legacy.birth_nanoseconds),
    ),
  };
}
function evidence(value: unknown): ScratchEvidence {
  if (value === "pidfd_exit") return "host_exit";
  if (value === "none" || value === "controller_close" || value === "host_exit")
    return value;
  throw new Error("invalid scratch evidence");
}

export function parse_scratch_record(value: unknown): ScratchRecord {
  if (!value || typeof value !== "object")
    throw new Error("invalid scratch record");
  const source = value as Record<string, unknown>;
  const record: ScratchRecord = {
    version: source.version as 1,
    owner_uid: source.owner_uid as number,
    guardian_pid: source.guardian_pid as number,
    host_pid: source.host_pid as number,
    session_id: source.session_id as string,
    session_dir: source.session_dir as string,
    root: source.root as string,
    journal: source.journal as string,
    id: source.id as string,
    path: source.path as string,
    identity: normalized_identity(source.identity) ?? null,
    scope_removed: source.scope_removed as boolean,
    root_identity: normalized_identity(
      source.root_identity,
    ) as DirectoryIdentity,
    retain: source.retain as boolean,
    state: source.state as ScratchState,
    host_closed: source.host_closed as boolean,
    closure_evidence: evidence(source.closure_evidence),
    error_name: source.error_name as string | null,
  };
  if (
    record.version !== 1 ||
    !integer(record.owner_uid) ||
    !integer(record.guardian_pid) ||
    record.guardian_pid <= 1 ||
    !integer(record.host_pid) ||
    record.host_pid <= 1 ||
    !text(record.session_id, 1024) ||
    !absolute(record.session_dir) ||
    !absolute(record.root) ||
    !absolute(record.journal) ||
    typeof record.id !== "string" ||
    !UUID.test(record.id) ||
    !absolute(record.path) ||
    record.path !== scratch_scope_path(record.root, record.id, record.retain) ||
    !record.root_identity ||
    (source.identity !== null && record.identity === null) ||
    typeof record.scope_removed !== "boolean" ||
    typeof record.retain !== "boolean" ||
    !["pending", "closed", "retained"].includes(record.state) ||
    typeof record.host_closed !== "boolean" ||
    (record.closure_evidence === "host_exit" && !record.host_closed) ||
    (record.state !== "pending" && record.closure_evidence === "none") ||
    (record.state === "closed" && !record.scope_removed) ||
    (record.error_name !== null && !text(record.error_name, 256))
  )
    throw new Error("invalid scratch record");
  return record;
}

export function read_scratch_record(path: string): ScratchRecord {
  return parse_scratch_record(read_private_record(path));
}

export function scratch_scope_name(id: string, retain: boolean): string {
  if (!UUID.test(id)) throw new Error("invalid scratch id");
  return `${retain ? "retained" : "scratch"}-${id}`;
}
export function scratch_scope_path(
  root: string,
  id: string,
  retain: boolean,
): string {
  return join(root, scratch_scope_name(id, retain));
}
export function scratch_record_path(journal: string, id: string): string {
  if (!UUID.test(id)) throw new Error("invalid scratch id");
  return join(journal, `${id}.json`);
}
