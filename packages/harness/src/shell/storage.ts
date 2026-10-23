import type { SessionOwner } from "../lib/storage/owner.ts";
import {
  reserve_owned_operation,
  reserve_storage_recovery,
  type OwnedOperation,
} from "../lib/storage/operations.ts";
import { reapLaunch, type MonitorClient } from "./ghostmux-client.ts";
import { ghostmuxRequest } from "./ghostmux-transport.ts";
import {
  shellTarget,
  ShellIdentityError,
  type ShellRecord,
} from "./persistence.ts";
import type { BackgroundChild } from "./background-types.ts";

export function holdShellRecovery(record: ShellRecord, owner: SessionOwner) {
  return reserve_storage_recovery(
    owner,
    async () => {
      const target = await shellTarget(record);
      await reapLaunch(target);
    },
    record.statePath,
  );
}

export async function adoptShellStorage(
  client: MonitorClient,
  record: ShellRecord,
  owner: SessionOwner,
  entry?: BackgroundChild,
): Promise<ShellStorage> {
  await client.stat();
  let target = await shellTarget(record);
  if (
    client.statePath !== record.statePath ||
    client.target?.uid !== target.uid ||
    client.target.pid !== target.pid ||
    client.target.serverPid !== target.serverPid ||
    client.target.socketPath !== target.socketPath
  )
    throw new ShellIdentityError("Shell recovery identity changed");
  if (!target.completed) {
    try {
      const response = await ghostmuxRequest(
        target.socketPath,
        { op: "list_sessions" },
        undefined,
        target.binaryPath,
      );
      if (!response.ok || response.server_pid !== target.serverPid)
        throw new ShellIdentityError("Shell recovery daemon identity changed");
      if (
        !response.sessions?.some(
          (session) => session.uid === target.uid && session.pid === target.pid,
        )
      ) {
        target = await shellTarget(record);
        if (!target.completed)
          throw new Error("Shell recovery session missing");
      }
    } catch (error) {
      target = await shellTarget(record);
      if (!target.completed) throw error;
    }
  }
  if (entry?.storage) return entry.storage;
  const storage = new ShellStorage(owner);
  storage.background = true;
  storage.bind(client);
  if (entry) entry.storage = storage;
  return storage;
}

export class ShellStorage {
  readonly operation: OwnedOperation;
  background = false;
  private client?: MonitorClient;
  private cleanup?: Promise<void>;
  private failure?: unknown;
  private released = false;
  private readonly abort = () => {
    void this.reap().catch(() => {});
  };

  constructor(owner: SessionOwner, signal?: AbortSignal) {
    this.operation = reserve_owned_operation(
      Object.freeze({ ...owner }),
      signal,
    );
  }

  bind(client: MonitorClient): void {
    this.client = client;
    this.operation.signal.addEventListener("abort", this.abort, { once: true });
    if (this.operation.signal.aborted) this.abort();
  }

  pending(error: unknown, retry: () => Promise<void>, path: string): void {
    if (this.released) return;
    this.failure = error;
    this.operation.pending(
      error,
      async () => {
        await retry();
        this.release();
      },
      path,
    );
  }

  reap(): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.cleanup) return this.cleanup;
    if (this.failure) return Promise.reject(this.failure);
    const client = this.client;
    if (!client) {
      this.release();
      return Promise.resolve();
    }
    this.cleanup = client.reap().then(
      () => this.release(),
      (error) => {
        this.pending(error, () => client.reap(), client.statePath);
        throw error;
      },
    );
    return this.cleanup;
  }

  sendSignal(signal: string): void {
    const client = this.client!;
    void client.signal(signal).catch((error) => {
      this.pending(error, () => client.reap(), client.statePath);
    });
  }

  release(): void {
    this.released = true;
    this.operation.signal.removeEventListener("abort", this.abort);
    this.operation.finish();
  }
}
