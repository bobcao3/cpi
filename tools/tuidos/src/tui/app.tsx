import type { JSX } from "solid-js";
import { onMount, onCleanup } from "solid-js";
import { useKeyboard, useRenderer } from "@opentui/solid";
import * as S from "./store";
import { KEYMAP, matchKey } from "./keys";
import { ProjectListView } from "./views/project-list";
import { BoardView } from "./views/board";
import { CardDetailView } from "./views/card-detail";
import { TopicsView } from "./views/topics";
import { AuditView } from "./views/audit";
import { Prompt } from "./components/prompt";
import { StatusBar } from "./components/status-bar";
import { Toast } from "./components/toast";
import { Help } from "./components/help";
import { startLivePoll } from "./live";

// The root: one keyboard handler, the active view by the store's view signal,
// and overlays (prompt / help) + the toast + status bar. Key dispatch is
// layered: prompt first (it owns the keyboard), then help, then esc (context
// back), then the active view's keymap. The status bar reads the SAME keymap,
// so the hints shown are exactly the keys that work.
export function App(): JSX.Element {
  const renderer = useRenderer();
  onMount(() => S.setDestroyApp(() => renderer.destroy()));
  let stopLive: (() => void) | undefined;
  onMount(() => { stopLive = startLivePoll(); });
  onCleanup(() => stopLive?.());
  useKeyboard((key) => {
    if (S.prompt()) {
      if (key.name === "enter") S.submitPrompt();
      else if (key.name === "escape") S.cancelPrompt();
      return;
    }
    if (S.helpOpen()) {
      if (key.name === "escape" || (key.shift && key.name === "/")) S.toggleHelp();
      return;
    }
    if (key.name === "escape") { S.escape(); return; }
    for (const def of KEYMAP[S.view()]) if (matchKey(key, def)) { def.run(); return; }
  });
  const activeView = (): JSX.Element => {
    switch (S.view()) {
      case "projects": return <ProjectListView />;
      case "board": return <BoardView />;
      case "card": return <CardDetailView />;
      case "topics": return <TopicsView />;
      case "audit": return <AuditView />;
      default: return <ProjectListView />;
    }
  };
  return (
    <box flexDirection="column" height="100%">
      <box flexGrow={1} padding={1} flexDirection="column">
        {() => (S.helpOpen() ? <Help /> : activeView())}
      </box>
      {S.prompt() ? <Prompt /> : null}
      <Toast />
      <StatusBar />
    </box>
  );
}
