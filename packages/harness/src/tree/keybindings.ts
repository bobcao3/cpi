import {
  getKeybindings,
  matchesKey,
  type KeybindingDefinitions,
} from "@earendil-works/pi-tui";

export const TREE_KEYBINDINGS = {
  "tui.tree.up": { defaultKeys: "up" },
  "tui.tree.down": { defaultKeys: "down" },
  "tui.tree.open": { defaultKeys: "right" },
  "tui.tree.close": { defaultKeys: "left" },
  "tui.tree.toggle": { defaultKeys: ["enter", "space"] },
  "tui.tree.cancel": { defaultKeys: ["escape", "ctrl+c"] },
} as const satisfies KeybindingDefinitions;

export function matchesTreeKey(
  data: string,
  action: "up" | "down" | "open" | "close" | "toggle" | "cancel",
): boolean {
  const id = `tui.tree.${action}` as const;
  const configured = getKeybindings().getUserBindings()[id];
  const keys = configured ?? TREE_KEYBINDINGS[id].defaultKeys;
  return (Array.isArray(keys) ? keys : [keys]).some((key) =>
    matchesKey(data, key),
  );
}
