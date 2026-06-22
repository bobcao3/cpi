import type { JSX } from "solid-js";
import { onMount } from "solid-js";
import type { InputRenderable } from "@opentui/core";
import * as S from "../store";
import { theme } from "../theme";
import { C } from "../uid";

// A single input surface for every create/rename/edit/add-message action, so
// the app has exactly one place that captures the keyboard. While it is open
// the app's global key handler defers (enter submits, escape cancels); the
// input itself consumes typed characters. Rendered inline (above the status
// bar) rather than as an absolute overlay, so it paints in every renderer.
//
// Focus is deferred one tick past mount: the key that OPENED the prompt (e.g.
// "n") is processed before the input is focused, so it is not echoed into the
// field. Subsequent keys arrive once the input is focused and type normally.
export function Prompt(): JSX.Element {
  let ref: InputRenderable | undefined;
  onMount(() => setTimeout(() => ref?.focus(), 0));
  const p = S.prompt;
  return (
    <box border borderStyle="rounded" borderColor={theme.accent} backgroundColor={theme.panelBg} padding={1}>
      <text><C fg={theme.header}>{p()?.title ?? ""}</C></text>
      <input
        ref={ref}
        value={S.promptValue()}
        onInput={S.setPromptValue}
        onSubmit={() => S.submitPrompt()}
        marginTop={1}
        backgroundColor={theme.inputBg}
        textColor={theme.text}
        placeholderColor={theme.muted}
        placeholder="type and press enter…"
      />
      <text><C fg={theme.muted}>enter submit · esc cancel</C></text>
    </box>
  );
}
