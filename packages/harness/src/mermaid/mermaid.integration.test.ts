import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCapabilities,
  setCapabilityOverrides,
} from "@earendil-works/pi-tui";
import {
  DefaultResourceLoader,
  initTheme,
  SettingsManager,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import mermaid_extension from "./index.ts";
import { render_mermaid } from "./engine.ts";
import { check_mermaid_file } from "./check.ts";
import { applyPatchFile } from "../llm-editor/file-edit.ts";
import { loadDefaultConfig } from "../lib/config.ts";
import { getCwd, setCwd } from "../lib/cwd.ts";
import { assistant, message, panel } from "./test/assistant.ts";
import { branches, chart, families, fence, flow } from "./test/fixtures.ts";
import { screenshot, type Panel } from "./test/screenshots.ts";

let directory: string;
let previous_cwd: string;
let original_capabilities: ReturnType<typeof getCapabilities>;
let original_colorfgbg: string | undefined;
let transformers: MarkdownTransformer[];
const defaults = loadDefaultConfig().mermaid!;

async function configuration(mermaid = defaults) {
  await writeFile(
    join(directory, ".cpi", "cpi-config.json"),
    JSON.stringify({ mermaid }),
  );
}

const view = (title: string, text: string, width = 72) =>
  panel(assistant(transformers), title, text, width);

beforeAll(async () => {
  previous_cwd = getCwd();
  original_capabilities = getCapabilities();
  original_colorfgbg = process.env.COLORFGBG;
  process.env.COLORFGBG = "15;0";
  setCapabilityOverrides({ images: null, trueColor: true, hyperlinks: false });
  initTheme("dark");
  directory = await mkdtemp(join(tmpdir(), "cpi-mermaid-integration-"));
  setCwd(directory);
  await mkdir(join(directory, ".cpi"));
  await configuration();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [mermaid_extension],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  transformers = loaded.extensions.flatMap((extension) =>
    extension.markdownTransformer ? [extension.markdownTransformer] : [],
  );
  expect(transformers).toHaveLength(1);
}, 30000);

afterAll(async () => {
  if (previous_cwd) setCwd(previous_cwd);
  if (original_capabilities) setCapabilityOverrides(original_capabilities);
  if (original_colorfgbg === undefined) delete process.env.COLORFGBG;
  else process.env.COLORFGBG = original_colorfgbg;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("diagram families render through the loaded extension and Pi assistant", async () => {
  await screenshot(
    "families",
    families.map(([title, source]) => view(title, fence(source))),
  );
}, 60000);

for (const horizontal of [false, true]) {
  test(`XY ${horizontal ? "horizontal" : "vertical"} bar, line and combined charts`, async () => {
    await screenshot(
      `xy-${horizontal ? "horizontal" : "vertical"}`,
      ["bar", "line", "combined"].map((series) =>
        view(
          `${series}: quoted and Unicode labels`,
          fence(chart(series as "bar" | "line" | "combined", horizontal)),
          66,
        ),
      ),
      3,
    );
  }, 60000);
}

for (const width of [72, 164]) {
  test(`complete reported XY chart at ${width} columns`, async () => {
    const source = await readFile(
      new URL("./test/reported-chart.mmd", import.meta.url),
      "utf8",
    );
    await screenshot(
      `reported-${width}`,
      [view(`Reported chart: ${width} columns`, fence(source), width)],
      1,
    );
  }, 60000);
}

test("quoted chart categories and malformed series remain readable", async () => {
  const source = [
    "xychart-beta",
    'title "Categories with commas, brackets, quotes and combining characters"',
    `x-axis ${JSON.stringify(["North, Inc.", "South [West]", 'Quoted "value"', "Cafe\u0301"])}`,
    'y-axis "Count" 0 --> 12',
    "bar [2, 6, 8, 11]",
  ].join("\n");
  await screenshot(
    "xy-labels-and-validation",
    [
      view("Quoted categories and exact values", fence(source), 112),
      view(
        "Mismatched category and value counts",
        fence("xychart-beta\nx-axis [one, two]\nbar [1]"),
        64,
      ),
      view(
        "Nonfinite values fail safely",
        fence("xychart-beta\nx-axis [one]\nbar [Infinity]"),
        64,
      ),
    ],
    3,
  );
}, 60000);

test("Unicode junctions, inner padding and terminal color modes", async () => {
  const panels: Panel[] = [];
  try {
    for (const trueColor of [true, false]) {
      setCapabilityOverrides({ images: null, trueColor, hyperlinks: false });
      const mode = trueColor ? "truecolor" : "256-color";
      const result = render_mermaid(branches, 112);
      expect(result.error).toBeUndefined();
      expect(result.text).toBeDefined();
      panels.push({
        title: `${mode}: production renderer`,
        width: 112,
        lines: result.text!.split("\n"),
      });
      panels.push(
        view(
          `${mode}: Markdown arrows and wide cells`,
          [
            fence("flowchart LR\nA[C++] --> B[Output]"),
            fence("flowchart BT\nA[Source] --> B[Target]"),
            fence("flowchart LR\nA[界面] --> B[結果]"),
          ].join("\n\n"),
          72,
        ),
      );
    }
    for (const trueColor of [true, false]) {
      setCapabilityOverrides({ images: null, trueColor, hyperlinks: false });
      panels.push(
        view(
          `${trueColor ? "truecolor" : "256-color"}: category colors`,
          fence(chart("bar")),
          72,
        ),
      );
    }
    await screenshot("junctions-and-colors", panels);
  } finally {
    setCapabilityOverrides({
      images: null,
      trueColor: true,
      hyperlinks: false,
    });
  }
}, 60000);

test("project layout configuration invalidates cached diagrams", async () => {
  const panels: Panel[] = [];
  try {
    panels.push(view("Default layout", fence(flow), 84));
    await configuration({
      ...defaults,
      compact: false,
      paddingX: 6,
      paddingY: 5,
      boxBorderPadding: 2,
    });
    panels.push(view("Padded project layout", fence(flow), 84));
    panels.push(
      view(
        "Wide labels compact to fit",
        fence("flowchart LR\nA[界面输入] --> B[结果输出]"),
        32,
      ),
    );
    await configuration({
      ...defaults,
      paddingX: 1000000,
      paddingY: -1,
      boxBorderPadding: 1000000,
    });
    panels.push(view("Invalid settings use defaults", fence(flow), 84));
    await configuration();
    panels.push(view("Restored defaults", fence(flow), 84));
    await screenshot("layout-configuration", panels);
  } finally {
    await configuration();
  }
}, 60000);

test("local embeds, reference images, literals and file changes", async () => {
  const path = join(directory, "chart file.mmd");
  await writeFile(path, chart("combined"));
  const source = "Before\n\n![](chart%20file.mmd)\n\nAfter";
  const panels = [view("Local percent-encoded filename", source, 84)];
  panels.push(
    view(
      "Reference image and CRLF fence",
      `[chart]: chart%20file.mmd\r\n\r\n![][chart]\r\n\r\n${fence(flow).replaceAll("\n", "\r\n")}`,
      84,
    ),
  );
  await writeFile(path, flow);
  panels.push(view("Same path after a real file edit", source, 84));
  panels.push(
    view(
      "Literal examples and remote rejection",
      [
        "`![](chart%20file.mmd)`",
        "```text\n![](chart%20file.mmd)\n```",
        "An ordinary image: ![plot](100%.png)",
        "![](https://example.invalid/chart.mmd)",
      ].join("\n\n"),
      84,
    ),
  );
  await screenshot("file-embeds", panels);
}, 60000);

test("one assistant renders an open fence, closure, failure and final abort", async () => {
  const component = assistant(transformers);
  const open = `Before\n\n\`\`\`mmd\n${flow}\n`;
  const closed = open + "```\n\nMore text is still arriving.";
  const failed = closed + "\n\n```mmd\nunknownDiagram\nA\n```";
  const aborted = failed + "\n\n```mmd\nflowchart TD\nA[Unfinished]";
  const panels = [
    panel(component, "1. Open fence, still streaming", open, 76, true),
    panel(component, "2. Closing fence, still streaming", closed, 76, true),
    panel(component, "3. Failed fence, still streaming", failed, 76, true),
    panel(
      component,
      "4. Final aborted open fence",
      aborted,
      76,
      false,
      "aborted",
    ),
  ];
  await screenshot("assistant-streaming", panels);
}, 60000);

test("fence delimiters, narrow placeholders and literal thinking", async () => {
  const panels: Panel[] = [];
  for (const [opening, closing] of [
    ["````", "`````"],
    ["~~~", "~~~"],
    ["   ```", "   ```"],
  ]) {
    const component = assistant(transformers);
    const open = `${opening}mmd\n${flow}\n`;
    panels.push(panel(component, `${opening.trim()} open`, open, 52, true));
    panels.push(
      panel(
        component,
        `${closing.trim()} closed while streaming`,
        open + closing,
        52,
        true,
      ),
    );
  }
  panels.push(
    panel(
      assistant(transformers),
      "Short closing fence stays open",
      `\`\`\`\`mmd\n${flow}\n\`\`\``,
      52,
      true,
    ),
  );
  panels.push(
    panel(
      assistant(transformers),
      "Trailing closing text stays open",
      `\`\`\`mmd\n${flow}\n\`\`\` trailing text`,
      52,
      true,
    ),
  );
  const tiny = panel(
    assistant(transformers),
    "",
    `\`\`\`mmd\n${flow}`,
    12,
    true,
  );
  panels.push({ ...tiny, title: "12-cell open placeholder", width: 52 });
  const fallback = view("", fence(chart("bar")), 12);
  panels.push({ ...fallback, title: "12-cell chart fallback", width: 52 });
  const literal = assistant(transformers);
  literal.updateContent(
    {
      ...message("Visible answer"),
      content: [
        { type: "thinking", thinking: fence(flow) },
        { type: "text", text: "Visible answer" },
      ],
    },
    true,
  );
  panels.push({
    title: "Thinking retains literal Mermaid",
    width: 52,
    lines: literal.render(52),
  });
  panels.push(
    view("Non-Mermaid code stays literal", "```text\n```mmd\n" + flow, 52),
  );
  await screenshot("fence-boundaries", panels, 3);
}, 60000);

test("real writes and patches produce diagnostics and repaired embedded diagrams", async () => {
  const path = join(directory, "checked.mmd");
  await writeFile(path, "unknownDiagram\nA");
  const diagnostics = await check_mermaid_file(path);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    severity: "error",
    source: "mermaid",
    file: path,
    startLine: 1,
  });
  const panels = [view("Invalid local file", "![](checked.mmd)", 76)];
  const patched = await applyPatchFile(path, {
    cwd: directory,
    patch: "@@\n-unknownDiagram\n-A\n+flowchart LR\n+A[Start] --> B[Finish]",
    fuzzyMatch: false,
  });
  expect(patched.ok).toBe(true);
  expect(await check_mermaid_file(path)).toEqual([]);
  panels.push(
    view("Repaired file after production patch", "![](checked.mmd)", 76),
  );
  const document = join(directory, "explanation.md");
  await writeFile(document, "# Explanation\n\n![](missing.mmd)\n");
  const missing = await check_mermaid_file(document);
  expect(missing[0]).toMatchObject({
    severity: "error",
    file: document,
    startLine: 3,
  });
  panels.push(
    view(
      "Unsupported family fallback",
      fence("block-beta\ncolumns 2\na b"),
      76,
    ),
  );
  panels.push(
    view(
      "Control characters fail safely",
      fence("flowchart LR\nA[\x1b[2J] --> B"),
      76,
    ),
  );
  await screenshot("diagnostics-and-repair", panels);
}, 60000);
