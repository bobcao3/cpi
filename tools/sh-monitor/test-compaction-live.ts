import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { setCwd } from "../../extensions/lib/cwd.ts";
import { buildCpiSystemPrompt } from "../../extensions/lib/system-prompt-build.ts";
import { COMPACTION_FEEDBACK } from "../../extensions/lib/compaction-display.ts";

const root = mkdtempSync(join(tmpdir(), "cpi-compaction-live-"));
const skill_dir = join(root, "skill");
const project_skill = join(root, ".pi", "skills", "project-skill");
const target = join(root, "target");
mkdirSync(skill_dir);
mkdirSync(project_skill, { recursive: true });
mkdirSync(target);
writeFileSync(
  join(project_skill, "SKILL.md"),
  "---\nname: project-skill\ndescription: Project-only workflow.\n---\nProject workflow.\n",
);
const skill_marker = "REFERENCE_SKILL_COBALT_7391";
const project_marker = "REFERENCE_PROJECT_UMBER_8264";
writeFileSync(
  join(skill_dir, "SKILL.md"),
  `---\nname: checkpoint-live\ndescription: Reference for the compaction integration task.\n---\n${"Reference background, not task history.\n".repeat(90)}\nThe skill verification marker is ${skill_marker}.\n`,
);
writeFileSync(
  join(target, "AGENTS.md"),
  `Project verification marker: ${project_marker}.\nOnly perform the requested integration task.\n`,
);
setCwd(root);
const runtime = await ModelRuntime.create();
const provider = process.env.CPI_LIVE_PROVIDER ?? "meshy-sglang";
const id = process.env.CPI_LIVE_MODEL ?? "zai-org/GLM-5.3-Flash";
const real_model = runtime.getModel(provider, id);
assert(real_model, `Live model unavailable: ${provider}/${id}`);
const model = { ...real_model, contextWindow: 32768 };
const settings = SettingsManager.inMemory({
  compaction: { enabled: false, keepRecentTokens: 256, reserveTokens: 16384 },
  retry: { enabled: false },
});
settings.setProjectTrusted(true);
let starts = 0;
let compactions = 0;
const payloads: { text: string; starts: number; compactions: number }[] = [];
const errors: string[] = [];
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir: root,
  settingsManager: settings,
  noExtensions: true,
  noSkills: false,
  noContextFiles: true,
  additionalSkillPaths: [skill_dir],
  additionalExtensionPaths: [
    "extensions/lib/compaction.ts",
    "extensions/lib/model-context.ts",
    "extensions/llm-editor/index.ts",
    "extensions/cwd.ts",
  ].map((path) => resolve(path)),
  extensionFactories: [
    (pi) => {
      pi.on("before_agent_start", () => {
        starts++;
      });
      pi.on("tool_result", (event) => {
        if (event.toolName === "set_cwd") settings.setCompactionEnabled(true);
      });
      pi.on("session_compact", () => {
        compactions++;
        settings.setCompactionEnabled(false);
      });
      pi.on("before_provider_request", (event) => {
        payloads.push({
          text: JSON.stringify(event.payload),
          starts,
          compactions,
        });
      });
    },
  ],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert(
  loader.getSkills().skills.some((skill) => skill.name === "checkpoint-live"),
);
const cpiPrompt = buildCpiSystemPrompt(
  {
    cwd: root,
    selectedTools: ["read"],
    skills: [
      ...loader.getSkills().skills,
      ...loadSkillsFromDir({
        dir: resolve("skills/subagents-in-pi"),
        source: "path",
      }).skills,
    ],
  },
  { provider, modelId: id },
);
assert(
  cpiPrompt.includes(`<location>${join(skill_dir, "SKILL.md")}</location>`),
);
assert(cpiPrompt.includes("Use the read tool to load a skill's file"));
assert(cpiPrompt.includes("$CPI_HARNESS_SRC/skills/subagents-in-pi/SKILL.md"));
assert(
  cpiPrompt.includes(`<location>${join(project_skill, "SKILL.md")}</location>`),
);
const manager = SessionManager.create(root, join(root, "sessions"));
const { session } = await createAgentSession({
  cwd: root,
  agentDir: root,
  sessionManager: manager,
  resourceLoader: loader,
  settingsManager: settings,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  tools: ["read", "set_cwd"],
});
await session.bindExtensions({
  mode: "print",
  onError: (event) => errors.push(event.error),
});
try {
  const read = session.extensionRunner.getToolDefinition("read")!;
  const loaded = await read.execute(
    "alias-test",
    { path: "$CPI_HARNESS_SRC/skills/subagents-in-pi/SKILL.md" },
    undefined as any,
    undefined as any,
    session.extensionRunner.createContext(),
  );
  assert.equal(
    (loaded.details as { path: string }).path,
    resolve("skills/subagents-in-pi/SKILL.md"),
  );
  const padding =
    "Archived progress detail: the test workspace is temporary.\n".repeat(1800);
  await session.prompt(
    `This is a compaction integration task. The task fact to preserve is TASK_FACT_AMBER_9137. Read the checkpoint-live skill file at ${join(skill_dir, "SKILL.md")} using read, then answer only READY. Later I will ask for the skill verification marker; the checkpoint-live skill remains relevant until that follow-up is answered. Do not call any other tool during this turn. The following repetitive historical notes need not be repeated:\n${padding}`,
  );
  assert(
    manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "read" &&
          !entry.message.isError,
      ),
    JSON.stringify({
      tools: session.getActiveToolNames(),
      last: session.messages.at(-1),
    }),
  );
  await session.prompt(
    `Call set_cwd with path ${target}. After the tool finishes, answer with the skill verification marker and project verification marker. If compaction removed the skill instructions, reread its advertised file before answering. Do not repeat the historical notes.`,
  );
  assert.equal(
    compactions,
    1,
    "Expected automatic compaction between tool steps",
  );
  const checkpoint = manager
    .getBranch()
    .reverse()
    .find((entry) => entry.type === "compaction");
  assert(checkpoint?.type === "compaction");
  const details = checkpoint.details as any;
  assert.equal(details.cpiContext.version, 1);
  assert(!details.cpiContext.content.includes(skill_marker));
  assert(details.cpiContext.content.includes(project_marker));
  assert(
    !checkpoint.summary.includes(skill_marker),
    "Skill reference leaked into task summary",
  );
  assert(
    !checkpoint.summary.includes(project_marker),
    "Project reference leaked into task summary",
  );
  assert(checkpoint.summary.includes("TASK_FACT_AMBER_9137"));
  assert.match(
    checkpoint.summary,
    /<relevant-skills-to-reload>[\s\S]*checkpoint-live[\s\S]*<\/relevant-skills-to-reload>/,
  );
  const feedback_entries = () =>
    manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === COMPACTION_FEEDBACK,
      );
  assert.equal(feedback_entries().length, 1);
  const feedback = JSON.stringify(feedback_entries()[0]);
  assert(!feedback.includes("Restored skills:"));
  assert(feedback.includes(`Restored CWD at ${target}`));
  assert(feedback.includes(`Loaded project instructions: ${target}/AGENTS.md`));
  const continued = payloads.find((payload) => payload.compactions === 1);
  assert(continued, "No live post-compaction request captured");
  assert.equal(continued.starts, 2, "Restoration waited for a new user turn");
  assert(!continued.text.includes(skill_marker));
  assert.equal(
    continued.text.split(`Project verification marker: ${project_marker}.`)
      .length - 1,
    1,
  );
  assert(continued.text.includes("context-restored"));
  assert(
    manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "read" &&
          !entry.message.isError,
      ).length >= 2,
    "The continuing agent did not reread its selected skill",
  );
  const final = session.messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant");
  assert(final?.role === "assistant");
  const answer = final.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert(answer.includes(skill_marker) && answer.includes(project_marker));
  const manual = await session.compact(
    "Preserve the exact task fact and completed verification outcome.",
  );
  assert.equal(compactions, 2);
  assert.equal((manual.details as any).cpiContext.documents.length, 1);
  await session.prompt(
    "The integration task is complete. Answer only READY. " +
      "Archived context. ".repeat(100),
  );
  writeFileSync(join(target, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
  const before_failure = manager.getLeafId();
  await assert.rejects(session.compact(), /Compaction cancelled/);
  assert.equal(manager.getLeafId(), before_failure);
  assert.equal(compactions, 2);
  assert.deepEqual(errors, []);
  assert.equal(
    feedback_entries().length,
    2,
    "Failure produced success feedback",
  );
  assert(!JSON.stringify(session.messages).includes("Restored skills:"));
  assert(
    !payloads.some((payload) => payload.text.includes("Restored skills:")),
  );
  console.log(
    JSON.stringify({
      provider,
      id,
      compactions,
      starts,
      summaryTokens: checkpoint.usage?.output,
      restoredDocuments: details.cpiContext.documents.length,
      immediateContinuation: true,
      manual: true,
      oversizeCancelled: true,
      userOnlyFeedback: true,
      answer,
    }),
  );
} finally {
  session.dispose();
  rmSync(root, { recursive: true, force: true });
}
