# Activity browser

Use `/activity` to inspect this session's background shells, repeat monitors,
and subagents. Browsing does not stop the agent or change running work.

## Open from the footer

Press **Down** at the bottom of the prompt to focus an activity counter. Use
**Left/Right** to choose `bg`, `mon`, or `sub`, then **Enter** to open it.
**Up** or **Esc** returns to the prompt without changing your draft.

In fullscreen mode (`pi --tui-mode fullscreen`), click a counter to open it.
Regular mode leaves mouse handling to the terminal; keyboard access still works.
Active counters are bright. Zero counts stay muted while recent history exists.

## Browse and expand

- **Left/Right** or **Tab** switches between All, Shell, Monitor, and Agent.
- **Up/Down**, **PageUp/PageDown**, **Home/End** selects an entry.
- **Enter**, **Space**, or a row click cycles through summary, full details, and
  collapsed views.
- The summary shows key metrics inline, the log path, and a short log tail.
- Full details add the command, directory, timestamps, IDs, and other metrics.
- **Ctrl+Up/Down** or the mouse wheel scrolls expanded details.
- **Esc** closes the browser and returns to your prompt.

Live work comes first, oldest first. Finished entries follow, newest first. The
panel refreshes once a second. A quiet log does not mean a job is stuck.

## History and limits

Recent history is kept in memory across extension reloads, not pi restarts. Up
to 256 finished entries and 256 live observations are retained per process;
entries are filtered to the current session. Logs can disappear independently.
Detached shells are marked untracked, not completed.

Subagent entries cover workers observed by the current pi process. Nested
helpers inside another worker are not separate root-browser entries. Metrics are
shown when available; subtree totals must not be summed with child totals.
