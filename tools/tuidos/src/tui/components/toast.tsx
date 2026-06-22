import type { JSX } from "solid-js";
import * as S from "../store";
import { theme } from "../theme";
import { C } from "../uid";

// A one-line slot above the status bar for action outcomes. No raw dumps: ok
// is green ✓, errors are red ✗, warnings are yellow !. Fixed height so it never
// shifts the layout when it appears/disappears.
export function Toast(): JSX.Element {
  return (
    <box height={1}>
      {S.toast() ? (
        <text>
          {S.toast()!.kind === "error" ? <C fg={theme.error}>✗</C> : S.toast()!.kind === "warn" ? <C fg={theme.warn}>!</C> : <C fg={theme.ok}>✓</C>}
          <C fg={S.toast()!.kind === "error" ? theme.error : S.toast()!.kind === "warn" ? theme.warn : theme.text}> {S.toast()!.msg}</C>
        </text>
      ) : null}
    </box>
  );
}
