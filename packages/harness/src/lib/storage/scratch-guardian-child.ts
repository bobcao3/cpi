import { mkdirSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import readline from "node:readline";
import {
  directory_identity,
  private_directory,
  replace_private_record,
  write_private_record,
} from "./temp-dir-records.ts";
import {
  read_scratch_record,
  scratch_record_path,
  scratch_scope_path,
  type ScratchEvidence,
  type ScratchRecord,
} from "./scratch-record.ts";
import { remove_scratch_scope, scratch_root_identity } from "./scratch-tree.ts";

const REGISTRATION_TIMEOUT_MS = 10000;
const DEATH_RETRY_MS = 1000;
const DEATH_TIMEOUT_MS = 60000;
const MAX_FRAME_BYTES = 16384;
const MAX_JOURNAL_ENTRIES = 4096;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Registration {
  version: 1;
  host_pid: number;
  session_id: string;
  session_dir: string;
  root: string;
  journal: string;
  id: string;
  retain: boolean;
}
interface Guardian {
  record: ScratchRecord;
  record_path: string;
  scope_path: string;
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  writeSync(2, `cpi scratch guardian: ${message}\n`);
  process.exit(1);
}
function parse_registration(text: string): Registration {
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES || !text)
    throw new Error("invalid guardian registration size");
  const value = JSON.parse(text) as Record<string, unknown> | null;
  if (!value || typeof value !== "object")
    throw new Error("invalid guardian registration");
  const registration = value as unknown as Registration;
  if (
    registration.version !== 1 ||
    !Number.isSafeInteger(registration.host_pid) ||
    registration.host_pid <= 1 ||
    typeof registration.session_id !== "string" ||
    !registration.session_id ||
    Buffer.byteLength(registration.session_id) > 1024 ||
    registration.session_id.includes("\0") ||
    typeof registration.session_dir !== "string" ||
    typeof registration.root !== "string" ||
    typeof registration.journal !== "string" ||
    !isAbsolute(registration.session_dir) ||
    !isAbsolute(registration.root) ||
    !isAbsolute(registration.journal) ||
    registration.session_dir.includes("\0") ||
    registration.root.includes("\0") ||
    registration.journal.includes("\0") ||
    typeof registration.id !== "string" ||
    !UUID.test(registration.id) ||
    typeof registration.retain !== "boolean"
  )
    throw new Error("invalid guardian registration");
  if (process.platform !== "win32" && registration.host_pid !== process.ppid)
    throw new Error("guardian host already exited");
  return registration;
}
function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix !== "" &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix)
  );
}
function canonical(path: string): string {
  const real = realpathSync(path);
  return normalize(real);
}
function normalize(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function register(registration: Registration): Guardian {
  const session_dir = canonical(registration.session_dir);
  if (session_dir !== normalize(registration.session_dir))
    throw new Error("noncanonical session directory");
  const root = resolve(registration.root);
  const journal = resolve(registration.journal);
  if (!inside(session_dir, normalize(root)))
    throw new Error("scratch root is outside the session directory");
  if (!inside(session_dir, normalize(journal)))
    throw new Error("scratch journal is outside the session directory");
  if (
    inside(normalize(root), normalize(journal)) ||
    inside(normalize(journal), normalize(root))
  )
    throw new Error("overlapping scratch directories");
  const root_identity = scratch_root_identity(root);
  const journal_identity = scratch_root_identity(journal);
  if (
    root_identity.dev === journal_identity.dev &&
    root_identity.ino === journal_identity.ino
  )
    throw new Error("overlapping scratch directory identities");
  const record_path = scratch_record_path(journal, registration.id);
  const scope_path = scratch_scope_path(
    root,
    registration.id,
    registration.retain,
  );
  if (record_path.length >= 4096 || scope_path.length >= 4096)
    throw new Error("scratch path too long");
  reconcile(registration, root_identity);
  const record: ScratchRecord = {
    version: 1,
    owner_uid: process.getuid?.() ?? 0,
    guardian_pid: process.pid,
    host_pid: registration.host_pid,
    session_id: registration.session_id,
    session_dir: registration.session_dir,
    root,
    journal,
    id: registration.id,
    path: scope_path,
    identity: null,
    scope_removed: false,
    root_identity,
    retain: registration.retain,
    state: "pending",
    host_closed: false,
    closure_evidence: "none",
    error_name: null,
  };
  write_private_record(record_path, record);
  mkdirSync(scope_path, { mode: 0o700 });
  record.identity = directory_identity(private_directory(scope_path));
  replace_private_record(record_path, record);
  return { record, record_path, scope_path };
}
function reconcile(
  registration: Registration,
  root_identity: ScratchRecord["root_identity"],
): void {
  const journal = resolve(registration.journal);
  const entries = readdirSync(journal);
  if (entries.length > MAX_JOURNAL_ENTRIES)
    throw new Error("scratch journal limit reached");
  for (const name of entries) {
    if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue;
    const record_path = join(journal, name);
    let record: ScratchRecord;
    try {
      record = read_scratch_record(record_path);
    } catch {
      continue;
    }
    if (
      normalize(record.root) !== normalize(registration.root) ||
      normalize(record.journal) !== normalize(journal) ||
      record.root_identity.dev !== root_identity.dev ||
      record.root_identity.ino !== root_identity.ino ||
      record.root_identity.birthtime_ns !== root_identity.birthtime_ns ||
      record.state !== "pending" ||
      !record.host_closed ||
      record.closure_evidence === "none" ||
      !record.identity
    )
      continue;
    finish_record(record, record_path);
  }
}
function finish_record(
  record: ScratchRecord,
  record_path: string,
): string | undefined {
  try {
    record.state = "pending";
    record.error_name = null;
    replace_private_record(record_path, record);
    if (record.retain) record.state = "retained";
    else {
      if (!record.scope_removed) {
        if (!record.identity) throw new Error("scratch identity missing");
        remove_scratch_scope(
          record.root,
          record.root_identity,
          record.path,
          record.identity,
        );
        record.scope_removed = true;
      }
      record.state = "closed";
    }
    replace_private_record(record_path, record);
    return undefined;
  } catch (error) {
    record.error_name = error instanceof Error ? error.name : "CleanupFailed";
    try {
      replace_private_record(record_path, record);
    } catch {}
    return record.error_name;
  }
}
function receipt(
  guardian: Guardian,
  error?: string,
  state: ScratchRecord["state"] | "ready" = guardian.record.state,
): string {
  return (
    JSON.stringify({
      version: 1,
      state,
      path: guardian.scope_path,
      record: guardian.record_path,
      ...(error ? { error } : {}),
    }) + "\n"
  );
}
function flush_exit(code: number): void {
  process.stdout.write("", () => process.exit(code));
}
async function first_line(
  iterator: AsyncIterator<string>,
): Promise<IteratorResult<string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("guardian registration timed out")),
          REGISTRATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function host_exited(guardian: Guardian): Promise<never> {
  guardian.record.host_closed = true;
  guardian.record.closure_evidence = "host_exit";
  const deadline = Date.now() + DEATH_TIMEOUT_MS;
  while (true) {
    const failure = finish_record(guardian.record, guardian.record_path);
    if (!failure) process.exit(0);
    if (Date.now() >= deadline) process.exit(1);
    await delay(DEATH_RETRY_MS);
  }
}
async function supervise(
  guardian: Guardian,
  lines: readline.Interface,
  iterator: AsyncIterator<string>,
): Promise<void> {
  for (;;) {
    let next: IteratorResult<string>;
    try {
      next = await iterator.next();
    } catch {
      break;
    }
    if (next.done) break;
    const line = next.value;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      process.stdout.write(receipt(guardian, "InvalidCommand"));
      continue;
    }
    let command: unknown;
    try {
      command = (JSON.parse(line) as { command?: unknown }).command;
    } catch {
      process.stdout.write(receipt(guardian, "InvalidCommand"));
      continue;
    }
    if (command === "query") {
      process.stdout.write(
        receipt(guardian, guardian.record.error_name ?? undefined),
      );
      continue;
    }
    if (command !== "close") {
      process.stdout.write(receipt(guardian, "InvalidCommand"));
      continue;
    }
    guardian.record.closure_evidence = "controller_close";
    const failure = finish_record(guardian.record, guardian.record_path);
    if (failure) {
      process.stdout.write(receipt(guardian, failure));
      continue;
    }
    lines.close();
    process.stdin.destroy();
    process.stdout.write(receipt(guardian), () => process.exit(0));
    return;
  }
  await host_exited(guardian);
}

process.stdout.on("error", () => process.exit(0));
process.stderr.on("error", () => process.exit(0));
const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
const iterator = lines[Symbol.asyncIterator]() as AsyncIterator<string>;
try {
  const initial = await first_line(iterator);
  if (initial.done) throw new Error("missing guardian registration");
  const registration = parse_registration(initial.value);
  const guardian = register(registration);
  process.stdout.write(receipt(guardian, undefined, "ready"));
  void supervise(guardian, lines, iterator).catch(fail);
} catch (error) {
  fail(error);
}
