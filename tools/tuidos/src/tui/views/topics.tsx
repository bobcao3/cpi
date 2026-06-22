import type { JSX } from "solid-js";
import { createMemo, For } from "solid-js";
import * as S from "../store";
import { theme } from "../theme";
import { C, uidSpans } from "../uid";
import { listTopics, listTopicsForTask } from "../../core/topics";

// Topics doubles as the card tag-picker when a card is open: rows show ✓ for
// attached topics and enter toggles. With no card open it is plain CRUD
// (n/r/x). One surface, two modes — the card's id in the store decides which.
export function TopicsView(): JSX.Element {
  const pid = S.projectId;
  const cid = S.cardId;
  const topics = createMemo(() => {
    S.rev();
    const p = pid();
    return p ? listTopics(p) : [];
  });
  const attached = createMemo<Set<string>>(() => {
    S.rev();
    const p = pid(); const c = cid();
    if (!p || !c) return new Set();
    return new Set(listTopicsForTask(p, c).map((t) => t.id));
  });
  const tagMode = () => cid() != null;
  const ids = () => topics().map((t) => t.id);
  const selIdx = () => Math.min(S.selTopic(), Math.max(0, topics().length - 1));
  return (
    <box flexDirection="column" flexGrow={1}>
      <text><C fg={theme.header}>{tagMode() ? "Tag card" : "Topics"}</C></text>
      {tagMode() ? <text><C fg={theme.muted}>  enter toggles a tag · esc back to the card</C></text> : null}
      <box flexDirection="column" marginTop={1} flexGrow={1}>
        <For each={topics()}>
          {(t, i) => (
            <text>
              {i() === selIdx() ? <C fg={theme.accent}>▸</C> : <C fg={theme.muted}> </C>}
              <C fg={theme.muted}> </C>
              {tagMode() ? (attached().has(t.id) ? <C fg={theme.ok}>✓</C> : <C fg={theme.muted}>·</C>) : null}
              <C fg={theme.muted}> </C>
              <C fg={i() === selIdx() ? theme.accent : theme.text}>{t.name}</C>
              {uidSpans(t.id, ids())}
            </text>
          )}
        </For>
        {topics().length === 0 ? <text><C fg={theme.muted}>  (no topics — press n to create one)</C></text> : null}
      </box>
    </box>
  );
}
