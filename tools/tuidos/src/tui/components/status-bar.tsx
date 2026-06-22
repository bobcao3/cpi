import type { JSX } from "solid-js";
import { createMemo, For } from "solid-js";
import * as S from "../store";
import { KEYMAP } from "../keys";
import { theme } from "../theme";
import { C } from "../uid";
import { listAllProjects } from "../../core/db";

// Footer: left = the active view's key hints (the same keys that work, per
// keys.ts KEYMAP — one source of truth), right = the current context (the
// project name, or "tuidos" at the project list). Opinionated and guided: the
// user always sees what they can do right now.
export function StatusBar(): JSX.Element {
  const hints = createMemo(() => KEYMAP[S.view()].filter((d) => !d.hidden && d.label));
  const ctx = createMemo(() => {
    S.rev();
    const pid = S.projectId();
    if (!pid) return "tuidos";
    return listAllProjects().find((p) => p.id === pid)?.name ?? "tuidos";
  });
  return (
    <box border={["top"]} borderStyle="single" borderColor={theme.border} flexDirection="row" justifyContent="space-between" paddingX={1}>
      <text>
        <For each={hints()}>
          {(d, i) => (
            <>
              <C fg={theme.uid}>{d.keys[0] ?? ""}</C>
              <C fg={theme.muted}> {d.label}</C>
              {i() < hints().length - 1 ? "  " : ""}
            </>
          )}
        </For>
      </text>
      <text><C fg={theme.muted}>{ctx()}</C></text>
    </box>
  );
}
