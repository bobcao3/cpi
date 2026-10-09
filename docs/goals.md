# Goals

`/goal <objective>` sets a persistent objective the agent keeps working toward
across turns until an evaluator confirms it is met. `/goal` alone prints status;
`/goal pause`, `/goal resume`, and `/goal clear` manage the loop. Achievements
and budget pauses are announced in the transcript.

Budgets end a goal instead of letting it run forever: turn and time caps pause
the loop with a reason and a resume hint. Evaluation happens between turns and
never starts a new turn by itself.

Behavior, budgets, and model-facing text live in
[`goal.toml`](../packages/harness/src/text/goal.toml) and
[`goal.ts`](../packages/harness/src/lib/goal.ts); do not restate
their values here.
