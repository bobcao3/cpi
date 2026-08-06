import { render, renderLines } from "../extensions/lib/text.ts";

let failures = 0;
function eq(name, got, want) {
  const ok = got === want;
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${name}\n--- got ---\n${JSON.stringify(got)}\n--- want ---\n${JSON.stringify(want)}`,
    );
  } else {
    console.log(`ok   ${name}`);
  }
}

eq("interp", render("hello {{name}}!", { name: "world" }), "hello world!");

eq("unknown_var", render("[{{missing}}]", {}), "[]");

eq("triple", render("{{{name}}}", { name: "<x>" }), "<x>");

eq("section_true", render("a{{#on}}YES{{/on}}b", { on: true }), "aYESb");

eq("section_false", render("a{{#on}}YES{{/on}}b", { on: false }), "ab");

eq("inverted", render("{{^on}}NO{{/on}}", { on: false }), "NO");
eq("inverted_skip", render("{{^on}}NO{{/on}}", { on: true }), "");

eq(
  "loop_obj",
  render("{{#items}}- {{n}}\n{{/items}}", { items: [{ n: "a" }, { n: "b" }] }),
  "- a\n- b\n",
);

eq("loop_prim", render("{{#xs}}{{.}} {{/xs}}", { xs: [1, 2, 3] }), "1 2 3 ");

eq("empty_arr_sec", render("[{{#xs}}x{{/xs}}]", { xs: [] }), "[]");
eq("empty_arr_inv", render("[{{^xs}}none{{/xs}}]", { xs: [] }), "[none]");

eq("nested", render("{{#a}}A{{#b}}B{{/b}}{{/a}}", { a: { b: true } }), "AB");

eq("comment", render("a{{! this is a comment}}b", {}), "ab");

eq("dotted", render("{{user.name}}", { user: { name: "cc" } }), "cc");

eq(
  "renderLines_prune",
  renderLines(["keep", "{{#on}}yes{{/on}}", "{{#off}}no{{/off}}", "  "], {
    on: true,
    off: false,
  }).join("|"),
  "keep|yes",
);

const visionBlock =
  "You can see images.{{#vision}} Use read_media to view image files.{{/vision}}{{^vision}} You cannot see images; do not attempt to read image files.{{/vision}}";
eq(
  "vision_on",
  render(visionBlock, { vision: true }),
  "You can see images. Use read_media to view image files.",
);
eq(
  "vision_off",
  render(visionBlock, { vision: false }),
  "You can see images. You cannot see images; do not attempt to read image files.",
);

eq(
  "unknown_var_empty",
  render("a{{nope}}b{{#missing}}x{{/missing}}", {}),
  "ab",
);
let threw = false;
try {
  render("a{{#unterminated", {});
} catch {
  threw = true;
}
eq("badtag_throws", threw, true);

eq("no_escape_lt", render("{{x}}", { x: "a<b>&c" }), "a<b>&c");
eq(
  "no_escape_inline",
  render("use `sleep && true`", {}),
  "use `sleep && true`",
);
eq(
  "no_escape_search",
  render("{{x}}", { x: "<<<<<<< SEARCH" }),
  "<<<<<<< SEARCH",
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
