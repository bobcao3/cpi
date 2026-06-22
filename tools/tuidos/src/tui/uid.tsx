import type { JSX } from "solid-js";
import type { SpanProps } from "@opentui/solid";
import { shortId } from "../core/id";
import { theme } from "./theme";

// OpenTUI's <span> accepts `fg`/`bg` at runtime — its own docs render
// `<span fg="red">red</span>` inline — but the shipped SpanProps type omits
// them (its options are `{}`). `C` (colored span) centralizes that one untyped
// prop behind a clean signature, so the cast lives in exactly one place and
// every call site stays typed. MUST be used inside a <text>: <span> is a text
// modifier, not a standalone element.
export function C(props: { fg: string; children: JSX.Element }): JSX.Element {
  const spanProps = { fg: props.fg } as unknown as SpanProps;
  return <span {...spanProps}>{props.children}</span>;
}

// The single id display for the TUI. Given an id and the live id set, render
// the minimal unique prefix (>=6-char display, expanding to uniqueness, full
// id as fallback) in magenta and the rest dim. This is the follow-through of
// the done "shared uid module" card: every id display routes through here, so
// no call site passes a degenerate single-id list and the prefix is never
// ambiguous. `all` is the live set in scope; if `id` is not yet in it (e.g.
// right after a create) it is counted too.
export function uidSpans(id: string, all: string[]): JSX.Element {
  const set = all.includes(id) ? all : [...all, id];
  const prefix = shortId(id, set, 1, id.length);
  const display = id.slice(0, Math.max(prefix.length, 6));
  const rest = display.slice(prefix.length);
  return (
    <>
      <C fg={theme.uid}>{prefix}</C>
      {rest ? <C fg={theme.muted}>{rest}</C> : null}
    </>
  );
}
