import {
  buildSessionProjection,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

const MAX_BRANCH_ENTRIES = 200_000;

export function compactionBoundary(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) {
  const branch = event.branchEntries;
  if (branch.length === 0 || branch.length > MAX_BRANCH_ENTRIES)
    throw new Error("Compaction branch must contain 1 to 200000 entries");
  const entries = buildSessionProjection(branch).entries;
  const kept = entries.findIndex(
    (entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId,
  );
  if (kept < 0)
    throw new Error(
      "Compaction kept boundary is absent from the active branch",
    );
  const session_id = ctx.sessionManager.getSessionId();
  const source_ids = branch.map((entry) => entry.id);
  const summarized_ids = new Set(
    entries.slice(0, kept).map((entry) => entry.sourceEntry.id),
  );
  return {
    id: source_ids.at(-1)!,
    current(changed: string) {
      const current = ctx.sessionManager.getBranch();
      if (current.length > MAX_BRANCH_ENTRIES)
        throw new Error("Compaction branch exceeds 200000 entries");
      if (
        ctx.sessionManager.getSessionId() !== session_id ||
        current.length < source_ids.length ||
        source_ids.some((id, index) => current[index].id !== id) ||
        current
          .slice(source_ids.length)
          .some(
            (entry) =>
              entry.type === "compaction" ||
              (entry.type === "context_edit" &&
                summarized_ids.has(entry.targetId)),
          )
      )
        throw new Error(changed);
      return current;
    },
  };
}
