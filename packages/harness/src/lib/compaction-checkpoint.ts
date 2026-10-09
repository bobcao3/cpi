import type {
  CompactionEntry,
  ContextEvent,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type {
  ReferenceBundle,
  ReferenceDocument,
} from "./compaction-references.ts";
import { stripReferenceBodies } from "./compaction-references.ts";
import type { RuntimeSnapshot } from "./compaction-state.ts";
import { loadText, render, textPath } from "./text.ts";

export const CHECKPOINT_TYPE = "cpi-context-checkpoint";
export const CHECKPOINT_VERSION = 1;
const MAX_CHECKPOINT_BYTES = 768 * 1024;
type AgentMessage = ContextEvent["messages"][number];

export interface ContextCheckpoint extends Omit<ReferenceBundle, "documents"> {
  version: typeof CHECKPOINT_VERSION;
  documents: Omit<ReferenceDocument, "content">[];
  state: RuntimeSnapshot;
  content: string;
}

interface CheckpointText {
  restore: { block: string; document: string; warning: string };
}

export function buildCheckpoint(
  references: ReferenceBundle,
  state: RuntimeSnapshot,
): ContextCheckpoint {
  const text = loadText<CheckpointText>("compaction", textPath("compaction"));
  const documents = references.documents.map((document) =>
    render(text.restore.document, { ...document }),
  );
  const warnings = references.warnings.map((warning) =>
    render(text.restore.warning, { warning }),
  );
  const content = render(text.restore.block, {
    state: JSON.stringify(state, null, 2),
    documents: documents.join("\n\n"),
    warnings: warnings.join("\n"),
  });
  if (Buffer.byteLength(content) > MAX_CHECKPOINT_BYTES)
    throw new Error("Compaction checkpoint exceeds 768 KiB");
  const manifest = references.documents.map(
    ({ content: _content, ...document }) => document,
  );
  return {
    version: CHECKPOINT_VERSION,
    documents: manifest,
    warnings: references.warnings,
    state,
    content,
  };
}

export function checkpointFromEntry(
  entry: SessionEntry,
): ContextCheckpoint | undefined {
  if (entry.type !== "compaction") return undefined;
  const checkpoint = (
    entry.details as { cpiContext?: ContextCheckpoint } | undefined
  )?.cpiContext;
  if (
    checkpoint?.version !== CHECKPOINT_VERSION ||
    typeof checkpoint.content !== "string" ||
    !Array.isArray(checkpoint.documents) ||
    !Array.isArray(checkpoint.warnings) ||
    !checkpoint.state ||
    typeof checkpoint.state.cwd !== "string"
  )
    return undefined;
  if (
    Buffer.byteLength(checkpoint.content) > MAX_CHECKPOINT_BYTES ||
    checkpoint.documents.length > 64
  )
    return undefined;
  return checkpoint;
}

function messageKey(message: AgentMessage): string {
  const value = message as AgentMessage & {
    toolCallId?: string;
    customType?: string;
  };
  return JSON.stringify([
    value.role,
    value.timestamp,
    value.toolCallId,
    value.customType,
  ]);
}

export function projectCheckpoint(
  messages: AgentMessage[],
  ctx: ExtensionContext,
): AgentMessage[] {
  const branch = ctx.sessionManager.getBranch();
  let index = branch.length - 1;
  while (index >= 0 && branch[index].type !== "compaction") index--;
  if (index < 0) return messages;
  const entry = branch[index] as CompactionEntry;
  const checkpoint = checkpointFromEntry(entry);
  if (!checkpoint) return messages;
  const timestamp = new Date(entry.timestamp).getTime();
  const base = messages.filter(
    (message) =>
      message.role !== "custom" || message.customType !== CHECKPOINT_TYPE,
  );
  const summary = base.findIndex(
    (message) =>
      message.role === "compactionSummary" && message.timestamp === timestamp,
  );
  if (summary < 0) return messages;
  const kept_start = branch.findIndex(
    (item) => item.id === entry.firstKeptEntryId,
  );
  if (kept_start < 0 || kept_start > index) return messages;
  const kept_keys = new Set(
    branch
      .slice(kept_start, index)
      .flatMap(sessionEntryToContextMessages)
      .map(messageKey),
  );
  let anchor = summary + 1;
  for (let i = summary + 1; i < base.length; i++) {
    if (kept_keys.has(messageKey(base[i]))) anchor = i + 1;
  }
  const prefix = stripReferenceBodies(
    base.slice(0, anchor),
    checkpoint.documents,
  );
  const restored: AgentMessage = {
    role: "custom",
    customType: CHECKPOINT_TYPE,
    content: checkpoint.content,
    display: false,
    details: {
      checkpointId: entry.id,
      kind: "context-checkpoint",
      model: checkpoint.state.model,
      cwd: checkpoint.state.cwd,
    },
    timestamp,
  };
  return [...prefix, restored, ...base.slice(anchor)];
}
