import type { JSX } from "solid-js";
import { createMemo, For } from "solid-js";
import * as S from "../store";
import { theme } from "../theme";
import { C, uidSpans } from "../uid";
import { relativeTime } from "../format";
import { listProjects } from "../../core/db";

// The landing view (Basecamp: the project page is the root). Lists projects —
// name, id, age, description — with a guided empty state. j/k select, enter
// opens, n creates. The whole list re-reads after a write via the rev signal.
export function ProjectListView(): JSX.Element {
  const projects = createMemo(() => {
    S.rev();
    return listProjects();
  });
  const ids = () => projects().map((p) => p.id);
  const selIdx = () => Math.min(S.selProject(), Math.max(0, projects().length - 1));
  return (
    <box flexDirection="column" flexGrow={1}>
      <text><C fg={theme.header}>Projects</C></text>
      {projects().length === 0 ? (
        <text>
          <C fg={theme.muted}>  No projects yet — press </C>
          <C fg={theme.uid}>n</C>
          <C fg={theme.muted}> to create one.</C>
        </text>
      ) : null}
      <box flexDirection="column" marginTop={1} flexGrow={1}>
        <For each={projects()}>
          {(p, i) => (
            <box flexDirection="row" gap={1}>
              <text>{i() === selIdx() ? <C fg={theme.accent}>▸</C> : <C fg={theme.muted}> </C>}</text>
              <text fg={i() === selIdx() ? theme.accent : theme.text}>{p.name}</text>
              <text>{uidSpans(p.id, ids())}</text>
              <text><C fg={theme.muted}>{relativeTime(p.updated_at)}</C></text>
              {p.description ? <text><C fg={theme.muted}> {p.description}</C></text> : null}
            </box>
          )}
        </For>
      </box>
    </box>
  );
}
