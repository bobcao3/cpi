import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  FooterComponent,
  FooterDataProvider,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences as stripAnsi,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { createVcsSource } from "../src/vcs/index.ts";

test.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
  "footer selects JJ before its first render and follows logical cwd without changing session cwd",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cpi-footer-"));
    const launch = join(root, "launch");
    const target = join(root, "target");
    execFileSync("git", [
      "init",
      "--quiet",
      "--initial-branch=launch-branch",
      launch,
    ]);
    execFileSync("jj", ["git", "init", target]);
    execFileSync("jj", [
      "--repository",
      target,
      "bookmark",
      "create",
      "project-change",
    ]);
    const agentDir = join(root, "agent");
    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({
      cwd: launch,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(launch);
    sessionManager.appendSessionInfo("Project view");
    const { session } = await createAgentSession({
      cwd: launch,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager,
    });
    const data = new FooterDataProvider(target, createVcsSource);
    initTheme("dark", false);
    const footer = new FooterComponent(session, data);
    const first = () => stripAnsi(footer.render(240)[0]);
    try {
      expect(first()).toContain(`${target} (jj:project-change) • Project view`);
      expect(
        footer.render(240).slice(1).map(stripAnsi).join("\n"),
      ).not.toContain("jj:project-change");
      data.setProject({ cwd: launch });
      expect(first()).toContain(`${launch} (launch-branch) • Project view`);
      data.setProject({ cwd: target });
      expect(first()).toContain(`${target} (jj:project-change) • Project view`);
      expect(sessionManager.getCwd()).toBe(launch);
      for (const width of [1, 3, 12, 40, 80]) {
        for (const row of footer.render(width))
          expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    } finally {
      data.dispose();
      session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
