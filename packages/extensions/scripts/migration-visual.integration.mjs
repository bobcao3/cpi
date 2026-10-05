import "@cpi/cli/bootstrap";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { piExecutableOnPath } from "../bin/host-pi.mjs";
import { fixture } from "./fast-fixture.mjs";

const code = [
  'const target = "#editor";',
  "const report = await tools.migration_report({ target });",
  "text(report);",
  'text("Literal stdout: hello \\\"world\\\"\\nC:\\\\tmp\\n");',
  'store("migration", report);',
  "return { installed: true };",
].join("\n");
let prompt = 0;
await fixture(
  async ({ directory, requests }) => {
    const extension = join(directory, "visual-fixture.mjs");
    await writeFile(
      extension,
      `export default function(pi) {
    pi.registerTool({ name: "migration_report", label: "migration_report", description: "Report installed-package verification data", defaultActive: true,
      parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      outputSchema: { type: "object", properties: { document: { type: "object" }, enabled: { type: "boolean" } } },
      async execute(_id, args) {
        return { content: [{ type: "text", text: "CLI and TUI migration verified" }],
          structuredContent: { document: { title: "Migration verified", target: args.target, "a.b": { ready: true } }, enabled: false } };
      }
    });
  }`,
    );
    const child = spawn(
      process.execPath,
      [
        piExecutableOnPath(),
        "--approve",
        "--no-session",
        "--no-context-files",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "-e",
        extension,
      ],
      {
        cwd: directory,
        stdio: "inherit",
        env: {
          ...process.env,
          CPI_CODING_AGENT_DIR: directory,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          NODE_OPTIONS: "",
          NODE_PATH: "",
        },
      },
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
    try {
      const status = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => resolve(code));
      });
      if (status !== 0 || requests.length < 4)
        throw new Error(
          `Visual run ended before both execution paths completed: status=${status}, requests=${requests.length}`,
        );
      console.log(
        `Visual CLI exercised CodeMode and direct-tool execution in ${requests.length} HTTP requests.`,
      );
    } finally {
      clearTimeout(timer);
    }
  },
  100,
  undefined,
  (requests) => {
    if (requests.length % 2 === 0) return undefined;
    prompt++;
    return {
      type: "function_call",
      id: `fc_visual_${requests.length}`,
      call_id: `visual_${requests.length}`,
      name: prompt % 2 ? "codemode" : "migration_report",
      arguments: JSON.stringify(prompt % 2 ? { code } : { target: "#footer" }),
      status: "completed",
    };
  },
);
process.exit(0);
