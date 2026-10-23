import { ScratchGuardian } from "./guardian-client.ts";
import { reserve_owned_operation } from "./operations.ts";
import type { SessionOwner } from "./owner.ts";

export async function with_session_scratch<T>(
  owner: SessionOwner,
  purpose: string,
  work: (directory: string, signal: AbortSignal) => Promise<T>,
  options: { retain?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const operation = reserve_owned_operation(owner, options.signal);
  let guardian: ScratchGuardian | undefined;
  let failed = false;
  let failure: unknown;
  try {
    operation.signal.throwIfAborted();
    guardian = new ScratchGuardian(
      owner,
      purpose,
      operation.id,
      options.retain === true,
    );
    const directory = await guardian.start();
    operation.signal.throwIfAborted();
    return await work(directory, operation.signal);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await operation.join(failed);
      await guardian?.close();
      operation.finish();
    } catch (error) {
      const pending = guardian!;
      operation.pending(error, () => pending.close(), pending.path);
      throw new AggregateError(
        failed ? [failure, error] : [error],
        `scratch cleanup pending at ${pending.path}; journal: ${pending.record}`,
      );
    }
  }
}
