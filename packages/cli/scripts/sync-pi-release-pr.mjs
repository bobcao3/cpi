import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { releaseInput } from "./sync-pi-release-input.mjs";

assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "PR writes require the GitHub Actions environment",
);
assert(
  process.env.CPI_PIN_UPDATE_TOKEN,
  "CPI_PIN_UPDATE_TOKEN is unavailable; configure the dedicated repository-scoped pin-update token",
);
assert.equal(process.env.GH_TOKEN, process.env.CPI_PIN_UPDATE_TOKEN);
assert.equal(
  process.argv.length,
  4,
  "Usage: sync-pi-release-pr.mjs prepare|publish RELEASE_TAG",
);
const action = process.argv[2];
assert(["prepare", "publish"].includes(action));
const input = releaseInput(process.argv[3]);
const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository, "bobcao3/cpi");
const allowed = [
  "vendor/pi/manifest.json",
  "package.json",
  "packages/cli/package.json",
  "packages/harness/package.json",
  "package-lock.json",
  "bun.lock",
];
function run(command, args, timeout = 30000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} failed: ${result.stdout}${result.stderr}`,
  );
  return result.stdout.trim();
}
const git = (...args) => run("git", args);
const gh = (...args) => run("gh", args);
const base = gh(
  "repo",
  "view",
  repository,
  "--json",
  "defaultBranchRef",
  "--jq",
  ".defaultBranchRef.name",
);
git("check-ref-format", "--branch", base);
git("check-ref-format", "--branch", input.branch);
function checkPaths(paths) {
  for (const path of paths.split("\n").filter(Boolean))
    assert(
      allowed.includes(path),
      `Refusing to overwrite unrelated changes: ${path}`,
    );
}
if (action === "prepare") {
  assert.equal(
    git("status", "--porcelain"),
    "",
    "PR preparation requires a clean checkout",
  );
  git("config", "user.name", "cpi-pin-update");
  git("config", "user.email", "cpi-pin-update@users.noreply.github.com");
  const remote = git(
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${input.branch}`,
  );
  if (remote) {
    assert.match(
      remote,
      new RegExp(
        `^[a-f0-9]{40}\\s+refs/heads/${input.branch.replaceAll(".", "\\.")}$`,
      ),
    );
    git("fetch", "origin", `refs/heads/${input.branch}`);
    const head = git("rev-parse", "FETCH_HEAD");
    checkPaths(git("diff", "--name-only", `origin/${base}...${head}`));
    git("switch", "-c", input.branch, head);
    run("git", ["merge", "--no-edit", `origin/${base}`], 120000);
  } else git("switch", "-c", input.branch, `origin/${base}`);
} else {
  assert.equal(git("branch", "--show-current"), input.branch);
  checkPaths(git("diff", "--name-only", "HEAD"));
  assert.equal(
    git("ls-files", "--others", "--exclude-standard"),
    "",
    "PR checkout contains unexpected untracked files",
  );
  if (git("diff", "--name-only", "HEAD")) {
    git("add", "--", ...allowed);
    git("commit", "-m", `Update Pi pin to ${input.version}`);
  }
  if (git("rev-list", "--count", `origin/${base}..HEAD`) === "0") {
    console.log("The verified Pi pin already matches; no new PR is necessary.");
  } else {
    run("git", ["push", "origin", `HEAD:refs/heads/${input.branch}`], 120000);
    const prs = JSON.parse(
      gh(
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--head",
        input.branch,
        "--base",
        base,
        "--json",
        "number,headRepository,headRepositoryOwner,isCrossRepository",
      ),
    );
    assert(prs.length <= 1, "Multiple pin PRs use the same branch");
    const title = `Update Pi pin to ${input.version}`;
    const body = `Pins the published ${input.tag} release from https://github.com/bobcao3/pi/releases/tag/${input.tag}.\n\nThe updater verified the tag commit, manifest, closed archives, source archives, and npm/Bun report, refreshed both locks without lifecycle scripts, and passed installed SDK checks and focused regression tests. Required PR CI must pass before a maintainer merges the PR.`;
    if (prs.length) {
      assert.equal(prs[0].isCrossRepository, false);
      assert.equal(
        `${prs[0].headRepositoryOwner.login}/${prs[0].headRepository.name}`,
        repository,
      );
      gh(
        "pr",
        "edit",
        String(prs[0].number),
        "--repo",
        repository,
        "--title",
        title,
        "--body",
        body,
      );
    } else
      gh(
        "pr",
        "create",
        "--repo",
        repository,
        "--base",
        base,
        "--head",
        input.branch,
        "--title",
        title,
        "--body",
        body,
      );
  }
}
