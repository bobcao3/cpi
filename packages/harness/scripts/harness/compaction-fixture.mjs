import assert from "node:assert/strict";
import { join } from "node:path";
import { localFixture } from "../local-fixture.mjs";

export async function compactionFixture(skillMarker, projectMarker) {
  let fixture;
  let summaries = 0;
  fixture = await localFixture(
    (body) => {
      const text = JSON.stringify(body.messages);
      if (!body.tools?.length) {
        summaries++;
        return {
          content: JSON.stringify({
            summary:
              "## Goal\nPreserve TASK_FACT_AMBER_9137.\n## Progress\nAfter set_cwd, reread checkpoint-live and report the skill and project verification markers.\n## Next Steps\nReload checkpoint-live before answering.",
            relevant_skills: ["checkpoint-live"],
          }),
        };
      }
      if (text.includes("The integration task is complete"))
        return { content: "READY" };
      if (summaries) {
        assert.ok(
          text.includes(projectMarker),
          "Continuing model request lost project instructions",
        );
        if (!text.includes(skillMarker))
          return {
            tools: [
              {
                name: "read",
                args: { path: join(fixture.directory, "skill", "SKILL.md") },
              },
            ],
          };
        return { content: `${skillMarker} ${projectMarker}` };
      }
      if (text.includes("Call set_cwd with path"))
        return {
          tools: [
            {
              name: "set_cwd",
              args: { path: join(fixture.directory, "target") },
            },
          ],
          inputTokens: 20000,
        };
      if (!body.messages.some((message) => message.role === "tool"))
        return {
          tools: [
            {
              name: "read",
              args: { path: join(fixture.directory, "skill", "SKILL.md") },
            },
          ],
          inputTokens: 20000,
        };
      return { content: "READY", inputTokens: 20000 };
    },
    { contextWindow: 32768 },
  );
  return fixture;
}
