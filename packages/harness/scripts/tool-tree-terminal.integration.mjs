import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./fast-fixture.mjs";
import { piExecutableOnPath } from "../bin/host-pi.mjs";
const mode = process.argv[2] ?? "fullscreen";
assert.ok(["fullscreen", "regular"].includes(mode));
const name = `cpi-boundary-${process.pid}`;
const tmux = (...args) =>
  execFileSync("tmux", args, { encoding: "utf8", timeout: 5000 });
const quote = (v) => `'${v.replaceAll("'", "'\\''")}'`;
const capture = () => tmux("capture-pane", "-t", name, "-p");
const send = (v) => {
  tmux("send-keys", "-t", name, "-l", v);
  tmux("send-keys", "-t", name, "Enter");
};
async function until(check) {
  for (let n = 0; n < 150; n++) {
    const screen = capture();
    if (check(screen)) return screen;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out:\n${capture()}`);
}
let script;
await fixture(
  async ({ directory, requests }) => {
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.5" }),
    );
    await writeFile(
      join(directory, "subagent-models.md"),
      "Local renderer fixture.\n",
    );
    const alpha = join(directory, "alpha.txt"),
      beta = join(directory, "beta.txt"),
      target = join(directory, "target.txt");
    await writeFile(alpha, "ALPHA_DETAIL\n");
    await writeFile(beta, "BETA_DETAIL\n");
    await writeFile(target, "before\n");
    const completionWorker = join(directory, "completion.mjs");
    await writeFile(
      completionWorker,
      "setTimeout(() => process.exit(Number(process.argv[2])), 2000);\n",
    );
    const failureCommand = `printf '${"VERBOSE_SHELL_DETAIL\\n".repeat(80)}'; exit 7`;
    script = `await Promise.all([tools.read({path:${JSON.stringify(alpha)}}),tools.read({path:${JSON.stringify(beta)}})]);\nawait tools.apply_patch({path:${JSON.stringify(target)},patch:"@@\\n-before\\n+after\\n"});\nawait tools.sh({command:"true",description:"Terminal shell success",waitfor:2});\nawait tools.sh({command:${JSON.stringify(failureCommand)},description:"Failed shell remains compact",waitfor:2});`;
    tmux(
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "120",
      "-y",
      "45",
      "-c",
      directory,
      "/bin/sh",
    );
    const record = join(tmpdir(), `${name}.ansi`);
    await writeFile(record, "");
    tmux("pipe-pane", "-o", "-t", name, `cat > ${quote(record)}`);
    try {
      send(
        `env NODE_OPTIONS=${quote(process.env.NODE_OPTIONS ?? "")} NODE_PATH='' PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 CPI_CODING_AGENT_DIR=${quote(directory)} ${quote(process.execPath)} ${quote(piExecutableOnPath())} --approve --no-session --no-context-files --provider openai --model gpt-5.5 --tui-mode ${mode}`,
      );
      await until((s) => s.includes("gpt-5.5") && s.includes("ctrl+o"));
      send("Run the boundary fixture");
      const compact = await until(
        (s) => requests.length >= 2 && /^\s*OK\s*$/m.test(s),
      );
      assert.match(compact, /Code mode/);
      assert.match(compact, /alpha\.txt/);
      assert.match(compact, /beta\.txt/);
      assert.match(compact, /2 files/);
      assert.match(compact, /after/);
      assert.match(compact, /Terminal shell success/);
      assert.match(compact, /Failed shell remains compact.*exit 7/);
      assert.doesNotMatch(compact, /VERBOSE_SHELL_DETAIL|[▄▀]{10}/);
      assert.equal(await readFile(target, "utf8"), "after\n");
      send("/inspect-tools");
      const inspector = await until((s) => s.includes("tool root"));
      assert.match(inspector, /Code mode/);
      tmux("send-keys", "-t", name, "Down", "Right");
      await until((s) => s.includes("Code mode"));
      tmux("resize-window", "-t", name, "-x", "70", "-y", "45");
      await until((s) => s.includes("Code mode"));
      tmux("send-keys", "-t", name, "Escape");
      await until((s) => !s.includes("tool root"));
      tmux("resize-window", "-t", name, "-x", "120", "-y", "45");
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          s.includes("Tool output: expanded") &&
          s.includes("VERBOSE_SHELL_DETAIL"),
      );
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          !s.includes("VERBOSE_SHELL_DETAIL") &&
          !s.includes("read alpha.txt") &&
          !s.includes("read beta.txt"),
      );
      send("/new");
      await until(
        (s) => !s.includes("Run the boundary fixture") && s.includes("gpt-5.5"),
      );
      script = `await tools.sh({command:${JSON.stringify(`${quote(process.execPath)} ${quote(completionWorker)} 0`)},description:"Async shell success",waitfor:1});\nawait tools.sh({command:${JSON.stringify(`${quote(process.execPath)} ${quote(completionWorker)} 7`)},description:"Async shell failure",waitfor:1});`;
      send("Run the completion fixture");
      const notices = await until(
        (s) =>
          /^✓ ▸ Shell.*Async shell success.*exit 0/m.test(s) &&
          /^× ▸ Shell.*Async shell failure.*exit 7/m.test(s),
      );
      assert.doesNotMatch(notices, /cpi-ghostmux.*\.log|<notification/);
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          s.includes('<notification type="shell-failed">') &&
          /cpi-ghostmux.*\.log/.test(s),
      );
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          /^× ▸ Shell.*Async shell failure/m.test(s) &&
          !s.includes("<notification"),
      );
      script = "await tools.sh_background_ps({});";
      send("List backgrounds");
      await until((s) => /▸ sh_background_ps · No background shells/.test(s));
      tmux("send-keys", "-t", name, "C-o");
      await until((s) => s.includes("0 background shells, 0 monitors"));
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          /▸ sh_background_ps · No background shells/.test(s) &&
          !s.includes("0 background shells, 0 monitors"),
      );
      assert.ok(
        requests.some((request) => {
          const body = JSON.stringify(request.body);
          return (
            body.includes("shell-failed") &&
            body.includes("<summary>Shell PID=") &&
            body.includes(".log")
          );
        }),
      );
      send("/reload");
      const reloaded = await until((s) => s.includes("Reloaded"));
      assert.doesNotMatch(reloaded, /Extension issues|Error loading/);
      tmux("pipe-pane", "-t", name);
      const raw = await readFile(record, "utf8");
      assert.doesNotMatch(raw, /[▄▀]{10}/);
      console.log(compact);
      console.log(notices);
      console.log(
        `Terminal passed plain trees, collapsed failures and completion notices, empty background disclosures, inspector, resize, expansion and reload. ANSI: ${record}`,
      );
    } finally {
      tmux("kill-session", "-t", name);
    }
  },
  100,
  undefined,
  (requests) => {
    if (!script) return undefined;
    const code = script;
    script = undefined;
    return {
      type: "function_call",
      id: `fc_${requests.length}`,
      call_id: `boundary_${requests.length}`,
      name: "codemode",
      arguments: JSON.stringify({ code }),
      status: "completed",
    };
  },
);
