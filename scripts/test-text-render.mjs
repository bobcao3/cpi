import { render, loadText, textPath } from "../extensions/lib/text.ts";

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

// 13. shell commonGuidelines parity: build the real TOML + render for both
//    availability states and compare against the hand-rolled inline array.
const T = loadText("shell", textPath("shell"));
const maxWaitfor = 30;
const maxPreview = 500;
function renderGuidelines(avail) {
  const ctx = {
    max_waitfor: maxWaitfor,
    max_preview_lines: maxPreview,
    fd: avail.fd,
    rg: avail.rg,
    shuck: avail.shuck,
    tree_sitter: avail.treeSitter,
  };
  return render(T.guidelines.sh, ctx).split("\n");
}

const wantAll = [
  "Each sh call = fresh `bash -c`. No session reuse; env/cwd/shell state don't persist.",
  "For sh, always pass a short `description` parameter (a few words) explaining the command's purpose; sh_repeat_until uses `describe`.",
  "`!!` as the `command` replays the previous sh command regardless of its exit status or lint/schema rejection; use it to retry after a transient error or after fixing unrelated args (head/tail/description) without retyping the command.",
  `Keep waitfor <=${maxWaitfor}s. On overflow, sh returns PID + partial output.`,
  `Set sh tool's native head or tail argument, instead of piping to head/tail, to cap preview output to first/last N lines (default & max: ${maxPreview})`,
  "Signal a background shell via sh_signal with its PID; send SIGKILL to terminate.",
  "A completion notification fires when a background shell finishes; you may yield control while waiting.",
  "Do not use alarm to poll a backgrounded shell; a completion notification fires on its own.",
  "Avoid polling, but if you really have to, use the `alarm` tool instead of a long `sleep &&` command.",
  "If a background shell completes and no follow-up is needed, simply invoke wait_any.",
  "Search files with `$ fd` not `$ find`: fd [OPTS] [-H] [-I] [pattern] [path]...",
  "Search content with `$ rg` not `$ grep`: rg [OPTS] [--hidden] [--no-ignore] PATTERN [path]...",
  "Every `sh` command is auto-linted by the shell linter before execution. Errors block; fix and retry. Warnings surface to you only.",
  "Editing commands trigger LSP auto-lint when a session is up; else run `lsp start`.",
];
eq("guidelines_all_on", renderGuidelines({ fd: true, rg: true, shuck: true, treeSitter: true }).join("\n"), wantAll.join("\n"));

const wantNone = wantAll.slice(0, 10).concat(wantAll.slice(13));
eq("guidelines_all_off", renderGuidelines({ fd: false, rg: false, shuck: false, treeSitter: false }).join("\n"), wantNone.join("\n"));

// 14. description parity
eq(
  "description",
  render(T.sh.description, { max_waitfor: maxWaitfor }),
  `Run a command via \`bash -c\`. Stateless: no env/cwd persistence. If the command runs longer than \`waitfor\`, sh backgrounds it and returns an id for signalling. Maximum waitfor is ${maxWaitfor}s.`,
);

// 15. sh_signal / sh_background_ps parity (static, render is pass-through)
eq("sh_signal_desc", render(T.sh_signal.description, {}), "Signal a background shell command by its PID (sh-returned). Send SIGKILL to terminate background shell process-group.");
eq("sh_signal_snippet", T.sh_signal.prompt_snippet, "Signal background shell commands");
eq("sh_bg_desc", render(T.sh_background_ps.description, {}), "List active background shells and repeat_until monitors.");
eq("sh_bg_guidelines", render(T.guidelines.sh_background_ps, {}).split("\n").join("\n"), "Use sh_background_ps to check running background shells and monitors.");

// 16. vision conditional — the global config switch case. A system-prompt
//     transform would render this per-turn against { vision: ctx.model?.input.includes("image") }.
const visionBlock = "You can see images.{{#vision}} Use read_media to view image files.{{/vision}}{{^vision}} You cannot see images; do not attempt to read image files.{{/vision}}";
eq("vision_on", render(visionBlock, { vision: true }), "You can see images. Use read_media to view image files.");
eq("vision_off", render(visionBlock, { vision: false }), "You can see images. You cannot see images; do not attempt to read image files.");

// 17. unknown switch interpolates to "" (mustache default); a malformed
//     (unclosed) tag throws — correct, it's a config error to surface. The
//     system-prompt owner (core.ts) try/catches transforms, so this can never
//     blank the system prompt.
eq("unknown_var_empty", render("a{{nope}}b{{#missing}}x{{/missing}}", {}), "ab");
let threw = false;
try { render("a{{#unterminated", {}); } catch { threw = true; }
eq("badtag_throws", threw, true);

