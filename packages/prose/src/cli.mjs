import { parseArgs } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stage_document } from "./input.mjs";
import { request } from "./client.mjs";
import { render } from "./output.mjs";
import { Logger } from "./logger.mjs";

const help = `Usage: cpi-prose [analyze] [FILE|-] [--reference FILE|DIRECTORY]
       cpi-prose status | stop
       cpi-prose cache [stats|clear]

Source files use Tree-sitter comments/docstrings; other files are text or structured JSON.
Directories collect supported source and text files recursively. Use - to read stdin.

  --reference PATH       Compare with a file or directory; cache its analysis
  --reference-id ID      Reuse a previously cached reference
  --no-tone              Skip tone scoring
  --no-style             Skip style comparison
  --no-compile           Skip model compilation
  --device DEVICE        auto, cpu, cuda, or mps
  --json                 Emit the complete structured result
  -v, --verbose          Show progress. Use -vv for diagnostics.
  -h, --help             Show this help
`;

export async function main(args = process.argv.slice(2)) {
  const logger = new Logger();
  const restore_warnings = logger.capture_warnings();
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        reference: { type: "string" },
        "reference-id": { type: "string" },
        "no-tone": { type: "boolean", default: false },
        style: { type: "boolean", default: false },
        "no-style": { type: "boolean", default: false },
        "no-compile": { type: "boolean", default: false },
        device: { type: "string" },
        json: { type: "boolean", default: false },
        verbose: { type: "boolean", short: "v", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    });
    logger.verbosity = Math.min(2, values.verbose?.length ?? 0);
    if (
      values.help ||
      positionals.length === 0 ||
      (positionals.length === 1 && positionals[0] === "analyze")
    ) {
      process.stdout.write(help);
      return;
    }
    let method = "analyze",
      file = "-",
      params = {},
      staging = null;
    if (values.style && values["no-style"])
      throw new Error("Use --style or --no-style, not both");
    if (positionals[0] === "analyze") positionals.shift();
    if (positionals[0] === "status" || positionals[0] === "stop") {
      method = positionals.shift();
      if (positionals.length)
        throw new Error(`${method} takes no file arguments`);
    } else if (positionals[0] === "cache") {
      positionals.shift();
      const action = positionals.shift() ?? "stats";
      if (!["stats", "clear"].includes(action) || positionals.length)
        throw new Error("Use cpi-prose cache stats or cpi-prose cache clear");
      method = `cache/${action}`;
    } else {
      if (positionals.length > 1)
        throw new Error(
          "Provide one input file and use --reference for the corpus",
        );
      file = positionals[0] ?? "-";
      if (values.reference && values["reference-id"])
        throw new Error("Use --reference or --reference-id, not both");
      if (file === "-" && values.reference === "-")
        throw new Error("Input and reference cannot both read stdin");
      const warn = (message) => logger.warn(message);
      staging = await mkdtemp(join(tmpdir(), "cpi-prose-"));
      try {
        logger.info(`Reading input: ${file}`);
        params.document = await stage_document(
          file,
          join(staging, "input.jsonl"),
          warn,
        );
        if (values.reference) {
          logger.info(`Reading reference: ${values.reference}`);
          params.reference = await stage_document(
            values.reference,
            join(staging, "reference.jsonl"),
            warn,
          );
        }
        params.detail = values.json;
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        staging = null;
        throw error;
      }
      if (values["reference-id"]) params.reference_id = values["reference-id"];
    }
    let result;
    try {
      result = await request(method, params, values, logger);
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
    if (result.reference)
      logger.debug(
        `Reference cache ${result.reference.cache_hit ? "hit" : "stored"}: ${result.reference.id}`,
      );
    if (result.analysis) {
      for (const name of ["tone", "style"]) {
        const component = result.analysis[name];
        if (component.status === "enabled")
          logger.debug(
            JSON.stringify({
              component: name,
              model: component.model,
              revision: component.revision,
              device: component.device,
              dtype: component.dtype,
              execution: component.execution,
              attention: component.attention,
            }),
          );
      }
      logger.debug(
        `Analysis timings: ${JSON.stringify(result.analysis.timings)}`,
      );
      if (result.analysis.clauses.status !== "enabled")
        logger.debug("Clause estimation requires an English pipeline.");
    }
    process.stdout.write(
      values.json ? JSON.stringify(result) + "\n" : render(result),
    );
  } catch (error) {
    logger.error(error.message);
    logger.debug(error.stack);
    process.exitCode = 1;
  } finally {
    await new Promise(setImmediate);
    restore_warnings();
  }
}
