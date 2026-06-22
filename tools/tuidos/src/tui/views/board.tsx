import type { JSX } from "solid-js";
import { createMemo, For } from "solid-js";
import * as S from "../store";
import { theme } from "../theme";
import { C } from "../uid";
import { listColumns } from "../../core/columns";
import { listTasks, type TaskRow } from "../../core/tasks";
import { listAllProjects } from "../../core/db";
import { ColumnWidget } from "../components/column";

// The Card Table: a row of columns, each a stack of cards. This is the main
// surface. Columns share the width; the selected column earns the accent
// border and the selected card the ▸ marker. Selection is clamped to the
// live board so a stale index never points past the end.
interface ColData { column: ReturnType<typeof listColumns>[number]; tasks: TaskRow[] }

export function BoardView(): JSX.Element {
  const pid = S.projectId;
  const name = createMemo(() => {
    S.rev();
    const p = pid();
    if (!p) return "";
    return listAllProjects().find((x) => x.id === p)?.name ?? p;
  });
  const cols = createMemo<ColData[]>(() => {
    S.rev();
    const p = pid();
    if (!p) return [];
    return listColumns(p).map((c) => ({ column: c, tasks: listTasks(p, c.id) }));
  });
  // Active card count: total cards across every column. Derived from cols
  // (which is rev-keyed), so it re-renders exactly when the board does.
  const activeCount = createMemo(() => cols().reduce((n, c) => n + c.tasks.length, 0));
  const ci = () => Math.min(S.selCol(), Math.max(0, cols().length - 1));
  return (
    <box flexDirection="column" flexGrow={1}>
      <text>
        <C fg={theme.header}>{name()}</C>
        <C fg={theme.muted}> — board ({activeCount()})</C>
      </text>
      {cols().length === 0 ? (
        <text>
          <C fg={theme.muted}>  No columns. Add one: </C>
          <C fg={theme.uid}>clidos -p {name()} columns create &lt;name&gt;</C>
        </text>
      ) : null}
      <box flexDirection="row" flexGrow={1} gap={1} marginTop={1}>
        <For each={cols()}>
          {(c, i) => {
            const isSel = () => i() === ci();
            const st = () => (isSel() ? Math.min(S.selTask(), Math.max(0, c.tasks.length - 1)) : -1);
            return (
              <ColumnWidget
                column={c.column}
                tasks={c.tasks}
                selectedCol={isSel()}
                selectedTask={st()}
              />
            );
          }}
        </For>
      </box>
    </box>
  );
}
