import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FooterDataProvider } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { CommandRepository } from "../src/vcs/command-repository.ts";
import { createVcsSource } from "../src/vcs/index.ts";

const hasJj = spawnSync("jj", ["--version"]).status === 0;
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { stdio: "ignore", timeout: 5000 });

test.skipIf(!hasJj)(
  "nearest repository wins, JJ polling notifies, and cwd changes replace the active provider",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cpi-vcs-"));
    const nested = join(root, "nested-git");
    const subdirectory = join(root, "src");
    const workspace = join(root, "workspace");
    let data: FooterDataProvider | undefined;
    try {
      run("jj", ["git", "init", root]);
      run("jj", ["-R", root, "bookmark", "create", "before"]);
      mkdirSync(subdirectory);
      data = new FooterDataProvider(subdirectory, createVcsSource);
      const provider = data;
      expect(provider.getVcsStatus()).toBe("jj:before");
      const changes: Array<string | null> = [];
      provider.onBranchChange(() => changes.push(provider.getVcsStatus()));
      run("jj", ["-R", root, "bookmark", "rename", "before", "after"]);
      await vi.waitFor(() => expect(changes).toContain("jj:after"), {
        timeout: 4500,
      });

      run("git", ["init", "--initial-branch=nested", nested]);
      provider.setCwd(nested);
      expect(provider.getVcsStatus()).toBe("nested");
      expect(provider.getGitBranch()).toBe("nested");
      run("git", ["-C", nested, "symbolic-ref", "HEAD", "refs/heads/updated"]);
      await vi.waitFor(() => expect(changes.at(-1)).toBe("updated"), {
        timeout: 2500,
      });

      run("jj", ["-R", root, "workspace", "add", workspace]);
      run("jj", ["-R", workspace, "bookmark", "create", "workspace-change"]);
      provider.setCwd(workspace);
      expect(provider.getVcsStatus()).toBe("jj:workspace-change");
      provider.setCwd(subdirectory);
      expect(provider.getVcsStatus()).toBe("jj:after");
      const broken = join(root, "broken-git");
      mkdirSync(broken);
      writeFileSync(join(broken, ".git"), "invalid worktree metadata");
      provider.setCwd(broken);
      expect(provider.getVcsStatus()).toBeNull();
      provider.setCwd(tmpdir());
      expect(provider.getVcsStatus()).toBeNull();
    } finally {
      data?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("JJ query failure retains selection, while metadata removal and creation trigger reselection", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpi-vcs-failure-"));
  let data: FooterDataProvider | undefined;
  try {
    run("git", ["init", "--initial-branch=must-not-display", root]);
    mkdirSync(join(root, ".jj"));
    data = new FooterDataProvider(root, createVcsSource);
    expect(data.getVcsStatus()).toBeNull();
    const provider = data;
    rmSync(join(root, ".jj"), { recursive: true });
    await vi.waitFor(
      () => expect(provider.getVcsStatus()).toBe("must-not-display"),
      { timeout: 4500 },
    );
    mkdirSync(join(root, ".jj"));
    await vi.waitFor(() => expect(provider.getVcsStatus()).toBeNull(), {
      timeout: 4500,
    });
  } finally {
    data?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test("disposing a command repository aborts an in-flight child without publishing a late status", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpi-vcs-process-"));
  const script = join(root, "query.mjs");
  const pidFile = join(root, "pid");
  writeFileSync(
    script,
    `
import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('initialized')) {
  writeFileSync('initialized', '');
  console.log('initial');
} else {
  writeFileSync('pid', String(process.pid));
  setTimeout(() => console.log('late'), 10000);
}
`,
  );
  const repository = new CommandRepository(
    root,
    process.execPath,
    [script],
    (value) => value,
  );
  let changes = 0;
  repository.onChange(() => changes++);
  try {
    expect(repository.getStatus()).toBe("initial");
    const refresh = repository.refresh();
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), {
      timeout: 4500,
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    repository.dispose();
    await refresh;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
      timeout: 1500,
    });
    expect(changes).toBe(0);
    expect(repository.getStatus()).toBe("initial");
  } finally {
    repository.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
