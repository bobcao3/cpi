import { render, renderLines } from "../extensions/lib/text.ts";

let failures = 0;
function eq(name, got, want) {
  const ok = got === want;
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}\n--- got ---\n${JSON.stringify(got)}\n--- want ---\n${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// 1. plain interpolation
eq("interp", render("hello {{name}}!", { name: "world" }), "hello world!");

// 2. unknown var -> empty
eq("unknown_var", render("[{{missing}}]", {}), "[]");

// 3. triple brace
eq("triple", render("{{{name}}}", { name: "<x>" }), "<x>");

// 4. truthy section
eq("section_true", render("a{{#on}}YES{{/on}}b", { on: true }), "aYESb");

// 5. falsy section omitted
eq("section_false", render("a{{#on}}YES{{/on}}b", { on: false }), "ab");

// 6. inverted section
eq("inverted", render("{{^on}}NO{{/on}}", { on: false }), "NO");
eq("inverted_skip", render("{{^on}}NO{{/on}}", { on: true }), "");

// 7. array loop (object items)
eq(
  "loop_obj",
  render("{{#items}}- {{n}}\n{{/items}}", { items: [{ n: "a" }, { n: "b" }] }),
  "- a\n- b\n",
);

// 8. array loop (primitive items via {{.}})
eq("loop_prim", render("{{#xs}}{{.}} {{/xs}}", { xs: [1, 2, 3] }), "1 2 3 ");

// 9. empty array -> section omitted, inverted renders
eq("empty_arr_sec", render("[{{#xs}}x{{/xs}}]", { xs: [] }), "[]");
eq("empty_arr_inv", render("[{{^xs}}none{{/xs}}]", { xs: [] }), "[none]");

// 10. nested sections
eq(
  "nested",
  render("{{#a}}A{{#b}}B{{/b}}{{/a}}", { a: { b: true } }),
  "AB",
);

// 11. comment dropped
eq("comment", render("a{{! this is a comment}}b", {}), "ab");

// 12. dotted lookup
eq("dotted", render("{{user.name}}", { user: { name: "cc" } }), "cc");

// 13. renderLines: render each template, prune empties (falsy section -> "",
//     whitespace-only -> "")
eq(
  "renderLines_prune",
  renderLines(["keep", "{{#on}}yes{{/on}}", "{{#off}}no{{/off}}", "  "], { on: true, off: false }).join("|"),
  "keep|yes",
);

// 14. vision conditional — inline sections + inverted
const visionBlock = "You can see images.{{#vision}} Use read_media to view image files.{{/vision}}{{^vision}} You cannot see images; do not attempt to read image files.{{/vision}}";
eq("vision_on", render(visionBlock, { vision: true }), "You can see images. Use read_media to view image files.");
eq("vision_off", render(visionBlock, { vision: false }), "You can see images. You cannot see images; do not attempt to read image files.");

// 15. unknown switch interpolates to "" (mustache default); a malformed
//     (unclosed) tag throws — correct, it's a config error to surface.
eq("unknown_var_empty", render("a{{nope}}b{{#missing}}x{{/missing}}", {}), "ab");
let threw = false;
try { render("a{{#unterminated", {}); } catch { threw = true; }
eq("badtag_throws", threw, true);

// 16. HTML escaping is disabled (prompts are plain text): <, &, backticks survive.
eq("no_escape_lt", render("{{x}}", { x: "a<b>&c" }), "a<b>&c");
eq("no_escape_inline", render("use `sleep && true`", {}), "use `sleep && true`");
eq("no_escape_search", render("{{x}}", { x: "<<<<<<< SEARCH" }), "<<<<<<< SEARCH");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
