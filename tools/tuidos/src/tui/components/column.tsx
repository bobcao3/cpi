import type { JSX } from "solid-js";
import { For } from "solid-js";
import type { ColumnRow } from "../../core/columns";
import type { TaskRow } from "../../core/tasks";
import { theme } from "../theme";
import { C } from "../uid";
import { CardWidget } from "./card";

// One column (a "phase" in Basecamp terms): a header with name + live count,
// then its cards stacked. The selected column earns the accent border; the
// rest stay dim so the eye lands on the active column. Columns grow to share
// the board width and shrink when cramped.
export function ColumnWidget(props: {
  column: ColumnRow;
  tasks: TaskRow[];
  selectedCol: boolean;
  selectedTask: number;
}): JSX.Element {
  const sel = () => props.selectedCol;
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      border
      borderStyle="rounded"
      borderColor={sel() ? theme.selBorder : theme.border}
      padding={1}
    >
      <text>
        <C fg={theme.header}>{props.column.name}</C>
        <C fg={theme.muted}> {props.tasks.length}</C>
      </text>
      <box flexDirection="column" marginTop={1} flexGrow={1} gap={0}>
        <For each={props.tasks}>
          {(t, i) => <CardWidget task={t} selected={sel() && i() === props.selectedTask} />}
        </For>
        {props.tasks.length === 0 ? <text><C fg={theme.muted}>  (empty)</C></text> : null}
      </box>
    </box>
  );
}
