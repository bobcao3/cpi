import {
  createTreeState,
  ToolTreeComponent,
  type ToolTreeSnapshot,
} from "../tree/index.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { getModel } from "@earendil-works/pi-ai/compat";
import sharp from "sharp";
import {
  getThemeByName,
  initTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { readTool } from "./tool.ts";
import { renderRanges } from "./viewer.ts";
import { getCwd, setCwd } from "../lib/cwd.ts";
import { expandSourcePath } from "../lib/skill-paths.ts";

initTheme("dark");
const theme = getThemeByName("dark")!;
const visible = (component: ToolTreeComponent) =>
  component.render(120).map(stripVTControlCharacters).join("\n");
const context = (id: string, cwd: string) => ({
  toolCallId: id,
  cwd,
  state: {},
  viewState: createTreeState(),
  invalidate() {},
});

test("real reads stay compact and reveal content and errors independently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "read-tree-"));
  const path = join(cwd, "sample.txt");
  const initial = getCwd();
  setCwd(cwd);
  try {
    await writeFile(path, "secret file contents\n");
    const result = await readTool.execute(
      "read-one",
      { path },
      undefined,
      undefined,
      { cwd } as ExtensionContext,
    );
    const failed = await readTool.execute(
      "read-two",
      { path: join(cwd, "missing.txt") },
      undefined,
      undefined,
      { cwd } as ExtensionContext,
    );
    const successContext = context("read-one", cwd);
    const errorContext = context("read-two", cwd);
    const nodes = [
      ...readTool.renderTree(
        { args: { path }, result, phase: "complete", isError: false },
        theme,
        successContext,
      ),
      ...readTool.renderTree(
        {
          args: { path: "missing.txt" },
          result: failed,
          phase: "complete",
          isError: true,
        },
        theme,
        errorContext,
      ),
    ];
    const component = new ToolTreeComponent(nodes, theme, {
      state: successContext.viewState,
    });
    assert.ok(!visible(component).includes("secret file contents"));
    successContext.viewState.open.set("read-one/preview", true);
    component.reveal("read-one/preview");
    assert.ok(visible(component).includes("secret file contents"));
    assert.ok(!component.getVisibleIds().includes("read-two/error"));
    component.reveal("read-two/error");
    successContext.viewState.open.set("read-two/error", true);
    assert.ok(visible(component).includes("missing.txt"));
    successContext.viewState.open.set("read-one", false);
    component.update(nodes, theme);
    assert.ok(!visible(component).includes("secret file contents"));
    assert.ok(component.getVisibleIds().includes("read-two/error"));
    for (const [body, expected] of [
      ["", 0],
      ["one\ntwo", 2],
      ["line\n".repeat(200), 200],
      ["line\n".repeat(250), 200],
    ] as const) {
      await writeFile(path, body);
      const read = await readTool.execute(
        "counts",
        { path },
        undefined,
        undefined,
        { cwd } as ExtensionContext,
      );
      assert.equal((read.details as { lineCount: number }).lineCount, expected);
      const row = new ToolTreeComponent(
        readTool.renderTree(
          { args: { path }, result: read, phase: "complete", isError: false },
          theme,
          context("counts", cwd),
        ),
        theme,
      );
      assert.ok(visible(row).includes(`${expected} lines`));
      if (body === "line\n".repeat(200))
        assert.equal(read.content[0]?.text, body);
    }
  } finally {
    setCwd(initial);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("range bodies and full query survive updates without opening sibling ranges", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "read-ranges-"));
  const path = join(cwd, "ranges.ts");
  try {
    await writeFile(
      path,
      "const first = 1;\nconst hidden = 2;\nconst third = 3;\n",
    );
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const ranges = [
      [1, 1],
      [3, 3],
    ];
    const text = renderRanges(lines, ranges, "{n} lines omitted");
    const ctx = context("ranges", cwd);
    const snapshot: ToolTreeSnapshot = {
      args: { path, query: "find constants\nand preserve full query" },
      result: {
        content: [{ type: "text", text }],
        details: { kind: "view", text, ranges, summary: "Two constants" },
      },
      phase: "complete",
      isError: false,
    };
    const component = new ToolTreeComponent(
      readTool.renderTree(snapshot, theme, ctx),
      theme,
      { state: ctx.viewState },
    );
    component.reveal("ranges/ranges/1-1");
    ctx.viewState.open.set("ranges/ranges/1-1", true);
    assert.ok(visible(component).includes("1|const first = 1;"));
    assert.ok(!visible(component).includes("const third = 3;"));
    component.update(
      readTool.renderTree({ ...snapshot, durationMs: 17 }, theme, ctx),
      theme,
    );
    assert.ok(visible(component).includes("1|const first = 1;"));
    assert.ok(!visible(component).includes("const third = 3;"));
    component.reveal("ranges/query");
    ctx.viewState.open.set("ranges/query", true);
    assert.ok(visible(component).includes("and preserve full query"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prefixed read paths retain real URLs and image reads retain attachments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "read-media-"));
  const initial = getCwd();
  setCwd(cwd);
  setCapabilityOverrides({ hyperlinks: true });
  try {
    const path = "$CPI_HARNESS_SRC/LICENSE";
    const absolute = expandSourcePath(path);
    const result = await readTool.execute(
      "prefix",
      { path },
      undefined,
      undefined,
      { cwd } as ExtensionContext,
    );
    const nodes = readTool.renderTree(
      { args: { path }, result, phase: "complete", isError: false },
      theme,
      context("prefix", cwd),
    );
    const component = new ToolTreeComponent(nodes, theme);
    const link = `\x1b]8;;${pathToFileURL(absolute).href}\x1b\\`;
    assert.ok(component.render(160).join("\n").includes(link));
    setCapabilityOverrides({ hyperlinks: false });
    component.update(
      readTool.renderTree(
        { args: { path }, result, phase: "complete", isError: false },
        theme,
        context("prefix", cwd),
      ),
      theme,
    );
    assert.ok(!component.render(160).join("\n").includes("\x1b]8;"));
    const imagePath = join(cwd, "pixel.png");
    const bytes = await sharp({
      create: { width: 2, height: 3, channels: 3, background: "#dc2844" },
    })
      .png()
      .toBuffer();
    await writeFile(imagePath, bytes);
    const image = await readTool.execute(
      "image",
      { path: imagePath },
      undefined,
      undefined,
      {
        cwd,
        model: getModel("anthropic", "claude-sonnet-4-5"),
      } as ExtensionContext,
    );
    const attachment = image.content.find((part) => part.type === "image");
    assert.ok(attachment, JSON.stringify(image));
    const dimensions = await sharp(
      Buffer.from(attachment.data, "base64"),
    ).metadata();
    assert.equal(dimensions.width, 2);
    assert.equal(dimensions.height, 3);
    const imageTree = new ToolTreeComponent(
      readTool.renderTree(
        {
          args: { path: imagePath },
          result: image,
          phase: "complete",
          isError: false,
        },
        theme,
        context("image", cwd),
      ),
      theme,
      { showImages: false },
    );
    assert.ok(visible(imageTree).includes("Image"));
    assert.ok(!visible(imageTree).includes(attachment.data));
    assert.ok(imageTree.getVisibleIds().includes("image/image/0"));
    const directory = await readTool.execute(
      "directory",
      { path: cwd },
      undefined,
      undefined,
      { cwd } as ExtensionContext,
    );
    const directoryContext = context("directory", cwd);
    const directoryTree = new ToolTreeComponent(
      readTool.renderTree(
        {
          args: { path: cwd },
          result: directory,
          phase: "complete",
          isError: false,
        },
        theme,
        directoryContext,
      ),
      theme,
      { state: directoryContext.viewState },
    );
    directoryTree.reveal("directory/preview");
    directoryContext.viewState.open.set("directory/preview", true);
    assert.ok(visible(directoryTree).includes("pixel.png"));
  } finally {
    setCapabilityOverrides({});
    setCwd(initial);
    await rm(cwd, { recursive: true, force: true });
  }
});
