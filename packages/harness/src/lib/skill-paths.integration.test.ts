import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadSkillsFromDir, type ExtensionContext } from "@cpi/cli";
import { readTool } from "../llm-editor/tool.ts";
import { expandSourcePath } from "./skill-paths.ts";
import { buildCpiSystemPrompt } from "./system-prompt-build.ts";

const harness_root = fileURLToPath(new URL("../../", import.meta.url));

test("package symlink skills advertise readable source aliases", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cpi-skill-paths-"));
  const packages = join(directory, "node_modules", "@cpi");
  mkdirSync(packages, { recursive: true });
  const alias = join(packages, "harness");
  symlinkSync(harness_root, alias, "dir");
  const previous_root = process.env.CPI_HARNESS_SRC;
  try {
    process.env.CPI_HARNESS_SRC = join(directory, "stale-harness");
    const { skills, diagnostics } = loadSkillsFromDir({
      dir: join(alias, "skills", "subagents-in-pi"),
      source: "path",
    });
    assert.deepEqual(diagnostics, []);
    assert.equal(skills.length, 1);
    const path = "$CPI_HARNESS_SRC/skills/subagents-in-pi/SKILL.md";
    const prompt = buildCpiSystemPrompt(
      { cwd: directory, selectedTools: ["read"], skills },
      { provider: "integration", modelId: "integration" },
    );
    assert.ok(prompt.includes(`<location>${path}</location>`), prompt);
    assert.equal(process.env.CPI_HARNESS_SRC, realpathSync(harness_root));
    assert.equal(
      realpathSync(expandSourcePath(path)),
      realpathSync(skills[0]!.filePath),
    );
    const result = await readTool.execute(
      "skill-alias",
      { path },
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    assert.ok(
      result.content[0]?.text?.startsWith(
        readFileSync(skills[0]!.filePath, "utf8"),
      ),
    );
    const project = loadSkillsFromDir({
      dir: join(alias, "skills", "subagents-in-pi"),
      source: "project",
    });
    const project_prompt = buildCpiSystemPrompt(
      { cwd: directory, selectedTools: ["read"], skills: project.skills },
      { provider: "integration", modelId: "integration" },
    );
    assert.ok(
      project_prompt.includes(`<location>${skills[0]!.filePath}</location>`),
      project_prompt,
    );
  } finally {
    if (previous_root === undefined) delete process.env.CPI_HARNESS_SRC;
    else process.env.CPI_HARNESS_SRC = previous_root;
    rmSync(directory, { recursive: true, force: true });
  }
});
