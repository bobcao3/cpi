# Activity browser

Use `/activity` to open the activity browser for this session. Footer activity
counters open the same view, and `sh_background_ps` lists shells and repeat
monitors without opening the browser. Browsing does not stop work or change
running work; lifecycle semantics are in [background work](background-work.md).

A quiet log is not proof that a job is stuck. Detached shells are untracked, not
completed. Recursive subagent totals must not be double-counted.

Behavior lives in
[`activity-panel.ts`](../packages/extensions/extensions/lib/activity-panel.ts)
and [`activity-ui.ts`](../packages/extensions/extensions/lib/activity-ui.ts);
ordering and retention live in
[`activity.ts`](../packages/extensions/extensions/lib/activity.ts).
