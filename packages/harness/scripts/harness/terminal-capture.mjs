import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ghostmux = fileURLToPath(
  new URL("../../../ghostmux/bin/ghostmux.mjs", import.meta.url),
);
const keys = {
  Enter: "\r",
  Escape: "\x1b",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  "C-o": "\x0f",
};
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

export function terminalCapture(name, directory) {
  const mode = process.env.CPI_TEST_TERMINAL ?? "tmux";
  if (!["tmux", "ghostmux"].includes(mode))
    throw new Error(`Unknown terminal driver: ${mode}`);
  const run = (...args) =>
    mode === "ghostmux"
      ? execFileSync(
          process.execPath,
          [ghostmux, "-S", join(directory, "ghostmux.sock"), ...args],
          { encoding: "utf8", timeout: 5000 },
        )
      : execFileSync("tmux", args, { encoding: "utf8", timeout: 5000 });
  const capture = (styled = false) =>
    mode === "ghostmux"
      ? run("capture-pane", "--uid", name)
      : run("capture-pane", "-t", name, "-p", ...(styled ? ["-e"] : []));
  const key = (key) => {
    if (!Object.hasOwn(keys, key))
      throw new Error(`Unsupported terminal key: ${key}`);
    if (mode === "ghostmux")
      run("send-input", "--uid", name, "--text", keys[key]);
    else run("send-keys", "-t", name, key);
  };
  return {
    mode,
    capture,
    key,
    start(command) {
      const log = join(directory, "terminal.ansi");
      if (mode === "ghostmux")
        run(
          "new-session",
          "--uid",
          name,
          "--cwd",
          directory,
          "--cols",
          "140",
          "--rows",
          "40",
          "--log",
          log,
          "--",
          "/bin/sh",
          "-c",
          command,
        );
      else {
        run(
          "new-session",
          "-d",
          "-s",
          name,
          "-x",
          "140",
          "-y",
          "40",
          "-c",
          directory,
          "/bin/sh",
        );
        run("pipe-pane", "-o", "-t", name, `cat > ${quote(log)}`);
        this.send(command);
      }
    },
    send(text) {
      if (mode === "ghostmux")
        run("send-input", "--uid", name, "--text", text + "\r");
      else {
        run("send-keys", "-t", name, "-l", text);
        key("Enter");
      }
    },
    save(label, screen) {
      writeFileSync(join(directory, `${label}.txt`), screen);
      if (mode === "ghostmux")
        run(
          "screenshot",
          "--uid",
          name,
          "--output",
          join(directory, `${label}.png`),
          "--font-size",
          "14",
        );
    },
    stop() {
      if (mode === "ghostmux") run("kill-session", "--uid", name);
      else run("kill-session", "-t", name);
    },
  };
}
