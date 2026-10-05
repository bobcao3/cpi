import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { localFixture } from "../local-fixture.mjs";
import { packagePath } from "../test-runtime.mjs";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { piExecutableOnPath } from "../../bin/host-pi.mjs";
import { resolveGhostmux } from "@cpi/ghostmux/resolve";

const execute = promisify(execFile);
const binary = await resolveGhostmux();
for (const mode of ["regular", "fullscreen"]) {
  const local = await localFixture(() => {
    throw new Error("Footer navigation must not prompt a model");
  });
  const directory = local.directory;
  const socket = join(directory, "terminal.sock");
  const manifest = join(directory, "shell.json");
  const fixture = join(directory, "footer-fixture.ts");
  const uid = "footer-layout";
  const command = async (...args: string[]) =>
    (await execute(binary, ["-S", socket, ...args], { timeout: 10000 })).stdout;
  const input = (text: string) =>
    command("send-input", "--uid", uid, "--text", text);
  const resize = (cols: number) =>
    command(
      "resize-window",
      "--uid",
      uid,
      "--cols",
      String(cols),
      "--rows",
      "24",
    );
  const capture = () => command("capture-pane", "--uid", uid, "--join");
  const selectionPixels = async (screen: string): Promise<number[][]> => {
    const lines = screen.split("\n");
    const row = lines.findIndex((line) => line.includes("shell:1"));
    assert.ok(row >= 0);
    const columns = [
      lines[row].indexOf("shell:1"),
      lines[row].indexOf("mon:1"),
      lines[row].indexOf("mon:1") + "mon:1".length,
    ];
    const file = join(directory, "selection.png");
    await command("screenshot", "--uid", uid, "--output", file);
    const { data, info } = await sharp(await readFile(file))
      .raw()
      .toBuffer({ resolveWithObject: true });
    return columns.map((column) => {
      assert.ok(column >= 0 && column < 40);
      const left = Math.floor((column * info.width) / 40);
      const right = Math.floor(((column + 1) * info.width) / 40);
      const top = Math.floor((row * info.height) / 24);
      const bottom = Math.floor(((row + 1) * info.height) / 24);
      const pixels: number[] = [];
      for (let y = top; y < bottom; y++) {
        const start = (y * info.width + left) * info.channels;
        pixels.push(
          ...data.subarray(start, start + (right - left) * info.channels),
        );
      }
      return pixels;
    });
  };
  async function waitFor(
    predicate: (screen: string) => boolean,
  ): Promise<string> {
    let screen = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      screen = await capture();
      if (predicate(screen)) return screen;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Terminal condition did not occur (${mode}):\n${screen}`);
  }
  const footer = (screen: string) =>
    screen
      .split("\n")
      .filter(
        (line) =>
          line.includes(directory.slice(0, 12)) ||
          /codex|Subagents|shell:1|mon:1/.test(line),
      );
  await writeFile(
    fixture,
    `
import { startRepeat } from ${JSON.stringify(packagePath("extensions/shell/repeat.ts"))};
import { runShell } from ${JSON.stringify(packagePath("extensions/shell/exec.ts"))};
import { buildShellEnvWithDotenv } from ${JSON.stringify(packagePath("extensions/shell/tools.ts"))};
import { ghostmuxSocket } from ${JSON.stringify(packagePath("extensions/shell/ghostmux.ts"))};
import { loadShellConfig } from ${JSON.stringify(packagePath("extensions/lib/config.ts"))};
import { resolveShell } from ${JSON.stringify(packagePath("extensions/shell/profile.ts"))};
import { registerRightSegment } from ${JSON.stringify(packagePath("extensions/lib/footer.ts"))};
import { codexUsage } from ${JSON.stringify(packagePath("extensions/lib/provider-usage/codex.ts"))};
import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.on("session_start", async (event, ctx) => {
    const report = { primary: { usedPercent: 50, resetAt: Date.now() + 3600000 } };
    registerRightSegment("usage", () => codexUsage.format(report, Date.now(), ctx.ui.theme));
    if (event.reason === "reload") return;
    const env = buildShellEnvWithDotenv(ctx.sessionManager);
    const config = loadShellConfig();
    const shell = resolveShell(config.executable);
    await runShell("sleep 60", 0, env, undefined, undefined, "layout shell", config.maxWaitfor, { maxLines: config.maxPreviewLines }, config, shell, ctx.cwd);
    startRepeat("true", 5, env, "layout monitor", shell, ctx.cwd);
    writeFileSync(${JSON.stringify(manifest)}, JSON.stringify({ socket: ghostmuxSocket(env) }));
  });
}
`,
  );
  try {
    const env = { ...process.env, CPI_CODING_AGENT_DIR: local.agentDir };
    for (const key of [
      "CPI_COST_SOCKET",
      "CPI_COST_RUN_ID",
      "PI_SUBAGENT",
      "CPI_FORK_PROBE",
    ])
      delete env[key];
    await execute(
      binary,
      [
        "-S",
        socket,
        "new-session",
        "--uid",
        uid,
        "--is-pty",
        "true",
        "--cols",
        "40",
        "--rows",
        "24",
        "--",
        piExecutableOnPath(),
        "--offline",
        "--approve",
        "--no-session",
        "--session-dir",
        directory,
        "--tui-mode",
        mode,
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "-e",
        packagePath("extensions/core.ts"),
        "-e",
        packagePath("extensions/shell.ts"),
        "-e",
        fixture,
      ],
      { env, cwd: directory, timeout: 10000 },
    );
    const initial = await waitFor(
      (screen) =>
        screen.includes(directory.slice(0, 12)) &&
        /shell:1/.test(screen) &&
        /mon:1/.test(screen),
    );
    const stable = footer(initial);
    const before_selection = await selectionPixels(initial);
    await input("\x1b[B");
    let selected_pixels: number[][] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      selected_pixels = await selectionPixels(await capture());
      if (
        JSON.stringify(selected_pixels[0]) !==
        JSON.stringify(before_selection[0])
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.notDeepEqual(
      selected_pixels[0],
      before_selection[0],
      "Selection must emphasize the focused activity label",
    );
    assert.deepEqual(
      selected_pixels[1],
      before_selection[1],
      "Selection must not emphasize the other activity label",
    );
    assert.deepEqual(
      selected_pixels[2],
      before_selection[2],
      "Selection must not emphasize trailing padding",
    );
    assert.deepEqual(footer(await capture()), stable);
    await input("\x1b[C");
    let monitor_pixels: number[][] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      monitor_pixels = await selectionPixels(await capture());
      if (
        JSON.stringify(monitor_pixels[1]) !==
        JSON.stringify(before_selection[1])
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(monitor_pixels[0], before_selection[0]);
    assert.notDeepEqual(monitor_pixels[1], before_selection[1]);
    assert.deepEqual(monitor_pixels[2], before_selection[2]);
    assert.deepEqual(footer(await capture()), stable);
    await input("\r");
    await waitFor((screen) => screen.includes("Activity"));
    await resize(60);
    await waitFor(
      (screen) =>
        /\[\s*Monitor\s*\]/.test(screen) && screen.includes("layout monitor"),
    );
    await input("\x1b");
    await waitFor((screen) => !screen.includes("Activity"));
    await resize(40);
    await waitFor((screen) => footer(screen).join("\n") === stable.join("\n"));
    await input("/reload\r");
    await waitFor((screen) => screen.includes("Reloaded"));
    await waitFor((screen) => footer(screen).join("\n") === stable.join("\n"));
    await input("\x1b[B");
    assert.deepEqual(footer(await capture()), stable);
    await input("\r");
    await waitFor((screen) => screen.includes("Activity"));
    await resize(60);
    await waitFor(
      (screen) =>
        /\[\s*Shell\s*\]/.test(screen) && screen.includes("layout shell"),
    );
    await input("\x1b");
    await waitFor((screen) => !screen.includes("Activity"));
    await resize(Math.max(80, 2 * directory.length + 80));
    await waitFor(
      (screen) =>
        footer(screen).join("\n").includes(directory) &&
        /codex/.test(screen) &&
        /shell:1.*mon:1/.test(screen),
    );
    if (mode === "fullscreen") {
      for (const [label, tab, description] of [
        ["mon:1", "Monitor", "layout monitor"],
        ["shell:1", "Shell", "layout shell"],
      ]) {
        const lines = (await capture()).split("\n");
        const row = lines.findIndex((line) => line.includes(label));
        assert.ok(row >= 0);
        const column = lines[row].indexOf(label) + 1;
        await input(
          `\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`,
        );
        await waitFor(
          (screen) =>
            screen.includes(description) &&
            new RegExp(`\\[\\s*${tab}\\s*\\]`).test(screen),
        );
        await input("\x1b");
        await waitFor((screen) => !screen.includes("Activity"));
      }
    }
    assert.equal(local.requests.length, 0);
    await input("\x04");
    console.log(
      `PASS ${mode}: stable native footer layout, narrow-screen keyboard activation, resize and reload${mode === "fullscreen" ? ", and native mouse regions" : ""}`,
    );
  } finally {
    await command("kill-session", "--uid", uid).catch(() => {});
    await command("kill-server").catch(() => {});
    try {
      const saved = JSON.parse(await readFile(manifest, "utf8"));
      await execute(binary, ["-S", saved.socket, "kill-server"], {
        timeout: 10000,
      });
    } catch {}
    await local.close();
  }
}
