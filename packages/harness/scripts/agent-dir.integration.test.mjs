import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@cpi/cli";
import { agentDir } from "../bin/agent-dir.mjs";
import { loadFastConfig } from "../bin/fast-models.mjs";
import { loadCpiConfig } from "../src/lib/config.ts";
import { loadMergedConfig } from "../src/lib/provider-config.ts";
import { loadText } from "../src/lib/text.ts";
import { resolveTranscriptDir } from "../src/llm-editor/log.ts";

test("user config and artifacts follow Pi's agent directory with project precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpi-agent-dir-"));
  const previousHome = process.env.HOME;
  const previousAgent = process.env.CPI_CODING_AGENT_DIR;
  try {
    const home = join(root, "home");
    const agent = join(root, "agent");
    const project = join(root, "project");
    await mkdir(home);
    await mkdir(agent);
    await mkdir(join(project, ".cpi"), { recursive: true });
    process.env.HOME = home;
    process.env.CPI_CODING_AGENT_DIR = agent;
    assert.equal(agentDir(), getAgentDir());

    await writeFile(
      join(agent, "cpi-config.json"),
      JSON.stringify({ fast: { models: ["user-model"] } }),
    );
    assert.deepEqual(loadCpiConfig(project).fast.models, ["user-model"]);
    assert.deepEqual(loadFastConfig(project).models, ["user-model"]);
    await writeFile(
      join(project, ".cpi/cpi-config.json"),
      JSON.stringify({ fast: { models: ["project-model"] } }),
    );
    assert.deepEqual(loadCpiConfig(project).fast.models, ["project-model"]);
    assert.deepEqual(loadFastConfig(project).models, ["project-model"]);

    const defaults = join(root, "override.toml");
    await writeFile(defaults, '[message]\norigin = "default"\n');
    await writeFile(
      join(agent, "override.toml"),
      '[message]\norigin = "user"\n',
    );
    assert.equal(
      loadText("override", defaults, project).message.origin,
      "user",
    );
    await writeFile(
      join(project, ".cpi/override.toml"),
      '[message]\norigin = "project"\n',
    );
    assert.equal(
      loadText("override", defaults, project).message.origin,
      "project",
    );

    await writeFile(
      join(agent, "fallback-providers.json"),
      JSON.stringify({ fallbacks: [{ provider: "user", model: "model" }] }),
    );
    assert.equal(loadMergedConfig(project).fallbacks[0].provider, "user");
    await writeFile(
      join(project, ".cpi/fallback-providers.json"),
      JSON.stringify({ fallbacks: [{ provider: "project", model: "model" }] }),
    );
    assert.equal(loadMergedConfig(project).fallbacks[0].provider, "project");
    assert.equal(resolveTranscriptDir("", project), join(agent, "cpi-editor"));

    for (const configured of [
      "~/.cpi/other",
      pathToFileURL(agent).href,
      agent,
    ]) {
      process.env.CPI_CODING_AGENT_DIR = configured;
      assert.equal(agentDir(), getAgentDir());
    }
    delete process.env.CPI_CODING_AGENT_DIR;
    assert.equal(agentDir(), getAgentDir());
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgent === undefined) delete process.env.CPI_CODING_AGENT_DIR;
    else process.env.CPI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
  }
});
