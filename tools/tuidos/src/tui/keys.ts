import type { KeyEvent } from "@opentui/core";
import * as S from "./store";
import type { View } from "./store";

// The keyboard map is data: each view lists its keys, and the status bar
// renders the labels from the SAME table (one source of truth — the hints the
// user sees are exactly the keys that work). `keys` is a list of aliases (j +
// down arrow); `shift` means the alias is read with Shift held (so "H" =
// Shift+h). The dispatcher (app.tsx) calls the first matching `run`.

export interface KeyDef {
  keys: string[];
  shift?: boolean;
  label: string;
  hidden?: boolean; // true = works but not shown in the status bar
  run: () => void;
}

export function matchKey(key: KeyEvent, def: KeyDef): boolean {
  if (def.shift) return !!key.shift && def.keys.includes(key.name);
  return !key.shift && !key.ctrl && !key.meta && def.keys.includes(key.name);
}

const help: KeyDef = { keys: ["/"], shift: true, label: "help", run: S.toggleHelp };
const quit: KeyDef = { keys: ["q"], label: "quit", hidden: true, run: S.quit };

export const KEYMAP: Record<View, KeyDef[]> = {
  projects: [
    { keys: ["j", "down"], label: "down", run: S.navProjectDown },
    { keys: ["k", "up"], label: "up", run: S.navProjectUp },
    { keys: ["enter", "return"], label: "open", run: S.openSelectedProject },
    { keys: ["n"], label: "new", run: () => S.openPrompt("New project", "", S.newProject) },
    { keys: ["a"], label: "audit", run: () => S.goto("audit") },
    help, quit,
  ],
  board: [
    { keys: ["j", "down"], label: "down", run: S.navDown },
    { keys: ["k", "up"], label: "up", run: S.navUp },
    { keys: ["h", "left"], label: "prev col", run: S.navLeft },
    { keys: ["l", "right"], label: "next col", run: S.navRight },
    { keys: ["enter", "return"], label: "open card", run: S.openCurrentCard },
    { keys: ["n"], label: "new card", run: () => S.openPrompt("New card", "", S.newCard) },
    { keys: ["h"], shift: true, label: "move ←", run: S.moveCardLeft },
    { keys: ["l"], shift: true, label: "move →", run: S.moveCardRight },
    { keys: ["d"], label: "done", run: S.toggleDone },
    { keys: ["e"], label: "edit", run: S.editCardTitle },
    { keys: ["x"], label: "archive", run: S.archiveCurrentCard },
    { keys: ["u"], label: "restore", run: S.unarchiveLastArchive },
    { keys: ["t"], label: "topics", run: () => S.goto("topics") },
    { keys: ["a"], label: "audit", run: () => S.goto("audit") },
    { keys: ["p"], label: "projects", run: S.backToProjects },
    help, quit,
  ],
  card: [
    { keys: ["m"], label: "message", run: () => S.openPrompt("Add message", "", S.addMessage) },
    { keys: ["t"], label: "tags", run: () => S.goto("topics") },
    { keys: ["d"], label: "done", run: S.toggleDoneCard },
    { keys: ["x"], label: "archive", run: S.archiveCardFromDetail },
    { keys: ["u"], label: "restore", run: S.unarchiveLastArchive },
    help, quit,
  ],
  topics: [
    { keys: ["j", "down"], label: "down", run: S.navTopicDown },
    { keys: ["k", "up"], label: "up", run: S.navTopicUp },
    {
      keys: ["enter", "return"], label: "toggle",
      run: () => S.toggleCurrentTopicOnCard(),
    },
    { keys: ["n"], label: "new", run: () => S.openPrompt("New topic", "", S.newTopic) },
    { keys: ["r"], label: "rename", run: S.renameCurrentTopic },
    { keys: ["x"], label: "archive", run: S.archiveCurrentTopic },
    help, quit,
  ],
  audit: [
    help, quit,
  ],
};
