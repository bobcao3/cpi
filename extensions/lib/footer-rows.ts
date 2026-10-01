import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  HStack,
  MouseRegion,
  Text,
  TruncatedText,
  VStack,
  mixColors,
  rgbColor,
  visibleWidth,
  type Component,
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
const priorities = ["branch", "fast", "usage", "shell", "subagent-cost"];
const priority = (name: string) =>
  name === "jj"
    ? 0
    : name === "summary"
      ? 6
      : priorities.includes(name)
        ? priorities.indexOf(name)
        : 5;
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
  thinking_level: ReturnType<ExtensionAPI["getThinkingLevel"]>,
  selected?: ActivityKind,
  open?: (kind: ActivityKind) => void,
): { component: VStack; hits: FooterHit[] } {
  if (!Number.isInteger(width) || width < 1)
    throw new Error("Footer width must be a positive integer");
  const sections = [...input].sort(
    (a, b) => priority(a.name.toLowerCase()) - priority(b.name.toLowerCase()),
  );
  const hits: FooterHit[] = [];
  const rows: HStack[] = [];
  let entries: StackEntry[] = [];
  let column = 0;
  const finish = () => {
    rows.push(new HStack(entries, { gap: 0 }));
    entries = [];
    column = 0;
  };
  const field = (
    text: string,
    background: (line: string) => string,
  ): Component => {
    const box = new Box(0, 0, background);
    box.addChild(new TruncatedText(text, 0, 0));
    return box;
  };
  const separator_color = mixColors(
    theme.colors.customMessageBg,
    rgbColor(0, 0, 0),
    0.45,
    "srgb",
  );
  for (const section of sections) {
    const section_tokens = tokens(section);
    const section_selected = section_tokens.some(
      (token) => token.kind === selected,
    );
    const background = (line: string) =>
      theme.bg(section_selected ? "selectedBg" : "customMessageBg", line);
    const basis = Math.min(width, visibleWidth(section.value) + 2);
    const summary = section.name.toLowerCase() === "summary";
    if (entries.length && column + 1 + basis > width) finish();
    if (entries.length) {
      const separator = summary
        ? new TruncatedText(" ", 0, 0)
        : field(" ", (line) => theme.style(line, { bg: separator_color }));
      entries.push({ component: separator, basis: 1, shrink: 0 });
      column += 1;
    }
    const parts: StackEntry[] = [];
    const append = (component: Component, size: number) => {
      if (size) parts.push({ component, basis: size, shrink: 0 });
    };
    if (!summary) {
      append(field(" ", background), 1);
      let position = 0;
      for (const token of section_tokens) {
        const before = section.value.slice(position, token.index);
        append(
          field(theme.fg("muted", before), background),
          visibleWidth(before),
        );
        const text =
          selected === token.kind
            ? theme.bold(theme.fg("accent", token.text))
            : theme.fg(token.active ? "success" : "muted", token.text);
        const region = new MouseRegion(field(text, background), (event) => {
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
          hits.push({ kind: token.kind, row: rows.length, start, end, region });
        append(region, visibleWidth(token.text));
        position = token.index + token.text.length;
      }
      const after = section.value.slice(position);
      append(field(theme.fg("muted", after), background), visibleWidth(after));
      append(field(" ", background), 1);
    }
    entries.push({
      component: summary
        ? new Text(
            theme.getThinkingBorderColor(thinking_level)(section.value),
            1,
            0,
          )
        : new HStack(parts, { gap: 0 }),
      basis,
      shrink: 0,
    });
    column += basis;
  }
  if (entries.length) finish();
  return { component: new VStack(rows), hits };
}
