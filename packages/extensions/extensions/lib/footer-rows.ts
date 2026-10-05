import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  HStack,
  MouseRegion,
  TruncatedText,
  VStack,
  visibleWidth,
  type StackEntry,
} from "@earendil-works/pi-tui";
import type { ActivityKind } from "./activity.ts";

export interface FooterSection {
  name: string;
  value: string;
}
export interface FooterHit {
  kind: ActivityKind;
  row: number;
  start: number;
  end: number;
  region: MouseRegion;
}
const priorities = ["shell", "subagent-cost", "fast"];
const priority = (name: string) =>
  priorities.includes(name) ? priorities.indexOf(name) : priorities.length;
function tokens(section: FooterSection) {
  if (section.name === "subagent-cost")
    return [
      {
        kind: "subagent" as const,
        index: 0,
        text: section.value,
        active: /sub:[1-9]/.test(section.value),
      },
    ];
  if (section.name !== "shell") return [];
  return [...section.value.matchAll(/\b(shell|mon):(\d+)\b/g)].map((match) => ({
    kind: match[1] === "shell" ? ("shell" as const) : ("monitor" as const),
    index: match.index!,
    text: match[0],
    active: Number(match[2]) > 0,
  }));
}
export function buildFooterRows(
  width: number,
  theme: Theme,
  input: FooterSection[],
  selected?: ActivityKind,
  open?: (kind: ActivityKind) => void,
): { component: VStack; hits: FooterHit[] } {
  if (!Number.isInteger(width) || width < 1)
    throw new Error("Footer width must be a positive integer");
  const sections = [...input].sort(
    (a, b) => priority(a.name.toLowerCase()) - priority(b.name.toLowerCase()),
  );
  const hits: FooterHit[] = [];
  const entries: StackEntry[] = [];
  let column = 0;
  for (const section of sections) {
    const section_tokens = tokens(section);
    const available = width - column - (entries.length ? 1 : 0);
    if (available < 3) break;
    const basis = Math.min(available, visibleWidth(section.value) + 2);
    if (entries.length) {
      entries.push({
        component: new TruncatedText(" ", 0, 0),
        basis: 1,
        shrink: 0,
      });
      column += 1;
    }
    const parts: StackEntry[] = [];
    const append = (component: TruncatedText | MouseRegion, size: number) => {
      if (size) parts.push({ component, basis: size, shrink: 0 });
    };
    append(new TruncatedText(section_tokens.length ? "[" : " ", 0, 0), 1);
    let position = 0;
    for (const token of section_tokens) {
      const before = section.value.slice(position, token.index);
      append(
        new TruncatedText(theme.fg("muted", before), 0, 0),
        visibleWidth(before),
      );
      const text =
        selected === token.kind
          ? theme.underline(theme.bold(theme.fg("accent", token.text)))
          : theme.fg(token.active ? "success" : "muted", token.text);
      const region = new MouseRegion(new TruncatedText(text, 0, 0), (event) => {
        if (event.button !== "left") return undefined;
        if (event.type === "press") return { handled: true };
        if (event.type !== "click") return undefined;
        open?.(token.kind);
        return { handled: true };
      });
      const start =
        column + 1 + visibleWidth(section.value.slice(0, token.index));
      const end = start + visibleWidth(token.text);
      if (end <= column + basis - 1)
        hits.push({ kind: token.kind, row: 0, start, end, region });
      append(region, visibleWidth(token.text));
      position = token.index + token.text.length;
    }
    const after = section.value.slice(position);
    append(
      new TruncatedText(theme.fg("muted", after), 0, 0),
      visibleWidth(after),
    );
    append(new TruncatedText(section_tokens.length ? "]" : " ", 0, 0), 1);
    entries.push({
      component: new HStack(parts, { gap: 0 }),
      basis,
      shrink: 0,
    });
    column += basis;
  }
  return {
    component: new VStack(
      entries.length ? [new HStack(entries, { gap: 0 })] : [],
    ),
    hits,
  };
}
