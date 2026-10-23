import type {
  ExtensionAPI,
  SessionCleanupHook,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { createSessionOwner, type SessionOwner } from "./owner.ts";
import { pending_guardian_records } from "./journal.ts";
import { pending_temp_directories } from "./temp-dirs.ts";
import { cleanup_temp_directories } from "./temp-dir-cleanup.ts";
import {
  finish_storage_operations,
  pending_storage_operations,
  drain_storage_operations,
  freeze_storage_operations,
  retire_storage_owner,
  storage_owners,
} from "./operations.ts";

function storage_cleanup(
  job_storage_base: string,
  headless_drain: () => boolean = () => false,
  bound_owner: () => SessionOwner | undefined = () => undefined,
): SessionCleanupHook {
  return async (event, signal) => {
    if (typeof event.legacy_completed !== "boolean")
      throw new Error("cpi storage requires host cleanup completion receipts");
    const bound = bound_owner();
    const owner =
      bound?.session_id === event.session_id
        ? bound
        : createSessionOwner(
            event.session_id,
            event.session_dir
              ? realpathSync(event.session_dir)
              : job_storage_base,
          );
    if (event.phase === "prepare") {
      if (event.reason === "quit") {
        if (headless_drain()) drain_storage_operations();
        else freeze_storage_operations();
      } else if (event.reason !== "reload") retire_storage_owner(owner);
      return;
    }
    if (event.reason !== "quit" && event.reason !== "delete") return;
    const incomplete_legacy = !event.legacy_completed;
    if (event.reason === "quit" && !incomplete_legacy)
      freeze_storage_operations();
    const result = incomplete_legacy
      ? {
          pending: pending_storage_operations(
            event.reason === "delete" ? owner : undefined,
          ),
        }
      : await finish_storage_operations(
          signal,
          event.reason === "delete" ? owner : undefined,
        );
    const scopes =
      event.reason === "delete" ? [owner] : [owner, ...storage_owners()];
    const reconciled = new Set<string>();
    for (const scope of scopes) {
      const key = JSON.stringify([scope.session_dir, scope.session_id]);
      if (reconciled.has(key)) continue;
      reconciled.add(key);
      if (signal.aborted) {
        result.pending.push("storage reconciliation deadline reached");
        break;
      }
      result.pending.push(
        ...(await pending_guardian_records(
          scope,
          signal,
          event.reason === "quit" ? process.pid : undefined,
        )),
      );
      if (signal.aborted) {
        result.pending.push(
          "temporary directory reconciliation deadline reached",
        );
        break;
      }
    }
    const can_cleanup =
      !incomplete_legacy && result.pending.length === 0 && !signal.aborted;
    reconciled.clear();
    for (const scope of scopes) {
      const key = JSON.stringify([scope.session_dir, scope.session_id]);
      if (reconciled.has(key)) continue;
      reconciled.add(key);
      if (signal.aborted) {
        result.pending.push("temporary directory cleanup deadline reached");
        break;
      }
      result.pending.push(
        ...(can_cleanup
          ? await cleanup_temp_directories(scope, signal)
          : await pending_temp_directories(scope)),
      );
    }
    return result;
  };
}
export function register_storage_lifecycle(
  pi: ExtensionAPI,
  job_storage_base: string,
  headless_drain: () => boolean = () => false,
  bound_owner: () => SessionOwner | undefined = () => undefined,
): void {
  const cleanup = storage_cleanup(
    job_storage_base,
    headless_drain,
    bound_owner,
  );
  pi.on("session_cleanup", (event) => cleanup(event, event.signal));
}
export function create_storage_delete_guard(
  job_storage_base: string,
): SessionCleanupHook {
  return storage_cleanup(job_storage_base);
}
