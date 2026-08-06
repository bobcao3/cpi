import { listAllProjects } from "../core/db";
import { listColumns } from "../core/columns";
import { getTask } from "../core/tasks";

const stage = process.argv[2];
const cardId = process.argv[3];
const VALID = ["PRD", "Outline", "Implement", "Validate"];
if (!VALID.includes(stage ?? "") || !cardId) {
  console.error(
    "usage: worker-prompt.ts <PRD|Outline|Implement|Validate> <card-id>",
  );
  process.exit(2);
}
const st = stage as "PRD" | "Outline" | "Implement" | "Validate";

const project = listAllProjects().find((p) => p.name === "tuidos");
const pid = project?.id ?? "tuidos";
const col = (name: string) =>
  listColumns(pid).find((c) => c.name === name)?.name ?? name;
const task = getTask(pid, cardId);
const titleHint = task ? `\n# Card title: ${task.title}` : "";

const next = {
  PRD: "Outline",
  Outline: "Implement",
  Implement: "Validate",
  Validate: "Done",
}[st]!;
const nextCol = col(next);
const implementCol = col("Implement");

const STAGE_BODY: Record<string, string> = {
  PRD: `YOU ARE THE PRODUCT-RESEARCH AGENT. Your job is to SPEC the card, not to build it.
1. Read the card (clidos task show ${cardId}) — its title/description is the seed.
2. Research how comparable products handle this (Linear, Basecamp, taskwarrior, dstask, git/jj, etc.) — use web search. A short description is a research prompt, not a blocker.
3. Write a SHORT PRD: the problem, who it's for, the approach, the scope, the non-goals, and the open questions. Keep it tight (the description column is capped at 1024 chars).
4. Put the PRD in the card's DESCRIPTION so the next stages read it as the spec:
     bun run src/clidos/index.ts -p ${pid} task edit ${cardId} -d "<short PRD>"
   If it needs more room, put the full PRD in a thread message and a summary in the description.
5. Post your research findings to the thread. Do NOT write any code.
6. Move the card to the next stage and post a handoff:
     bun run src/clidos/index.ts -p ${pid} task move ${cardId} ${nextCol}
     bun run src/clidos/index.ts -p ${pid} task message add ${cardId} "PRD done -> ${nextCol}"`,

  Outline: `YOU ARE THE TECHNICAL-OUTLINE AGENT. Your job is to PLAN the build, not to build it.
1. Read the card: the PRD is in its description; prior progress is in its thread (clidos task show ${cardId}).
2. Outline the implementation: files to touch, new functions/types, any data-model change (justify it), risks/trade-offs, and a concrete verification plan (which tsc/test commands, what a real run looks like). Follow AGENTS.md (TigerStyle; no file > 397 lines; simplest architecture).
3. Post the outline to the thread. Do NOT write code yet.
4. Move the card to the next stage and post a handoff:
     bun run src/clidos/index.ts -p ${pid} task move ${cardId} ${nextCol}
     bun run src/clidos/index.ts -p ${pid} task message add ${cardId} "Outline done -> ${nextCol}"`,

  Implement: `YOU ARE THE IMPLEMENTATION AGENT. Build it per the PRD + outline; do NOT do final validation.
1. Read the card: PRD (description) + outline (thread) — clidos task show ${cardId}. Read the relevant existing code first.
2. Implement, following AGENTS.md (TigerStyle: bound everything, assert invariants, simplest architecture; no source file > 397 lines). Keep changes within this card's scope.
3. You MAY run tsc/tests as you go to catch your own errors, but final validation is the NEXT stage's job — do not declare the card Done.
4. Post progress to the thread (what you changed, files touched).
5. Move the card to validation and post a handoff:
     bun run src/clidos/index.ts -p ${pid} task move ${cardId} ${nextCol}
     bun run src/clidos/index.ts -p ${pid} task message add ${cardId} "Implementation done -> ${nextCol}"`,

  Validate: `YOU ARE THE VALIDATION AGENT. Independently verify the implementation — do NOT trust the implementer's claims, and do NOT fix it yourself (separation of duties).
1. Read the card (clidos task show ${cardId}) to see what was built.
2. Re-run everything yourself: bunx tsc --noEmit, and bun test (and a real run if the card implies one). Read the actual output; don't assume.
3. If GREEN: complete and move to Done, and post the final result.
     bun run src/clidos/index.ts -p ${pid} task done ${cardId}
     bun run src/clidos/index.ts -p ${pid} task move ${cardId} ${nextCol}
     bun run src/clidos/index.ts -p ${pid} task message add ${cardId} "Validated -> Done: tsc clean, tests pass"
4. If RED: do NOT fix it. Post the EXACT failures, then send the card back to be re-implemented:
     bun run src/clidos/index.ts -p ${pid} task move ${cardId} ${implementCol}
     bun run src/clidos/index.ts -p ${pid} task message add ${cardId} "Validation FAILED -> ${implementCol}: <exact failures here>"
   The loop (Implement -> Validate) repeats until green.`,
};

const prompt = `You are a tuidos ${stage} stage agent. Do your stage's job on exactly ONE card, then stop.

CONTEXT
- Repo: /home/bob/cpi/tools/tuidos — local-first task tracker. CLI: \`clidos\`; TUI: \`tuidos\`. Data model in \`src/core\`. Read \`AGENTS.md\` and \`DESIGN.md\` before changing code.
- The board IS the pipeline: Backlog -> PRD -> Outline -> Implement -> Validate -> Done. Your card is in the ${stage} stage. Your job advances it to ${next}.${titleHint}

${STAGE_BODY[st]}

HARD RULES (all stages)
- Touch ONLY your card and the code it requires. Do NOT create, edit, move, or archive OTHER cards. Do NOT change board structure (columns/topics). Do NOT run the TUI (\`bun dev\`/\`bun run tui\`) — no interactive TTY. One level deep: do NOT spawn your own subagents.
- Do NOT park a card as "unclear". A short spec is a research prompt — research comparable products, pick the most sensible interpretation, do your stage's job, and record your reasoning in the thread. Only stop (card left in place + a message with a concrete remedy) if a hard external dependency is genuinely unsatisfiable.
- Stay in your lane: do not do another stage's job (PRD/Outline don't code; Implement doesn't do final validation; Validate doesn't fix).
- Stop once your stage is done and the card is moved. Do not wait for further input.`;

console.log(prompt);
