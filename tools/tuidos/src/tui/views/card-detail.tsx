import type { JSX, Accessor } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import * as S from "../store";
import { theme } from "../theme";
import { C, uidSpans } from "../uid";
import { relativeTime, priorityLabel, dueDate, humanSize } from "../format";
import { getTask, listAllTaskIds, type TaskRow } from "../../core/tasks";
import { listColumns } from "../../core/columns";
import { listMessages } from "../../core/messages";
import { listMediaForTask } from "../../core/media";
import { listTopicsForTask } from "../../core/topics";

// The conversation-centric card page: title + meta, an optional summary, then
// the thread (body first, replies) in a scrollable area, then media. The
// scrollbox stays mounted across writes (non-keyed Show with a fallback, so
// the false branch is a valid empty <text> rather than an orphan anchor) —
// adding a message does not reset scroll position. m adds a message, t tags,
// d toggles done, x archives, esc returns to the board.
export function CardDetailView(): JSX.Element {
  const pid = S.projectId;
  const cid = S.cardId;
  const task = createMemo(() => {
    S.rev();
    const p = pid(); const c = cid();
    return p && c ? getTask(p, c) : null;
  });
  const colName = createMemo(() => {
    S.rev();
    const p = pid(); const c = cid();
    if (!p || !c) return "";
    const t = getTask(p, c);
    return t ? (listColumns(p).find((x) => x.id === t.column_id)?.name ?? "?") : "";
  });
  const messages = createMemo(() => {
    S.rev();
    const p = pid(); const c = cid();
    return p && c ? listMessages(p, c) : [];
  });
  const media = createMemo(() => {
    S.rev();
    const p = pid(); const c = cid();
    return p && c ? listMediaForTask(p, c) : [];
  });
  const topics = createMemo(() => {
    S.rev();
    const p = pid(); const c = cid();
    return p && c ? listTopicsForTask(p, c) : [];
  });
  const ids = createMemo(() => {
    S.rev();
    const p = pid();
    return p ? listAllTaskIds(p) : [];
  });
  return (
    <Show when={task()} fallback={<text></text>}>
      {(t: Accessor<TaskRow>) => (
        <box flexDirection="column" flexGrow={1}>
          <text><C fg={theme.header}>{t().title}</C></text>
          <text>
            <C fg={theme.muted}>id </C>
            {uidSpans(t().id, ids())}
            <C fg={theme.muted}> · column </C>
            <C fg={theme.accent}>{colName()}</C>
          </text>
          {topics().length > 0 ? (
            <text>
              <C fg={theme.muted}>topics </C>
              {topics().map((x) => <C fg={theme.accent}>{x.name} </C>)}
            </text>
          ) : null}
          <text>
            {t().completed_at != null ? <C fg={theme.ok}>✓ done</C> : null}
            {priorityLabel(t().priority) ? <C fg={theme.warn}> · !{priorityLabel(t().priority)}</C> : null}
            {t().assignee ? <C fg={theme.muted}> · @{t().assignee}</C> : null}
            {dueDate(t().due_at) ? <C fg={theme.muted}> · due {dueDate(t().due_at)}</C> : null}
          </text>
          {t().description ? <text><C fg={theme.text}>{t().description}</C></text> : null}
          <text marginTop={1}><C fg={theme.header}>Thread</C></text>
          <scrollbox flexGrow={1} focused border borderStyle="single" borderColor={theme.border} marginTop={1}>
            <For each={messages()}>
              {(m, i) => (
                <box flexDirection="column" marginBottom={1}>
                  <text>
                    <C fg={i() === 0 ? theme.accent : theme.muted}>{i() === 0 ? "body" : "reply"}</C>
                    <C fg={theme.muted}> {m.author ?? "anon"} · {relativeTime(m.created_at)}</C>
                  </text>
                  <text>{m.content}</text>
                </box>
              )}
            </For>
            {messages().length === 0 ? <text><C fg={theme.muted}>  (no messages — press m to add one)</C></text> : null}
          </scrollbox>
          {media().length > 0 ? (
            <>
              <text marginTop={1}><C fg={theme.header}>Media</C></text>
              <For each={media()}>
                {(m) => (
                  <text>
                    <C fg={theme.accent}>{m.filename}</C>
                    <C fg={theme.muted}> {humanSize(m.size_bytes)}</C>
                  </text>
                )}
              </For>
            </>
          ) : null}
        </box>
      )}
    </Show>
  );
}
