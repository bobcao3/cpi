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
const click = (screen, pattern) => {
  const rows = screen.split("\n");
  const y = rows.findIndex((line) => pattern.test(line));
  assert.ok(y >= 0, screen);
  const x = rows[y].search(pattern);
  tmux(
    "send-keys",
    "-t",
    name,
    "-l",
    `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`,
  );
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
      assert.match(compact, /\.\.\. Click or Ctrl-O to expand/);
      assert.doesNotMatch(compact, /Full content|more code lines/);
      assert.equal(await readFile(target, "utf8"), "after\n");
      if (mode === "fullscreen") {
        click(compact, /Click or Ctrl-O to expand/);
        const expanded_script = await until(
          (s) =>
            !s.includes("Click or Ctrl-O to expand") &&
            s.includes("VERBOSE_SHELL_DETAIL") &&
            s.includes("[-] Click or Ctrl-Minus to collapse"),
        );
        click(expanded_script, /\[-\] Click.*to collapse/);
        const collapsed_script = await until(
          (s) =>
            s.includes("Click or Ctrl-O to expand") &&
            !s.includes("VERBOSE_SHELL_DETAIL"),
        );
        click(collapsed_script, /Click or Ctrl-O to expand/);
        await until((s) => s.includes("[-] Click or Ctrl-Minus to collapse"));
        tmux("send-keys", "-t", name, "-l", "\x1f");
        await until(
          (s) =>
            s.includes("Click or Ctrl-O to expand") &&
            !s.includes("VERBOSE_SHELL_DETAIL"),
        );
        tmux("send-keys", "-t", name, "C-o", "C-o");
        await until(
          (s) =>
            s.includes("Click or Ctrl-O to expand") &&
            !s.includes("VERBOSE_SHELL_DETAIL"),
        );
      }
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
          s.includes("VERBOSE_SHELL_DETAIL") &&
          !s.includes("Click or Ctrl-O to expand"),
      );
      const large_expanded = capture();
      assert.match(large_expanded, /\[-\] Click or Ctrl-Minus to collapse/);
      tmux("send-keys", "-t", name, "-l", "\x1f");
      await until(
        (s) => /▸ Code mode/.test(s) && !s.includes("VERBOSE_SHELL_DETAIL"),
      );
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          !s.includes("VERBOSE_SHELL_DETAIL") &&
          s.includes("Click or Ctrl-O to expand") &&
          !s.includes("read alpha.txt") &&
          !s.includes("read beta.txt"),
      );
      tmux("send-keys", "-t", name, "-l", "UNDO_SENTINEL");
      await until((s) => s.includes("UNDO_SENTINEL"));
      tmux("send-keys", "-t", name, "-l", "\x1f");
      await until((s) => !s.includes("UNDO_SENTINEL"));
      for (const context of ["one", "two"]) {
        const count = requests.length;
        script = Array.from(
          { length: 40 },
          (_, index) => `const context_${context}_${index} = ${index};`,
        ).join("\n");
        send(`Run the large ${context} context fixture`);
        await until(
          (s) =>
            requests.length >= count + 2 &&
            s.includes(`context_${context}_0`) &&
            /^\s*OK\s*$/m.test(s),
        );
      }
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          s.includes("context_two_39") &&
          s.includes("[-] Click or Ctrl-Minus to collapse"),
      );
      send("/inspect-tools");
      await until(
        (s) => s.includes("tool root") && s.includes("context_two_0"),
      );
      tmux("send-keys", "-t", name, "BTab");
      await until((s) =>
        s.slice(s.indexOf("tool root")).includes("context_one_0"),
      );
      tmux("send-keys", "-t", name, "-l", "\x1f");
      await until(
        (s) =>
          /▸ Code mode/.test(s.slice(s.indexOf("tool root"))) &&
          !s.slice(s.indexOf("tool root")).includes("context_one_0"),
      );
      tmux("send-keys", "-t", name, "Escape");
      await until(
        (s) => !s.includes("tool root") && s.includes("context_two_39"),
      );
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          s.includes("Run the large two context fixture") &&
          !s.includes("context_two_39"),
      );
      send("/new");
      await until(
        (s) =>
          !s.includes("Run the large two context fixture") &&
          s.includes("New session started"),
      );
      const written = join(directory, "singleton.txt");
      script = `await tools.write({path:${JSON.stringify(written)},file_text:"SINGLE_CHILD_CONTENT\\n"});`;
      send("Run the single-child write fixture");
      const flattened = await until(
        (s) => s.includes("SINGLE_CHILD_CONTENT") && /^\s*OK\s*$/m.test(s),
      );
      const write_lines = flattened.split("\n");
      const write_header = write_lines.find((line) =>
        /write .*singleton\.txt/.test(line),
      );
      const content_header = write_lines.find((line) => /Content:/.test(line));
      assert.ok(write_header, flattened);
      assert.ok(content_header, flattened);
      assert.equal(
        content_header.indexOf("Content:"),
        write_header.indexOf("write "),
      );
      assert.doesNotMatch(content_header, /[└├▾▸]/);
      assert.equal(await readFile(written, "utf8"), "SINGLE_CHILD_CONTENT\n");
      console.log(flattened);
      send("/new");
      await until(
        (s) =>
          !s.includes("Run the single-child write fixture") &&
          s.includes("gpt-5.5"),
      );
      script = `await tools.read({path:${JSON.stringify(alpha)}});`;
      send("Run the read expansion fixture");
      const read_collapsed = await until(
        (s) => /▸ read .*alpha\.txt/.test(s) && /^\s*OK\s*$/m.test(s),
      );
      assert.doesNotMatch(read_collapsed, /ALPHA_DETAIL/);
      if (mode === "fullscreen") click(read_collapsed, /▸ read .*alpha\.txt/);
      else {
        send("/inspect-tools");
        await until((s) => s.includes("tool root"));
        tmux("send-keys", "-t", name, "Down", "Down", "Down", "Right");
      }
      const read_expanded = await until(
        (s) => s.includes("Preview:") && s.includes("ALPHA_DETAIL"),
      );
      assert.doesNotMatch(read_expanded, /▸ Preview/);
      if (mode !== "fullscreen") {
        tmux("send-keys", "-t", name, "Escape");
        await until((s) => !s.includes("tool root"));
      }
      console.log(read_expanded);
      send("/new");
      await until(
        (s) =>
          !s.includes("Run the read expansion fixture") &&
          s.includes("gpt-5.5"),
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
      await until((s) => s.includes("no active background shells or monitors"));
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (s) =>
          /▸ sh_background_ps · No background shells/.test(s) &&
          !s.includes("no active background shells or monitors"),
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
