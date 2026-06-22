import type { JSX } from "solid-js";
import { createMemo, For } from "solid-js";
import * as S from "../store";
import { theme } from "../theme";
import { C } from "../uid";
import { relativeTime } from "../format";
import { collectProjectAudit } from "../audit";

// A scrollable newest-first activity log for the open project. Arrows scroll
// (the scrollbox is focused); esc returns to the board. The cross-file merge
// (global lifecycle + this project's log) lives in tui/audit.ts.
export function AuditView(): JSX.Element {
  const rows = createMemo(() => {
    S.rev();
    const p = S.projectId();
    return p ? collectProjectAudit(p, 200) : [];
  });
  return (
    <box flexDirection="column" flexGrow={1}>
      <text>
        <C fg={theme.header}>Activity</C>
        <C fg={theme.muted}> ({rows().length})</C>
      </text>
      <scrollbox flexGrow={1} focused border borderStyle="single" borderColor={theme.border} marginTop={1}>
        <For each={rows()}>
          {(r) => (
            <text>
              <C fg={theme.muted}>{relativeTime(r.ts).padEnd(8)} </C>
              <C fg={theme.accent}>{r.action}</C>
              <C fg={theme.muted}> </C>
              {r.summary}
            </text>
          )}
        </For>
        {rows().length === 0 ? <text><C fg={theme.muted}>  (no activity yet)</C></text> : null}
      </scrollbox>
    </box>
  );
}
