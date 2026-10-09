import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piExecutableOnPath } from "../bin/host-pi.mjs";
import { fixture } from "./fast-fixture.mjs";

const mode = process.argv[2] ?? "fullscreen";
const theme = process.argv[3] ?? "dark";
assert.ok(["fullscreen", "regular"].includes(mode));
assert.ok(["dark", "light"].includes(theme));
const name = `cpi-syntax-${process.pid}`;
const record = join(tmpdir(), `${name}.ansi`);
const tmux = (...args) =>
  execFileSync("tmux", args, { encoding: "utf8", timeout: 5000 });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const capture = () => tmux("capture-pane", "-t", name, "-p");
const send = (value) => {
  tmux("send-keys", "-t", name, "-l", value);
  tmux("send-keys", "-t", name, "Enter");
};
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const screen = capture();
    if (check(screen)) return screen;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Terminal timed out:\n${capture()}`);
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
      "Local syntax renderer fixture.\n",
    );
    const path = join(directory, "grammar.ts");
    const before =
      'export const greeting = "hello"; // café 測試\nexport function welcome(name: string) {\n  return greeting + name + 1;\n}\n';
    const after = before
      .replace('"hello"', '"welcome"')
      .replace(" + 1;", " + 42;");
    const patch = `@@\n-${before.split("\n")[0]}\n+${after.split("\n")[0]}\n@@\n-  return greeting + name + 1;\n+  return greeting + name + 42;\n`;
    script = `await tools.write({path:${JSON.stringify(path)},file_text:${JSON.stringify(before)}});\nawait tools.apply_patch({path:${JSON.stringify(path)},patch:${JSON.stringify(patch)}});`;
    tmux(
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "100",
      "-y",
      "45",
      "-c",
      directory,
      "/bin/sh",
    );
    await writeFile(record, "");
    tmux("pipe-pane", "-o", "-t", name, `cat > ${quote(record)}`);
    try {
      send(
        `env COLORTERM=truecolor NODE_OPTIONS=${quote(process.env.NODE_OPTIONS ?? "")} NODE_PATH='' PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 CPI_CODING_AGENT_DIR=${quote(directory)} ${quote(process.execPath)} ${quote(piExecutableOnPath())} --approve --no-session --no-context-files --provider openai --model gpt-5.5 --tui-mode ${mode} --use-theme ${theme}`,
      );
      await until(
        (screen) => screen.includes("gpt-5.5") && screen.includes("ctrl+o"),
      );
      send("Run the syntax fixture");
      const screen = await until(
        (screen) => requests.length >= 2 && /^\s*OK\s*$/m.test(screen),
      );
      assert.match(screen, /grammar\.ts/);
      assert.match(screen, /welcome/);
      const written = screen.slice(
        screen.indexOf("write grammar.ts"),
        screen.indexOf("apply_patch grammar.ts"),
      );
      assert.match(written, /1 │ export const greeting/);
      assert.match(written, /4 │ }/);
      assert.doesNotMatch(written, /\bDiff\b|\+\s+1\s+export/);
      assert.equal(await readFile(path, "utf8"), after);
      tmux("send-keys", "-t", name, "C-o");
      await until((screen) => screen.includes("export const greeting"));
      tmux("resize-window", "-t", name, "-x", "45", "-y", "45");
      await until((screen) => screen.includes("grammar.ts"));
      tmux("resize-window", "-t", name, "-x", "100", "-y", "45");
      await until((screen) => screen.includes("export const greeting"));
      send("/reload");
      const reloaded = await until((screen) => screen.includes("Reloaded"));
      assert.doesNotMatch(reloaded, /Extension issues|Error loading/);
      tmux("pipe-pane", "-t", name);
      const raw = await readFile(record, "utf8");
      assert.match(raw, /\x1b\[1mconst/);
      assert.match(raw, /\x1b\[3m\/\/ café 測試/);
      const colors = Array.from(
        raw.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m\x1b\[1mconst/g),
        (match) => match.slice(1).map(Number),
      );
      assert.ok(colors.some(([red, green, blue]) => red > green && red > blue));
      assert.ok(
        colors.some(([red, green, blue]) => green > red && green > blue),
      );
      console.log(screen);
      console.log(
        `Verified ${mode}/${theme} numbered write code, syntax colors, attributes, file mutations, expansion, resize and reload. ANSI: ${record}`,
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
      call_id: `syntax_${requests.length}`,
      name: "codemode",
      arguments: JSON.stringify({ code }),
      status: "completed",
    };
  },
);
