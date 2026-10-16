import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGhostmux } from "@cpi/ghostmux/resolve";
import { visibleWidth } from "@earendil-works/pi-tui";
import sharp from "sharp";

export interface Panel {
  title: string;
  width: number;
  lines: string[];
}

const baselines = fileURLToPath(new URL("./baselines/", import.meta.url));
let artifacts: string;
let binary: string;

function terminal_frame(panels: Panel[], columns: number) {
  assert(panels.length > 0 && panels.length <= 12);
  assert(Number.isInteger(columns) && columns > 0 && columns <= 3);
  columns = Math.min(columns, panels.length);
  const column_widths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      ...panels
        .filter((_, i) => i % columns === column)
        .map((p) => p.width + 4),
    ),
  );
  const cols = column_widths.reduce((sum, width) => sum + width, 0) + 1;
  let row = 2;
  let data = "\x1b[0m\x1b[2J\x1b[H\x1b[?25l\x1b[?7l";
  const put = (x: number, y: number, line: string) => {
    data += `\x1b[${y};${x}H\x1b[0m${line}\x1b[0m`;
  };
  for (let offset = 0; offset < panels.length; offset += columns) {
    const group = panels.slice(offset, offset + columns);
    const height = Math.max(...group.map((panel) => panel.lines.length)) + 4;
    let column = 2;
    for (const [index, panel] of group.entries()) {
      assert(Number.isInteger(panel.width) && panel.width > 0);
      assert(visibleWidth(panel.title) <= panel.width);
      for (const line of panel.lines) {
        assert(
          visibleWidth(line) <= panel.width,
          `${panel.title}: component exceeds ${panel.width} cells`,
        );
      }
      put(column, row, `┌${"─".repeat(panel.width + 2)}┐`);
      put(
        column,
        row + 1,
        `│ ${panel.title}${" ".repeat(panel.width - visibleWidth(panel.title))} │`,
      );
      for (let y = 2; y < height - 1; y++) {
        put(column, row + y, "│");
        put(column + panel.width + 3, row + y, "│");
      }
      for (const [y, line] of panel.lines.entries())
        put(column + 2, row + y + 2, line);
      put(column, row + height - 1, `└${"─".repeat(panel.width + 2)}┘`);
      column += column_widths[index];
    }
    row += height + 1;
  }
  assert(
    cols <= 500 && row <= 300,
    `Screenshot exceeds Ghostmux geometry: ${cols}x${row}`,
  );
  assert(Buffer.byteLength(data) <= 1024 * 1024);
  return { cols, rows: row, data };
}

export async function screenshot(
  name: string,
  panels: Panel[],
  columns = 2,
): Promise<void> {
  binary ??= await resolveGhostmux();
  artifacts ??=
    process.env.CPI_MERMAID_SCREENSHOT_DIR ||
    (await mkdtemp(join(tmpdir(), "cpi-mermaid-screenshots-")));
  await mkdir(artifacts, { recursive: true });
  const actual = join(artifacts, `${name}.actual.png`);
  const expected = join(baselines, `${name}.avif`);
  const frame = terminal_frame(panels, columns);
  const requests = [
    { op: "feed", data: frame.data },
    { op: "screenshot", path: actual, font_size: 14 },
    { op: "quit" },
  ];
  const input =
    requests.map((request) => JSON.stringify(request)).join("\n") + "\n";
  assert(Buffer.byteLength(input) <= 1024 * 1024);
  const child = spawnSync(
    binary,
    [
      "--protocol",
      "--cols",
      String(frame.cols),
      "--rows",
      String(frame.rows),
      "--scrollback-bytes",
      "1048576",
    ],
    {
      input,
      encoding: "utf8",
      timeout: 15000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, requests.length);
  for (const response of responses) assert.equal(response.ok, true);
  assert.equal(responses[1].path, actual);
  const decoded = await sharp(actual)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (process.env.CPI_MERMAID_UPDATE_SCREENSHOTS === "1") {
    await mkdir(baselines, { recursive: true });
    await sharp(actual)
      .avif({ lossless: true, chromaSubsampling: "4:4:4", effort: 9 })
      .toFile(expected);
    return;
  }
  let reference: Buffer;
  try {
    reference = await readFile(expected);
  } catch (error) {
    throw new Error(
      `Missing reviewed baseline ${expected}. Review ${actual}, then explicitly generate baselines with CPI_MERMAID_UPDATE_SCREENSHOTS=1.`,
      { cause: error },
    );
  }
  const baseline = await sharp(reference)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual(
    decoded.info,
    baseline.info,
    `Screenshot geometry changed. Actual: ${actual}; baseline: ${expected}`,
  );
  if (!decoded.data.equals(baseline.data)) {
    const difference = join(artifacts, `${name}.diff.png`);
    await sharp(actual)
      .composite([{ input: reference, blend: "difference" }])
      .png()
      .toFile(difference);
    assert.fail(
      `Screenshot pixels changed. Actual: ${actual}; baseline: ${expected}; difference: ${difference}`,
    );
  }
}
