import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piExecutableOnPath } from "../bin/host-pi.mjs";
import { fixture } from "./fast-fixture.mjs";

const name = `cpi-tui-${process.pid}`;
const record = join(tmpdir(), `${name}.ansi`);
const summary = "I'm finishing the module and verifying the footer.";
const execute = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 5000 });
const tmux = (...args) => execute("tmux", args);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const capture = () => tmux("capture-pane", "-t", name, "-p");
const send = (text) => {
  tmux("send-keys", "-t", name, "-l", text);
  tmux("send-keys", "-t", name, "Enter");
};
let resume;
let response_ready = new Promise((resolve) => {
  resume = resolve;
});
const telemetry_line = (screen) =>
  screen.split("\n").find((line) => /↑\d.*↓\d.*R\d.*CH[\d.]+%/.test(line));
async function until(check) {
  for (let index = 0; index < 100; index++) {
    const screen = capture();
    if (await check(screen)) return screen;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${capture()}`);
}
const statuses = async () =>
  [
    ...(await readFile(record, "utf8")).matchAll(
      /\x1b\]7501;([^\x07\x1b]*)\x1b\\/g,
    ),
  ].map((match) => {
    const status = Object.fromEntries(
      match[1].split(":").map((pair) => {
        const index = pair.indexOf("=");
        return [pair.slice(0, index), pair.slice(index + 1)];
      }),
    );
    if (status.msg)
      status.msg = Buffer.from(status.msg, "base64").toString("utf8");
    return status;
  });
const until_status = (state) =>
  until(async () => (await statuses()).at(-1)?.state === state);
await fixture(
  async ({ directory, requests }) => {
    const extension = join(directory, "footer-fixture.mjs");
    const footer_url = new URL("../extensions/lib/footer.ts", import.meta.url)
      .href;
    await writeFile(
      extension,
      `import { registerLineSegment } from ${JSON.stringify(footer_url)};\nexport default function(pi) { pi.on("before_agent_start", () => { registerLineSegment("summary", () => ${JSON.stringify(summary)}); }); pi.registerCommand("status-dialog", {description: "Program status fixture", handler: async (_args, ctx) => { await ctx.ui.confirm("Status question", "Proceed?"); }}); }\n`,
    );
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ retry: { enabled: false } }),
    );
    execute("jj", ["git", "init", directory]);
    execute("jj", ["-R", directory, "bookmark", "create", "app-first-frame"]);
    await writeFile(record, "");
    tmux(
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "140",
      "-y",
      "45",
      "-c",
      directory,
      "/bin/sh",
    );
    try {
      tmux("pipe-pane", "-o", "-t", name, `cat > ${quote(record)}`);
      send(
        `env NODE_OPTIONS=${quote(process.env.NODE_OPTIONS ?? "")} CPI_FORK=${quote(process.env.CPI_FORK ?? "")} NODE_PATH='' PI_PROGRAM_STATUS=1 PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 CPI_CODING_AGENT_DIR=${quote(directory)} ${quote(process.execPath)} ${quote(piExecutableOnPath())} --approve --no-session --no-context-files --provider openai --model gpt-5.5 -e ${quote(extension)}`,
      );
      await until((screen) => screen.includes("jj:app-first-frame"));
      await until((screen) => screen.includes("Subagent model guide"));
      tmux("send-keys", "-t", name, "Escape");
      const idle = await until(
        (screen) =>
          !screen.includes("Subagent model guide") && !!telemetry_line(screen),
      );
      const idle_header = telemetry_line(idle);
      assert.match(idle_header, /↑0 ↓0 R0 CH0\.0%/);
      assert.match(idle_header, /💤/u);
      assert.doesNotMatch(idle_header, /\(auto\)|Working/);
      await until_status("idle");
      send("/status-dialog");
      await until_status("blocked");
      assert.deepEqual((await statuses()).at(-1), {
        state: "blocked",
        app: "cpi",
        kind: "permission",
        msg: "Status question",
      });
      tmux("send-keys", "-t", name, "Escape");
      await until_status("idle");
      send("Reply OK");
      const active = await until(
        (screen) =>
          requests.length >= 1 &&
          !!telemetry_line(screen) &&
          !telemetry_line(screen).includes("💤"),
      );
      const active_header = telemetry_line(active);
      assert.equal(active_header.indexOf("↑0"), idle_header.indexOf("↑0"));
      assert.match(
        active_header.slice(0, active_header.indexOf("↑0")),
        /[^─\s]/u,
      );
      assert.doesNotMatch(active_header, /Working|💤/u);
      await until_status("working");
      resume();
      await until(
        (screen) => requests.length >= 1 && /^\s*OK\s*$/m.test(screen),
      );
      await until_status("done");
      execute("jj", [
        "--ignore-working-copy",
        "-R",
        directory,
        "bookmark",
        "rename",
        "app-first-frame",
        "app-after-refresh",
      ]);
      await until((screen) => screen.includes("jj:app-after-refresh"));
      send("/reload");
      await until(
        (screen) =>
          /Reloaded/.test(screen) && screen.includes("jj:app-after-refresh"),
      );
      send("Reply again");
      const screen = await until(
        (screen) =>
          requests.length >= 2 &&
          (screen.match(/^\s*OK\s*$/gm) ?? []).length >= 2 &&
          !!telemetry_line(screen)?.includes("💤"),
      );
      console.log(screen);
      const footer_index = screen
        .split("\n")
        .findIndex((line) => line.includes("jj:app-after-refresh"));
      const footer = screen
        .split("\n")
        .slice(footer_index)
        .filter((line) => line.trim());
      assert.equal(footer.length, 3);
      assert.equal(footer[2], summary);
      assert.doesNotMatch(footer.slice(0, 2).join("\n"), /I'm finishing/);
      assert.match(
        footer[1],
        /^\$[\d.]+ \(Subagents: \$[\d.]+\) • openai\s+gpt-5\.5 • \w+$/,
      );
      assert.doesNotMatch(footer.join("\n"), /CH[\d.]+%|\(auto\)/);
      assert.match(telemetry_line(screen), /CH20\.0%/);
      await until_status("done");
      send("PRIVATE_PROMPT: report the fixture failure");
      await until_status("error");
      assert.match((await statuses()).at(-1).msg, /STATUS_FAILURE$/);
      response_ready = new Promise((resolve) => {
        resume = resolve;
      });
      send("PRIVATE_PROMPT: cancel this request");
      await until(
        (screen) =>
          requests.length >= 4 && !telemetry_line(screen)?.includes("💤"),
      );
      await until_status("working");
      tmux("send-keys", "-t", name, "Escape");
      await until_status("idle");
      resume();
      const reports = await statuses();
      assert(reports.every((status) => status.app === "cpi"));
      assert.doesNotMatch(
        JSON.stringify(reports),
        /PRIVATE_PROMPT|PRIVATE_ERROR_DETAIL|Reply OK|I'm finishing/,
      );
      tmux("resize-window", "-t", name, "-x", "80", "-y", "35");
      await until(
        (screen) => !!telemetry_line(screen) && screen.includes("Subagents:"),
      );
      tmux("pipe-pane", "-t", name);
      const output = await readFile(record, "utf8");
      assert.match(output, /jj:app-first-frame/);
      assert.match(output, /jj:app-after-refresh/);
      assert.doesNotMatch(output, /\(detached\)|Extension issues/);
      console.log(
        `Live TUI passed JJ, reload, extension ownership, and upstream program statuses including dialogs, errors, and cancellation. Recording: ${record}`,
      );
    } finally {
      resume();
      tmux("kill-session", "-t", name);
    }
  },
  100,
  () => response_ready,
  (requests) =>
    requests.length === 3
      ? {
          type: "error",
          code: "fixture_failure",
          message: "STATUS_FAILURE\nPRIVATE_ERROR_DETAIL",
        }
      : undefined,
);
process.exit(0);
