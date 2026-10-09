import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { checkpointFromEntry } from "./compaction-checkpoint.ts";
import { loadText, render, textPath } from "./text.ts";

export const COMPACTION_FEEDBACK = "cpi-compaction-feedback";

type VisibleMessage = {
  customType: string;
  timestamp: number;
  content: unknown;
};
type Feedback = { checkpointId: string; text: string };
type FeedbackText = { feedback: { restored: string; none: string } };

function messageKey(message: VisibleMessage): string {
  return JSON.stringify([
    message.customType,
    message.timestamp,
    message.content,
  ]);
}

function compactionView(pi: ExtensionAPI) {
  let manager: ExtensionContext["sessionManager"] | undefined;
  let leaf: string | null | undefined;
  let current: { id?: string; hidden: Set<string> } = { hidden: new Set() };
  pi.on("session_start", (_event, ctx) => {
    manager = ctx.sessionManager;
    leaf = undefined;
    current = { hidden: new Set() };
  });
  return () => {
    if (!manager || manager.getLeafId() === leaf) return current;
    leaf = manager.getLeafId();
    current = { hidden: new Set() };
    const branch = manager.getBranch();
    let index = branch.length - 1;
    while (index >= 0 && branch[index].type !== "compaction") index--;
    const entry = branch[index];
    if (!entry || entry.type !== "compaction" || !checkpointFromEntry(entry))
      return current;
    current.id = entry.id;
    const start = branch.findIndex(
      (item) => item.id === entry.firstKeptEntryId,
    );
    if (start < 0) return current;
    for (let i = start; i < index; i++) {
      const item = branch[i];
      if (
        item.type !== "custom_message" ||
        (item.customType !== "notification" &&
          item.customType !== "cwd-reminder")
      )
        continue;
      current.hidden.add(
        messageKey({ ...item, timestamp: new Date(item.timestamp).getTime() }),
      );
    }
    return current;
  };
}

export function compactedNotificationFilter(pi: ExtensionAPI) {
  const view = compactionView(pi);
  return (message: VisibleMessage) =>
    view().hidden.has(messageKey(message)) ? new Container() : undefined;
}

export function registerCompactionDisplay(pi: ExtensionAPI): void {
  const view = compactionView(pi);
  pi.registerEntryRenderer<Feedback>(
    COMPACTION_FEEDBACK,
    (entry, _options, theme) => {
      if (!entry.data || entry.data.checkpointId !== view().id)
        return undefined;
      return new Text(theme.fg("muted", entry.data.text), 0, 0);
    },
  );
  pi.on("session_compact", (event, ctx) => {
    const checkpoint = checkpointFromEntry(event.compactionEntry);
    if (!checkpoint) return;
    const text = loadText<FeedbackText>(
      "compaction",
      textPath("compaction"),
    ).feedback;
    const projects = checkpoint.documents
      .filter((document) => document.kind === "project")
      .map((document) => document.path);
    const feedback = render(text.restored, {
      cwd: checkpoint.state.cwd,
      projects: projects.join(", ") || text.none,
      warnings: checkpoint.warnings.join("\n"),
    });
    pi.appendEntry<Feedback>(COMPACTION_FEEDBACK, {
      checkpointId: event.compactionEntry.id,
      text: feedback,
    });
    if (ctx.mode === "rpc")
      ctx.ui.notify(feedback, checkpoint.warnings.length ? "warning" : "info");
  });
}