// 18. HTML escaping is disabled (prompts are plain text): <, &, backticks survive.
eq("no_escape_lt", render("{{x}}", { x: "a<b>&c" }), "a<b>&c");
eq("no_escape_inline", render("use `sleep && true`", {}), "use `sleep && true`");

// 19. Per-tool parity for all migrated extensions (description/snippet/guidelines).
function checkTool(id, wantDesc, wantSnippet, wantGuidelines) {
  const T = loadText(id, textPath(id));
  eq(id + "_desc", render(T.tool.description, {}), wantDesc);
  eq(id + "_snippet", T.tool.prompt_snippet, wantSnippet);
  eq(id + "_guidelines", render(T.guidelines.bullets, {}).split("\n").join("\n"), wantGuidelines.join("\n"));
}

checkTool("alarm",
  "Schedule a one-shot alarm to wake the model at a future time, or cancel active alarms. Provide either relative_seconds (seconds from now) or target_time (ISO 8601 or Unix epoch seconds). Pass cancel=true or cancel=<alarm_id> to cancel. When the alarm fires, a notification is sent to wake the model.",
  "Schedule future wake-up alarms for the model",
  ["Use alarm when the user wants to be reminded or woken after a delay or at a specific time.",
   "For alarm, provide exactly one of relative_seconds or target_time, not both.",
   "Pass cancel=true to cancel all active alarms, or cancel=<alarm_id> to cancel a specific alarm.",
   "When an alarm fires and no follow-up is needed, simply invoke wait_any."]);

checkTool("lsp",
  "Manage LSP sessions: list_sessions, start (resolve project + provision), stop, check (file diagnostics or full-package CLI check).",
  "LSP sessions: start/check/stop",
  ["`lsp start file=<path>` starts a session for the file's project; `lsp check file=<path>` auto-starts and returns diagnostics.",
   "`lsp start file=<path> env=<dotenv>` restarts with a merged env — re-invoke to reload a captured dot_env (e.g. after sh_env_capture).",
   "`lsp list_sessions` lists active sessions; `lsp stop file=<path>` stops one. An env-provided LSP binary (on PATH, incl. via env=) is reused as-is."]);

checkTool("env-capture",
  "Capture the current process environment (optionally after running a bash command such as sourcing a venv) into a session-scoped dotenv file, reloadable via `env=<path>` on sh / sh_repeat_until / lsp.",
  "Capture env into a dotenv file",
  ["Use sh_env_capture to snapshot env (e.g. after `source .venv/bin/activate`) into a file, then reload it via `env=<path>` on sh or sh_repeat_until.",
   "The returned `env=<path>` snippet is reusable across later commands; the file path is absolute and session-scoped.",
   "Reload the same captured file via `env=<path>` on sh / sh_repeat_until / `lsp start`."]);

checkTool("read-media",
  "Read an image file (jpg, png, gif, webp) and return it as an inline image attachment for the model to view. Only available when the current model supports vision. Video files cannot be inlined; extract frames via bash (ffmpeg) and read those instead.",
  "Read image files inline",
  ["Use read_media to view image files (jpg, png, gif, webp); do not cat/sed/base64 them.",
   "read_media is vision-gated: if it is unavailable the current model cannot see images.",
   "For video, extract frames with ffmpeg via bash, then read_media the frames."]);

checkTool("cwd",
  "Change the cwd for all subsequent tool calls or shell commands.",
  "Change the cwd for all subsequent tool calls or shell commands.",
  ["Use set_cwd when the user asks to switch projects, or when work has clearly moved to a different tree, and the current CWD is no longer the right root for shell commands.",
   "Use set_cwd when you keep prefixing `cd path/to/project && ...` on every sh call."]);

checkTool("wait-any",
  "Yield and wait until any event triggers (user message, shell completion or error, alarm wakeups).",
  "Yield control until an event wakes you",
  ["Use wait_any to explicitly yield control instead of polling: call it once, then stop — do not call other tools alongside it.",
   "After wait_any the turn ends; you are woken by the next event — a user message, a shell-completion/error notification, or an alarm firing.",
   "Do not pair wait_any with alarm-as-poller loops; the background event itself wakes you. If you need active polling at a fixed interval, use sh_repeat_until instead."]);

checkTool("sh-repeat",
  "Run a command repeatedly until it exits non-zero; exit code 0 continues looping. Stateless, detached process group. Backgrounded by default.",
  "Poll with repeated shell commands",
  ["Use sh_repeat_until for active polling, not for passive waits; prefer the `alarm` tool for simple delayed wake-ups.",
   "sh_repeat_until interval must be between 5 and 60 seconds.",
   "If a sh_repeat_until invocation takes longer than its interval, the monitor stops and emits a repeat-breach notification.",
   "For sh_repeat_until, exit code 0 means the condition is not met yet; keep polling. Any non-zero exit code stops the monitor.",
   "When the monitor stops (any non-zero exit), exactly one notification fires; it does not say whether the final run succeeded or failed.",
   "The notification includes the monitor log file path and the line range for the stopping invocation.",
   "Cancel a repeat monitor with sh_signal using its rpt- ID; SIGKILL terminates immediately."]);

