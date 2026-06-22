import type { JSX } from "solid-js";
import { For } from "solid-js";
import * as S from "../store";
import { KEYMAP } from "../keys";
import { theme } from "../theme";
import { C } from "../uid";

// Lists every key for the active view (including hidden ones like quit), so
// the user can discover the whole keymap. Rendered in the content area (it
// replaces the active view while open) rather than as an overlay, so it paints
// in every renderer. esc or ? closes it (handled in app.tsx before dispatch).
export function Help(): JSX.Element {
  return (
    <box flexDirection="column" flexGrow={1}>
      <text><C fg={theme.header}>Keys — {S.view()}</C></text>
      <box flexDirection="column" marginTop={1}>
        <For each={KEYMAP[S.view()]}>
          {(d) => (
            <text>
              <C fg={theme.uid}>{(d.shift ? "S-" : "") + (d.keys[0] ?? "")}</C>
              <C fg={theme.muted}>  </C>
              <C fg={theme.text}>{d.label}</C>
            </text>
          )}
        </For>
        <text marginTop={1}><C fg={theme.muted}>esc / ? to close</C></text>
      </box>
    </box>
  );
}
