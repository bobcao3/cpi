import { Console } from "node:console";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

const levels = { WARNING: 0, ERROR: 0, INFO: 1, DEBUG: 2 };
const line_limit = 16 * 1024;

export class Logger {
  constructor(verbosity = 0) {
    this.verbosity = verbosity;
    this.console = new Console({
      stdout: process.stderr,
      stderr: process.stderr,
    });
  }

  log(level, message) {
    if (this.verbosity < levels[level]) return;
    for (const line of stripVTControlCharacters(String(message)).split(
      /[\r\n]+/,
    )) {
      if (line.trim()) this.console.error(`[cpi-prose ${level}] ${line}`);
    }
  }

  info(message) {
    this.log("INFO", message);
  }

  debug(message) {
    this.log("DEBUG", message);
  }

  error(message) {
    this.log("ERROR", message);
  }

  warn(message) {
    this.log("WARNING", message);
  }

  capture_warnings() {
    const previous = process.listeners("warning");
    process.removeAllListeners("warning");
    const receive = (warning) => this.debug(warning.stack ?? warning.message);
    process.on("warning", receive);
    return () => {
      process.off("warning", receive);
      for (const handler of previous) process.on("warning", handler);
    };
  }

  stream() {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const emit = (line) => {
      const progress = /^\[cpi-prose(?: INFO)?\] (.*)$/.exec(line);
      if (progress) this.info(progress[1]);
      else this.debug(line);
    };
    const drain = (text) => {
      const lines = (pending + text).split(/[\r\n]/);
      pending = lines.pop();
      for (const line of lines) emit(line);
      while (pending.length > line_limit) {
        emit(pending.slice(0, line_limit));
        pending = pending.slice(line_limit);
      }
    };
    return {
      write: (chunk) => drain(decoder.write(chunk)),
      end: () => {
        drain(decoder.end());
        emit(pending);
        pending = "";
      },
    };
  }
}
