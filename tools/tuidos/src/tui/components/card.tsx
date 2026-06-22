import type { JSX } from "solid-js";
import type { TaskRow } from "../../core/tasks";
import { theme } from "../theme";
import { C } from "../uid";
import { priorityLabel } from "../format";

// One card on the board. The selection marker (▸) + accent title is the only
// thing that distinguishes the focused card — importance by emphasis, not by
// a box around every card (Basecamp: the card is an artifact, not a typed
// record). The leading ✓/· marks done. Priority, when set, is a muted !label
// so a glance catches urgency without noise.
export function CardWidget(props: { task: TaskRow; selected: boolean }): JSX.Element {
  const t = () => props.task;
  const done = () => t().completed_at != null;
  const pl = () => priorityLabel(t().priority);
  return (
    <box flexDirection="row" gap={1} width="100%">
      <text>{done() ? <C fg={theme.ok}>✓</C> : <C fg={theme.muted}>·</C>}</text>
      <text fg={props.selected ? theme.accent : theme.text}>
        {props.selected ? "▸ " : "  "}
        {t().title}
        {pl() ? <C fg={theme.warn}> !{pl()}</C> : null}
      </text>
    </box>
  );
}
