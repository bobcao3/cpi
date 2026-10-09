import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piExecutableOnPath } from "../bin/host-pi.mjs";
import { fixture } from "./fast-fixture.mjs";

const name = `cpi-object-tree-${process.pid}`;
const record = join(tmpdir(), `${name}.ansi`);
const tmux = (...args) =>
  execFileSync("tmux", args, { encoding: "utf8", timeout: 5000 });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const capture = () => tmux("capture-pane", "-t", name, "-p");
const send = (text) => {
  tmux("send-keys", "-t", name, "-l", text);
  tmux("send-keys", "-t", name, "Enter");
};
async function until(check) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const screen = capture();
    if (check(screen)) return screen;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out:\n${capture()}`);
}
function click(pattern) {
  const lines = capture().split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  assert(index >= 0, `Missing tree row ${pattern}:\n${lines.join("\n")}`);
  const column = lines[index].search(/[▸▾]/) + 1;
  assert(column > 0);
  tmux(
    "send-keys",
    "-t",
    name,
    "-l",
    `\x1b[<0;${column};${index + 1}M\x1b[<0;${column};${index + 1}m`,
  );
}
const stdout =
  JSON.stringify({ quoted: 'hello "world"', path: "C:\\tmp" }, null, 2) + "\n";
const mcp_text =
  '### Ran Playwright code\n```js\nawait page.setViewportSize({ width: 390, height: 844 });\n```\n### Result\n{"bounds":{"width":390,"document":390}}';
const script = [
  'const target = "#tma video";',
  'const code = "async (page) => { return page.title(); }";',
  "const result = await tools.tree_fixture({target, code});",
  `text(await tools.mcp__fixture__run_code({})); text(${JSON.stringify(stdout)});`,
  "const retained = true;",
  'store("tree-fixture", retained);',
].join("\n");
await fixture(
  async ({ directory, requests }) => {
    const extension = join(directory, "tree-fixture.mjs");
    await writeFile(
      extension,
      `export default function(pi) {
    pi.registerTool({ name: "tree_fixture", label: "tree_fixture", description: "Return structured renderer fixture data", defaultActive: true,
      parameters: { type: "object", properties: { target: { type: "string" }, code: { type: "string" } }, required: ["target", "code"] },
      outputSchema: { type: "object", properties: {
        content: { type: "array", items: { type: "object", properties: { type: { type: "string" }, text: { type: "string" } } } },
        metadata: { type: "object", properties: { page: { type: "object", properties: { title: { type: "string" }, data: { type: "object", properties: { enabled: { type: "boolean" } } } } } } }
      } },
      async execute(_id, args) {
        const payload = { content: [{ type: "text", text: "### Result\\nEXPANDED_TREE_CONTENT\\n" + args.target }], metadata: { page: { title: "Rubin", data: { enabled: false } } } };
        return { content: [{ type: "text", text: JSON.stringify(JSON.stringify(payload)) }], structuredContent: payload, details: undefined };
      }
    });
    pi.registerTool({ name: "mcp__fixture__run_code", label: "MCP text output", description: "Return an MCP text response for renderer verification", defaultActive: true,
      parameters: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { content: { type: "array", items: { type: "object" } }, isError: { type: "boolean" }, _meta: { type: "object" } }, required: ["content"] },
      async execute() {
        const content = [{ type: "text", text: ${JSON.stringify(mcp_text)} }];
        return { content, structuredContent: { content }, details: undefined };
      }
    });
  }`,
    );
    tmux(
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "120",
      "-y",
      "55",
      "-c",
      directory,
      "/bin/sh",
    );
    try {
      await writeFile(record, "");
      tmux("pipe-pane", "-o", "-t", name, `cat > ${quote(record)}`);
      send(
        `env NODE_OPTIONS=${quote(process.env.NODE_OPTIONS ?? "")} NODE_PATH='' PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 CPI_CODING_AGENT_DIR=${quote(directory)} ${quote(process.execPath)} ${quote(piExecutableOnPath())} --approve --no-session --no-context-files --provider openai --model gpt-5.5 -e ${quote(extension)}`,
      );
      await until((screen) => screen.includes("Subagent model guide"));
      tmux("send-keys", "-t", name, "Escape");
      await until((screen) => !screen.includes("Subagent model guide"));
      send("Render the fixture");
      const collapsed = await until(
        (screen) => requests.length >= 2 && /^\s*OK\s*$/m.test(screen),
      );
      assert.match(
        collapsed,
        /✓ Code mode: JavaScript · 6 lines · [\d.]+s · ctrl\+o to expand/,
      );
      assert.match(collapsed, /✓ ▸ tree_fixture target="#tma video" code=/);
      assert.match(collapsed, /more code lines · ctrl\+o to expand/);
      assert.match(collapsed, /▸ output/);
      assert.doesNotMatch(collapsed, /EXPANDED_TREE_CONTENT|^\s*[\d.]+s\s*$/m);
      click(/▸ tree_fixture/);
      await until((screen) => /▸ result:/.test(screen));
      click(/▸ arguments:/);
      await until((screen) => /target:\s+"#tma video"/.test(screen));
      click(/▸ result:/);
      await until((screen) => screen.includes("metadata.page:"));
      click(/▸ metadata.page:/);
      await until((screen) => /data.enabled:\s+false/.test(screen));
      click(/▸ content\[0\]/);
      await until((screen) => /▸ text:/.test(screen));
      click(/▸ text:/);
      const expanded = await until((screen) =>
        screen.includes("EXPANDED_TREE_CONTENT"),
      );
      assert.match(expanded, /title:\s+Rubin/);
      assert.match(expanded, /data.enabled:\s+false/);
      click(/▸ output/);
      const stdout_view = await until((screen) =>
        (mcp_text + "\n" + stdout)
          .trimEnd()
          .split("\n")
          .every((line) => screen.includes(`│ ${line}`)),
      );
      tmux("resize-window", "-t", name, "-x", "70", "-y", "55");
      await until((screen) =>
        screen.includes('│   "quoted": "hello \\"world\\"",'),
      );
      tmux("resize-window", "-t", name, "-x", "120", "-y", "55");
      click(/▾ output/);
      console.log(stdout_view);
      tmux("resize-window", "-t", name, "-x", "70", "-y", "55");
      await until((screen) => screen.includes("EXPANDED_TREE_CONTENT"));
      tmux("resize-window", "-t", name, "-x", "120", "-y", "55");
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (screen) =>
          screen.includes("to collapse") &&
          screen.includes('store("tree-fixture", retained);'),
      );
      tmux("send-keys", "-t", name, "C-o");
      await until(
        (screen) =>
          screen.includes("to expand") &&
          !screen.includes("EXPANDED_TREE_CONTENT"),
      );
      send("/reload");
      await until((screen) => /Reloaded/.test(screen));
      send("Render the fixture again");
      const replay = await until(
        (screen) =>
          requests.length >= 4 &&
          (screen.match(/✓ ▸ tree_fixture/g) ?? []).length >= 2,
      );
      assert.doesNotMatch(replay, /Extension issues|Error executing/);
      tmux("pipe-pane", "-t", name);
      assert(
        (await readFile(record, "utf8")).includes("EXPANDED_TREE_CONTENT"),
      );
      console.log(
        `Live object tree passed collapsed calls, source preview, header timing, nested mouse expansion, resize, Ctrl-O, and reload. Recording: ${record}`,
      );
    } finally {
      tmux("kill-session", "-t", name);
    }
  },
  100,
  undefined,
  (requests) =>
    requests.length % 2
      ? {
          type: "function_call",
          id: `fc_tree_${requests.length}`,
          call_id: `tree_${requests.length}`,
          name: "codemode",
          arguments: JSON.stringify({ code: script }),
          status: "completed",
        }
      : undefined,
);
process.exit(0);
