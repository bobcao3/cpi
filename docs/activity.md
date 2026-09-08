# Activity browser

Use `/activity` to open the activity browser for this session. Footer activity
counters can also open it. Browsing does not stop work or change running work.

A quiet log is not proof that a job is stuck. Detached shells are untracked, not
completed. Recursive subagent totals must not be double-counted.

For current interaction and rendering behavior, see
[`activity-panel.ts`](../extensions/lib/activity-panel.ts) and
[`activity-ui.ts`](../extensions/lib/activity-ui.ts). For current ordering and
retention semantics, see [`activity.ts`](../extensions/lib/activity.ts).
