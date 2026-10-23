import { randomUUID } from "node:crypto";
import { owner_key, type SessionOwner } from "./owner.ts";

export interface OwnedOperation {
  readonly id: string;
  readonly owner: SessionOwner;
  readonly signal: AbortSignal;
  join(cancel?: boolean): Promise<void>;
  finish(): void;
  pending(error: unknown, retry: () => Promise<void>, path: string): void;
}
interface Entry {
  operation: OwnedOperation;
  controller: AbortController;
  settled: Promise<void>;
  children: Set<Entry>;
  accepting_children: boolean;
  path?: string;
  error?: string;
  retry?: () => Promise<void>;
}
interface OwnerState {
  owner: SessionOwner;
  accepting: boolean;
  entries: Map<string, Entry>;
}
interface Recovery {
  owner: SessionOwner;
  path: string;
  error?: string;
  retry: () => Promise<void>;
}
const globals = globalThis as Record<string, unknown>;
const registry = (globals.__cpiStorageOperations ??= {
  owners: new Map(),
  closing: false,
  draining: false,
  signals: new WeakMap(),
}) as {
  owners: Map<string, OwnerState>;
  closing: boolean;
  draining: boolean;
  signals: WeakMap<AbortSignal, Entry>;
  recoveries?: Map<string, Recovery>;
  recovery_overflow?: string;
};
registry.signals ??= new WeakMap();
const recoveries = (registry.recoveries ??= new Map());
const owners = registry.owners;
const MAX_OWNERS = 1024;
const MAX_OPERATIONS = 64;

export function reserve_storage_recovery(
  owner: SessionOwner,
  retry: () => Promise<void>,
  path: string,
): { finish(): void; pending(error: unknown): void } {
  let existing: [string, Recovery] | undefined;
  for (const entry of recoveries) {
    if (
      entry[1].path !== path ||
      owner_key(entry[1].owner) !== owner_key(owner)
    )
      continue;
    if (existing) recoveries.delete(entry[0]);
    else existing = entry;
  }
  if (!existing && recoveries.size >= MAX_OWNERS) {
    registry.recovery_overflow =
      "storage recovery limit reached; cleanup blocked";
    throw new Error(registry.recovery_overflow);
  }
  const [id, recovery]: [string, Recovery] = existing ?? [
    randomUUID(),
    {
      owner: Object.freeze({ ...owner }),
      path,
      retry,
    },
  ];
  recoveries.set(id, recovery);
  return {
    finish() {
      recoveries.delete(id);
    },
    pending(error) {
      recovery.error = error instanceof Error ? error.message : String(error);
    },
  };
}

export function storage_owner_retired(owner: SessionOwner): boolean {
  return owners.get(owner_key(owner))?.accepting === false;
}
function owner_state(owner: SessionOwner): OwnerState {
  const key = owner_key(owner);
  let state = owners.get(key);
  if (!state) {
    if (owners.size >= MAX_OWNERS)
      throw new Error("storage owner limit reached");
    state = { owner, accepting: true, entries: new Map() };
    owners.set(key, state);
  }
  return state;
}
export function bind_storage_owner(owner: SessionOwner): void {
  registry.closing = false;
  registry.draining = false;
  owner_state(owner).accepting = true;
}
export function retire_storage_owner(owner: SessionOwner): void {
  owner_state(owner).accepting = false;
}
export function freeze_storage_operations(): void {
  registry.closing = true;
  registry.draining = false;
  for (const state of owners.values()) state.accepting = false;
}
export function drain_storage_operations(): void {
  registry.draining = true;
}
export function reserve_owned_operation(
  owner: SessionOwner,
  signal?: AbortSignal,
  admission: "internal" | "external" = "internal",
): OwnedOperation {
  if (registry.closing) throw new Error("host storage is closing");
  if (registry.draining && admission === "external")
    throw new Error("host storage is draining admitted work");
  const state = owner_state(owner);
  const parent = signal ? registry.signals.get(signal) : undefined;
  if (
    parent &&
    (!parent.accepting_children ||
      state.entries.get(parent.operation.id) !== parent)
  )
    throw new Error("parent storage operation has ended");
  if (!state.accepting && !parent)
    throw new Error("session storage is closing");
  let count = 0;
  for (const scope of owners.values()) count += scope.entries.size;
  if (count >= MAX_OPERATIONS) throw new Error("owned operation limit reached");
  const id = randomUUID();
  const controller = new AbortController();
  let settle!: () => void;
  const entry: Entry = {
    controller,
    settled: new Promise((resolve) => {
      settle = resolve;
    }),
    children: new Set(),
    accepting_children: true,
    operation: {
      id,
      owner,
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
      async join(cancel = false) {
        entry.accepting_children = false;
        if (cancel)
          for (const child of entry.children) child.controller.abort();
        await Promise.all([...entry.children].map((child) => child.settled));
      },
      finish() {
        entry.accepting_children = false;
        parent?.children.delete(entry);
        state.entries.delete(id);
        settle();
      },
      pending(error, retry, path) {
        entry.accepting_children = false;
        parent?.children.delete(entry);
        entry.error = error instanceof Error ? error.message : String(error);
        entry.retry = retry;
        entry.path = path;
        settle();
      },
    },
  };
  state.entries.set(id, entry);
  registry.signals.set(entry.operation.signal, entry);
  parent?.children.add(entry);
  return entry.operation;
}
function selected_entries(owner?: SessionOwner): Entry[] {
  return owner
    ? [...(owners.get(owner_key(owner))?.entries.values() ?? [])]
    : [...owners.values()].flatMap((state) => [...state.entries.values()]);
}
export function pending_storage_operations(owner?: SessionOwner): string[] {
  return [
    ...selected_entries(owner).map(
      (entry) =>
        `${entry.path ?? entry.operation.id}${entry.error ? `: ${entry.error}` : ""}`,
    ),
    ...[...recoveries.values()]
      .filter((entry) => !owner || owner_key(entry.owner) === owner_key(owner))
      .map((entry) => `${entry.path}${entry.error ? `: ${entry.error}` : ""}`),
    ...(registry.recovery_overflow ? [registry.recovery_overflow] : []),
  ];
}
export function storage_owners(): SessionOwner[] {
  return [...owners.values(), ...recoveries.values()].map(
    (state) => state.owner,
  );
}
export async function finish_storage_operations(
  signal: AbortSignal,
  owner?: SessionOwner,
): Promise<{ pending: string[] }> {
  const entries = selected_entries(owner);
  for (const entry of entries) entry.controller.abort();
  const joined = Promise.all([
    ...entries.map(async (entry) => {
      await entry.settled;
      if (entry.retry) {
        try {
          await entry.retry();
          entry.operation.finish();
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
        }
      }
    }),
    ...[...recoveries.entries()]
      .filter(
        ([, entry]) => !owner || owner_key(entry.owner) === owner_key(owner),
      )
      .map(async ([id, entry]) => {
        try {
          await entry.retry();
          recoveries.delete(id);
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
        }
      }),
  ]);
  let abort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await Promise.race([joined, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return { pending: pending_storage_operations(owner) };
}
