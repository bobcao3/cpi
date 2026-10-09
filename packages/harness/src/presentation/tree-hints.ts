import type { Theme } from "@earendil-works/pi-coding-agent";

export function treeBodyHint(
  theme: Theme,
  expanded: boolean,
  keyboardToggle: boolean,
  large: boolean,
): string {
  const key = expanded && large ? "Ctrl-Minus" : keyboardToggle ? "Ctrl-O" : "";
  return theme.fg(
    "muted",
    `${expanded ? "[-]" : "..."} ${theme.italic("Click")}${key ? ` or ${key}` : ""} to ${expanded ? "collapse" : "expand"}`,
  );
}
