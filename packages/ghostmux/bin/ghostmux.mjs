#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolveGhostmux } from "./ghostmux-resolve.mjs";

try {
  const binary = await resolveGhostmux();
  if (process.argv[2] === "--resolve") {
    process.stdout.write(`${binary}\n`);
  } else {
    const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => child.kill(signal));
    }
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      } else {
        process.exitCode = code ?? 1;
      }
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
