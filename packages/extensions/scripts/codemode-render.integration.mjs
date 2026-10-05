import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tui from "@earendil-works/pi-tui";
import { activePiRoot, hostCodingAgent, hostAi } from "../bin/host-pi.mjs";
import { resolveGhostmux } from "@cpi/ghostmux/resolve";
import { create_render_probe } from "./codemode-render-probe.mjs";
import { nodeProgram, shellCommand } from "./shell-platform.mjs";
import {
  register_schema_fixture,
  verify_structured_output,
} from "./structured-output-fixture.mjs";

const work = await mkdtemp(join(tmpdir(), "cpi-code-render-"));
process.env.CPI_CODING_AGENT_DIR = join(work, "agent");
process.env.PI_OFFLINE = "1";
process.env.GHOSTMUX_BIN = await resolveGhostmux();
const host = await hostCodingAgent();
const { getModel } = await hostAi();
host.initTheme("dark", false);
let session;
try {
  assert.equal(host.getPackageDir(), activePiRoot());
  const settings = host.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new host.DefaultResourceLoader({
    cwd: work,
    agentDir: join(work, "agent"),
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [register_schema_fixture],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getExtensions().warnings ?? [], []);
  assert.equal(
    loader
      .getExtensions()
      .extensions.filter((entry) => entry.tools.has("codemode")).length,
    1,
  );
  const manager = host.SessionManager.inMemory(work);
  ({ session } = await host.createAgentSession({
    cwd: work,
    agentDir: join(work, "agent"),
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
    model: getModel("anthropic", "claude-sonnet-4-5"),
  }));
  await session.bindExtensions({});
  assert.ok(
    session.getActiveToolNames().includes("codemode"),
    "The cpi fork must activate codemode without explicit tool selection.",
  );
  assert.equal(session.getActiveToolNames().includes("bash"), false);
  assert.ok(session.getActiveToolNames().includes("sh"));
  const definitions = () =>
    new Map(
      loader
        .getExtensions()
        .extensions.flatMap((extension) =>
          [...extension.tools.values()].map((tool) => [
            tool.definition.name,
            tool.definition,
          ]),
        ),
    );
  const file_a = join(work, "alpha.txt");
  const file_b = join(work, "中文 beta.txt");
  const file_edit = join(work, "edited.txt");
  const file_created = join(work, "created.txt");
  await writeFile(file_a, "one" + " ".repeat(1500) + "\ntwo\n");
  await writeFile(file_b, "three\nfour\nfive\n");
  await writeFile(file_edit, "before\n");
  const script = `
const files = await Promise.all([
  tools.read({path:${JSON.stringify(file_a)}}),
  tools.read({path:${JSON.stringify(file_b)}}),
]);
await tools.write({path:${JSON.stringify(file_created)},file_text:"created\\n中文 creation\\n"});
try { await tools.write({path:${JSON.stringify(file_created)},file_text:"must not overwrite"}); } catch {}
const success = await tools.sh({description:"Compact success", command:${JSON.stringify(shellCommand("printf PRIVATE_NOT_PRINTED", "[Console]::Write('PRIVATE_NOT_PRINTED')"))}, waitfor:2});
const failure = await tools.sh({description:"Compact failure", command:${JSON.stringify(shellCommand("printf expected-failure; exit 7", "[Console]::Write('expected-failure'); exit 7"))}, waitfor:2});
const blocked = await tools.sh({description:"Compact blocked", command:"exit 0", waitfor:31});
await tools.apply_patch({path:${JSON.stringify(file_edit)}, patch:"@@\\n-before\\n+after\\n"});
try { await tools.apply_patch({path:${JSON.stringify(file_edit)}, patch:"@@\\n-after\\n+partial\\n@@\\n-missing\\n+never\\n"}); } catch {}
await tools.lsp({command:"list_supported_servers"});
await tools.alarm({relative_seconds:3600, alarm_id:"render-fixture"});
await tools.alarm({cancel:"render-fixture"});
await tools.sh_background_ps({});
store("render-check", "retained");
text({files:files.length, exit:failure.exit_code, blocked:blocked.status});
`;
  const { run, render, context } = create_render_probe({
    session,
    manager,
    theme: host.getThemeByName("dark"),
    work,
  });
  const plain = (lines) => lines.map(tui.stripTerminalSequences).join("\n");
  let pending_seen = false;
  const result = await run("render-main", script, (update) => {
    const view = plain(
      render(
        definitions().get("codemode"),
        "render-main",
        script,
        update,
        false,
        80,
        true,
      ),
    );
    if (view.includes("⏳ Reading")) pending_seen = true;
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(pending_seen, "The real sandbox must render pending nested reads");
  const definition = definitions().get("codemode");
  const collapsed = render(definition, "render-main", script, result);
  const visible = plain(collapsed);
  assert.match(
    visible.split("\n")[0],
    /Code mode: JavaScript · \d+ lines · [\d.]+s ·.*to expand/,
  );
  assert.doesNotMatch(visible, /^\s*[\d.]+s(?: · \$[\d.]+)?\s*$/m);
  const source_view = definition
    .renderCall(
      { code: script },
      host.getThemeByName("dark"),
      context("render-main", script),
    )
    .render(132);
  assert.equal(
    source_view.length,
    5,
    "The source preview must keep its header, three source rows, and expansion hint",
  );
  assert.match(plain(source_view), /more code lines.*to expand/);
  assert.match(visible, /✓ Read.*alpha\.txt.*2 lines/);
  assert.match(visible, /中文 beta\.txt.*3 lines/);
  assert.match(visible, /Compact success/);
  assert.match(visible, /Exit 7/);
  assert.match(visible, /Blocked/);
  assert.match(visible, /applied 1 hunk/);
  assert.match(
    plain(render(definition, "render-main", script, result, false, 132)),
    /applied 1 hunk before failure/,
  );
  assert.match(visible, /\+\s+1\s+partial/);
  assert.equal(await readFile(file_edit, "utf8"), "partial\n");
  assert.match(visible, /✓ write:.*created\.txt.*created/);
  assert.match(visible, /\+\s+1\s+created/);
  assert.match(visible, /\+\s+2\s+中文 creation/);
  assert.match(visible, /✗ write:.*created\.txt.*failed/);
  assert.doesNotMatch(
    visible,
    /▀+\n▄+/,
    "Adjacent write actions must share one frame",
  );
  assert.equal(
    await readFile(file_created, "utf8"),
    "created\n中文 creation\n",
  );
  assert.match(visible, /lsp supported servers/);
  assert.match(visible, /Alarm/);
  assert.match(visible, /No background shells/);
  const successful_read = Object.values(result.details.cpi_calls).find(
    (preview) => preview.args.path === file_a,
  );
  assert.equal(successful_read.details.text, undefined);
  assert.equal(successful_read.limited, false);
  const successful_shell = Object.values(result.details.cpi_calls).find(
    (preview) => preview.args.description === "Compact success",
  );
  assert.equal(
    successful_shell.text,
    "",
    "Rendering metadata must not retain successful shell output",
  );
  const expanded = render(definition, "render-main", script, result, true);
  assert(expanded.length > collapsed.length);
  assert.ok(
    expanded.some(
      (line) =>
        /\x1b\[(?:38;|3[0-7])/.test(line) &&
        tui.stripTerminalSequences(line).includes("const files"),
    ),
    "The actual code block must contain syntax color sequences",
  );
  for (const width of [1, 12, 24, 80, 132])
    for (const line of render(
      definition,
      "render-main",
      script,
      result,
      false,
      width,
    ))
      assert(
        tui.visibleWidth(line) <= width,
        `Renderer overflow at ${width}: ${line}`,
      );
  const retained = await run("render-store", 'return load("render-check");');
  assert.equal(retained.content[1].text, "retained");
  const large_before = Array.from({ length: 40 }, (_, index) => `old${index}`);
  const large_after = large_before.map((line) => line.replace("old", "new"));
  const large_file = join(work, "large-diff.txt");
  await writeFile(large_file, large_before.join("\n") + "\n");
  const patch =
    "@@\n" +
    large_before.map((line) => `-${line}\n`).join("") +
    large_after.map((line) => `+${line}\n`).join("");
  const large_code = `await tools.apply_patch({path:${JSON.stringify(large_file)},patch:${JSON.stringify(patch)}});`;
  const large = await run("render-large-diff", large_code);
  assert.notEqual(large.isError, true, JSON.stringify(large));
  assert.equal(
    await readFile(large_file, "utf8"),
    large_after.join("\n") + "\n",
  );
  assert.match(
    plain(render(definition, "render-large-diff", large_code, large, true)),
    /Nested rendering metadata was truncated/,
  );
  const failed = await run(
    "render-failure",
    'text("before error"); throw new Error("EXPECTED_SCRIPT_ERROR");',
  );
  assert.equal(failed.isError, true);
  assert.match(
    plain(
      render(
        definition,
        "render-failure",
        'throw new Error("EXPECTED_SCRIPT_ERROR");',
        failed,
        true,
      ),
    ),
    /before error[\s\S]*EXPECTED_SCRIPT_ERROR/,
  );
  const truncated_code =
    '// @options: {"max_output_tokens": 100}\ntext("x".repeat(4000));';
  const truncated = await run("render-truncated", truncated_code);
  assert.ok(truncated.details.fullOutputPath);
  assert.equal(
    (await readFile(truncated.details.fullOutputPath, "utf8")).length,
    4000,
  );
  assert.match(
    plain(render(definition, "render-truncated", truncated_code, truncated)),
    /Full output:/,
  );
  if (session.model.input.includes("image")) {
    const terminal = await nodeProgram(
      work,
      "render-terminal",
      'process.stdout.write("SCREEN_IMAGE\\r\\n"); process.stdin.resume(); setTimeout(() => process.exit(0), 30000);',
    );
    const image_code = `
const shell = await tools.sh({description:"Image terminal", command:${JSON.stringify(terminal)}, waitfor:0.2, is_pty:true});
try { const screen = await tools.sh_screenshot({id:shell.id}); image(screen.image); }
finally { await tools.sh_signal({id:shell.id,signal:"SIGKILL"}); }
`;
    const image = await run("render-image", image_code);
    assert.notEqual(image.isError, true, JSON.stringify(image));
    assert.equal(
      image.content.filter((block) => block.type === "image").length,
      1,
    );
    assert.match(
      plain(render(definition, "render-image", image_code, image)),
      /Image: image\/png/,
    );
    const capture = Object.values(image.details.cpi_calls).find(
      (preview) => preview.structuredContent?.image,
    );
    assert.equal(capture.structuredContent.image.data, "[binary data]");
  }
  const { code: structured_code, saved: structured_saved } =
    await verify_structured_output(run);
  const saved = manager
    .getBranch()
    .find(
      (entry) =>
        entry.type === "message" && entry.message.toolCallId === "render-main",
    ).message;
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getExtensions().warnings ?? [], []);
  const replay = create_render_probe({
    session,
    manager,
    theme: host.getThemeByName("dark"),
    work,
  });
  const structured_view = plain(
    replay.render(
      definitions().get("codemode"),
      "render-structured",
      structured_code,
      structured_saved,
      true,
      132,
    ),
  );
  assert.match(structured_view, /result:\s+null/);
  assert.match(structured_view, /result:\s+false/);
  assert.match(structured_view, /TEXT_FALLBACK_ONLY/);
  assert.match(structured_view, /Nested rendering metadata was truncated/);
  assert.match(structured_view, /INDEPENDENT_SCRIPT_OUTPUT/);
  assert.match(
    plain(render(definitions().get("codemode"), "render-main", script, saved)),
    /\+\s+2\s+中文 creation/,
  );
  assert.match(
    plain(render(definitions().get("codemode"), "render-main", script, saved)),
    /✓ Read.*alpha\.txt.*2 lines/,
  );
  const wait = definitions().get("wait_any");
  const wait_context = context("wait-view", "");
  const first_wait = wait.renderCall(
    {},
    host.getThemeByName("dark"),
    wait_context,
  );
  assert.doesNotThrow(() =>
    wait
      .renderCall({}, host.getThemeByName("dark"), {
        ...wait_context,
        lastComponent: first_wait,
      })
      .render(24),
  );
  for (const selection of [
    { tools: ["read"] },
    { excludeTools: ["codemode"] },
    { noTools: "all" },
  ]) {
    const { session: restricted } = await host.createAgentSession({
      cwd: work,
      agentDir: join(work, "agent"),
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: host.SessionManager.inMemory(work),
      ...selection,
    });
    try {
      await restricted.bindExtensions({});
      assert.equal(restricted.getActiveToolNames().includes("codemode"), false);
    } finally {
      restricted.dispose();
    }
  }
  console.log(
    "Cpi fork: default tools, unique codemode ownership, live nested calls, rendering, expansion, narrow widths, reload replay, store, failures, output spill, and images passed.",
  );
} finally {
  if (session)
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
  session?.dispose();
  await rm(work, { recursive: true, force: true });
}
process.exit(0);