// 20. skill tool — dynamic description via {{#skills}} loop + {{^skills}} inverted.
const SKILL = loadText("skill", textPath("skill"));
const skillDescBase = "Load the full SKILL.md of a discovered skill by exact name. Pass subdoc to load a relative sub-document inside the skill directory.\n\nAvailable skills:";
eq("skill_snippet", SKILL.tool.prompt_snippet, "Load a skill by name to read its full instructions");
eq("skill_desc_with_skills",
  render(SKILL.tool.description, { skills: [{ name: "subagents-in-pi", description: "Use when delegating." }, { name: "two", description: "Second." }] }).trimEnd(),
  skillDescBase + "\n- subagents-in-pi: Use when delegating.\n- two: Second.");
eq("skill_desc_empty",
  render(SKILL.tool.description, { skills: [] }).trimEnd(),
  skillDescBase + "\n  (none)");
eq("skill_guidelines",
  render(SKILL.guidelines.bullets, {}).split("\n").join("\n"),
  ["Use the skill tool when a skill description matches the current task and you need the full SKILL.md instructions.",
   "Pass the exact skill name as shown in the skill tool description.",
   "To read a sub-document referenced by the skill, pass its relative path from the skill directory as subdoc.",
   "If the skill name is unknown, the result is an error listing the available skill names."].join("\n"));

// 21. llm-editor fold parity: {name} syntax migrated to {{name}} mustache;
//     the literal <id> in transcript_block stays literal (not a tag).
const E = loadText("llm-editor", textPath("llm-editor"));
eq("le_apply_not_found", render(E.errors.apply_not_found, { i: 2 }), "Block 2: SEARCH text not found in file. It must match exactly (whitespace/indentation).");
eq("le_apply_overlap", render(E.errors.apply_overlap, { i: 1, j: 2 }), "Block 1 overlaps block 2. Merge or separate them.");
eq("le_apply_not_unique", render(E.errors.apply_not_unique, { i: 3, n: 4 }), "Block 3: SEARCH text is not unique (4 matches). Add more surrounding context.");
eq("le_transcript_title", render(E.transcript.title, { role: "viewer" }), "# llm_editor viewer subagent");
eq("le_transcript_block",
  render(E.system_prompt.transcript_block, { dir: "/tmp/x" }),
  "Each llm_editor result includes an `<id>` = short-sha of its args (command, path, query/instruction/file_text).\nFor `view` with a query and `edit`, the subagent transcript is persisted at /tmp/x/<id>.md.\n");
eq("le_task_viewer", render(E.tasks.viewer, { content: "FILE", query: "Q" }), "Here is the file with numbered lines:\n\nFILE\n\nQuery: Q");
eq("le_file_too_large",
  render(E.errors.file_too_large, { size: 999, limit: 100, path: "/p" }),
  "File is 999 bytes (limit 100); too large for llm_editor to load (/p). Use sh to inspect regions (`rg` to locate, `sed -n 'M,Np'` to read a range); llm_editor cannot load this file.");
// no escaping: the SEARCH/REPLACE markers with < survive
eq("le_no_escape", render("{{x}}", { x: "<<<<<<< SEARCH" }), "<<<<<<< SEARCH");

// 22. schema param descriptions migrated to TOML (shell's are dynamic via switches).
eq("sh_schema_waitfor",
  render(T.schema.sh.waitfor, { max_waitfor: 30 }),
  "Seconds to wait before backgrounding (default 30, max 30; >30 errors)");
eq("sh_schema_head",
  render(T.schema.sh.head, { max_preview_lines: 500 }),
  "Agent output: keep first N lines (max 500). Mutually exclusive with tail; omit for default tail behavior.");
eq("sh_schema_command", T.schema.sh.command, "Command to run; `!!` replays the previous command");
eq("sh_schema_signal_id", T.schema.sh_signal.id, "Background shell PID (as returned by sh)");
const A = loadText("alarm", textPath("alarm"));
eq("alarm_schema_target_time", A.schema.target_time, "Absolute target time as ISO 8601 string or Unix epoch seconds");
eq("alarm_schema_cancel_all", A.schema.cancel_all, "Cancel all active alarms");
eq("alarm_schema_cancel_id", A.schema.cancel_id, "Cancel the alarm with this id");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
