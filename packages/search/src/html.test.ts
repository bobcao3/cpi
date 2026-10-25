import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readable_html } from "./html.ts";

test("HTML extraction preserves Unicode and quoted attributes while discarding scripts and comments", () => {
  const html =
    "<p>İ café &amp; &#x1F600;</p><!-- ignore -->" +
    "<SCRIPT>if(a < b) ignored();</SCRIPTED>still hidden</SCRIPT>" +
    '<div title="1 > 0">Next &lt;value&gt;</div><style>hidden</style>' +
    "<svg/><p>Last &#65; &quot;line&quot;</p>";
  expect(readable_html(html)).toBe(
    'İ café & 😀\n\nNext <value>\n\nLast A "line"',
  );
  expect(readable_html("<p>Visible</p><script>unterminated")).toBe("Visible");
});

test("maximum-size malformed HTML completes within an isolated process deadline", async () => {
  const module = new URL("./html.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    "node",
    [
      "--input-type=module",
      "--eval",
      `
    import { readable_html } from ${JSON.stringify(module)};
    const results = [];
    for (const pattern of ["<script>", "<!--", "<"]) {
      const input = pattern.repeat(Math.ceil(2097152 / pattern.length)).slice(0, 2097152);
      const start = performance.now();
      const output = readable_html(input);
      results.push({ bytes: Buffer.byteLength(input), milliseconds: performance.now()-start, outputCharacters: output.length });
    }
    console.log(JSON.stringify(results));
  `,
    ],
    { timeout: 2000, maxBuffer: 4096 },
  );
  const results = JSON.parse(stdout);
  expect(results.map((result) => result.bytes)).toEqual([
    2097152, 2097152, 2097152,
  ]);
  expect(results.map((result) => result.outputCharacters)).toEqual([
    0, 0, 2097152,
  ]);
});
