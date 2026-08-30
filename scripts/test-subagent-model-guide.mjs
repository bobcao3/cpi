import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  findSubagentModelGuide,
  subagentModelEfforts,
  subagentGuidePath,
} from "../extensions/lib/subagent-model-guide.ts";
import { loadText, render, textPath } from "../extensions/lib/text.ts";

assert.deepEqual(subagentModelEfforts(false), []);
assert.deepEqual(subagentModelEfforts(true), [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
]);
assert.deepEqual(
  subagentModelEfforts(true, { low: null, xhigh: "xhigh", max: null }),
  ["off", "minimal", "medium", "high", "xhigh"],
);
assert.deepEqual(subagentModelEfforts(true, undefined, "max"), ["max"]);

const subagentModels = loadText("subagent-models", textPath("subagent-models"));
const guideTemplate = subagentModels.workflow.guide_template;
assert.ok(guideTemplate.trim().split(/\s+/).length < 500);
assert.ok((guideTemplate.match(/provider\/model:effort/g) ?? []).length <= 3);
const guideTitle = guideTemplate.match(/^\s*#\s+.+$/m)?.[0].trim();
assert.ok(guideTitle);

const workflowPrompt = render(subagentModels.workflow.prompt, {
  targetPath: "/tmp/subagent-models.md",
  providers: [{ id: "anthropic", name: "Anthropic" }],
  models: "- `anthropic/claude-sonnet-4:low`",
  benchmarkScript: "scripts/benchmark.ts",
  guideTemplate,
});
assert.match(workflowPrompt, /scripts\/benchmark\.ts/);
assert.ok(workflowPrompt.includes(guideTitle));
assert.match(workflowPrompt, /under 500/);
assert.match(workflowPrompt, /no more than three/);

const root = mkdtempSync(join(tmpdir(), "cpi-subagent-guide-"));
try {
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  assert.equal(findSubagentModelGuide(cwd, true, agentDir), undefined);

  const userPath = subagentGuidePath(cwd, "user", agentDir);
  const projectPath = subagentGuidePath(cwd, "project", agentDir);
  writeFileSync(userPath, "user guide\n");
  writeFileSync(projectPath, "project guide\n");
  assert.deepEqual(findSubagentModelGuide(cwd, false, agentDir), {
    path: userPath,
    text: "user guide",
  });
  assert.deepEqual(findSubagentModelGuide(cwd, true, agentDir), {
    path: projectPath,
    text: "project guide",
  });

  writeFileSync(projectPath, "updated project guide\n");
  assert.equal(
    findSubagentModelGuide(cwd, true, agentDir)?.text,
    "updated project guide",
  );
  console.log("subagent model guide: all pass");
} finally {
  rmSync(root, { recursive: true });
}
