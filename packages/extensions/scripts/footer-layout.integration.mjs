import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  FooterComponent,
  FooterDataProvider,
  getSelectListTheme,
  getThemeByName,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@cpi/cli";
import {
  ProcessTerminal,
  TuiMainScreen,
  getKeybindings,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { FooterNavigation } from "../extensions/lib/footer-navigation.ts";
import { PromptEditor } from "../extensions/lib/prompt-editor.ts";
import {
  codexUsage,
  parseUsageReport,
} from "../extensions/lib/provider-usage/codex.ts";
import {
  deepseekBalance,
  parseBalance,
} from "../extensions/lib/provider-usage/deepseek.ts";
import {
  bindCostLedger,
  captureSubagentUsageReporter,
} from "../extensions/lib/cost-ledger.ts";
import { fixture } from "./fast-fixture.mjs";

await fixture(async ({ directory, runtime, config, modelsPath, apiKey }) => {
  const manager = SessionManager.inMemory(directory);
  for (const [input, output, cacheRead, cost] of [
    [2499900, 262990, 65000000, 1],
    [100, 10, 0, 0.25],
  ]) {
    manager.appendMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Recorded answer" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: input + output + cacheRead,
        cost: {
          input: cost,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: cost,
        },
      },
    });
  }
  const settings = SettingsManager.inMemory({
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime: runtime,
    tools: [],
  });
  const data = new FooterDataProvider(directory);
  const native = new FooterComponent(session, data);
  const unbind = bindCostLedger(
    manager.getEntries(),
    (type, value) => manager.appendCustomEntry(type, value),
    manager.getSessionId(),
  );
  const report = captureSubagentUsageReporter();
  report("layout-child", { input: 3, output: 5, cost: 0.5 });
  report("layout-child", { input: 3, output: 5, cost: 0.5 });
  initTheme("dark", false);
  const theme = getThemeByName("dark");
  assert(theme);
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.stop();
  const editor = new PromptEditor(
    tui,
    {
      borderColor: theme.getThinkingBorderColor("high"),
      selectList: getSelectListTheme(),
    },
    getKeybindings(),
    () => native.getContent(),
    () => theme,
  );
  editor.borderColor = theme.getThinkingBorderColor("high");
  const opened = [];
  const sections = [
    { name: "shell", value: "shell:2 mon:1" },
    { name: "subagent-cost", value: "sub:0" },
    {
      name: "summary",
      value: "I'm finishing the module and checking the reasoning/status line.",
    },
  ];
  const footer = new FooterNavigation(
    tui,
    theme,
    native,
    () => sections,
    (kind) => opened.push(kind),
    () => "high",
  );
  try {
    const header = editor.render(140)[0];
    assert(header.includes(editor.borderColor("↑2.5M ↓263k R65M CH0.0%")));
    const plain = stripTerminalSequences(header);
    assert.match(plain, /^── 💤 ↑2\.5M ↓263k R65M CH0\.0%/);
    assert.match(plain, /[\d.?]+%?\/272k ──$/);
    assert.doesNotMatch(plain, /Working|\(auto\)/);
    const rows = footer.render(140).map(stripTerminalSequences);
    assert.equal(rows.length, 3);
    assert.equal(rows[2], sections[2].value);
    assert.doesNotMatch(rows.slice(0, 2).join("\n"), /I'm finishing/);
    assert.equal(
      footer.render(140)[2],
      theme.getThinkingBorderColor("high")(sections[2].value),
    );
    assert.match(rows[0], /shell:2 mon:1.*sub:0/);
    assert.match(
      rows[1],
      /^\$1\.7500 \(Subagents: \$0\.5000\) • openai\s+gpt-5\.5 • /,
    );
    assert(rows[1].endsWith(`gpt-5.5 • ${session.thinkingLevel}`));
    assert.equal(visibleWidth(rows[1]), 140);
    assert.doesNotMatch(rows.join("\n"), /↑2\.5M|CH0\.0%|\(auto\)/);
    for (const [token, kind] of [
      ["shell:2", "shell"],
      ["mon:1", "monitor"],
      ["sub:0", "subagent"],
    ]) {
      footer.handleMouse({
        type: "click",
        button: "left",
        x: rows[0].indexOf(token),
        y: 0,
        width: 140,
        height: 2,
      });
      assert.equal(opened.at(-1), kind);
    }
    const count = opened.length;
    footer.handleMouse({
      type: "click",
      button: "left",
      x: rows[0].indexOf("shell:2"),
      y: 1,
      width: 140,
      height: 2,
    });
    assert.equal(opened.length, count);
    manager.appendSessionInfo("界面の確認");
    editor.setText(
      Array.from({ length: 50 }, (_, index) => `Editor line ${index}`).join(
        "\n",
      ),
    );
    assert.match(stripTerminalSequences(editor.render(140)[0]), /↑ \d+ more/);
    for (const width of [1, 2, 3, 8, 12, 20, 40, 80, 140]) {
      assert.equal(footer.render(width).length, 3);
      for (const row of footer.render(width))
        assert(visibleWidth(row) <= width, `Footer overflow at ${width}`);
      assert(
        visibleWidth(editor.render(width)[0]) <= width,
        `Prompt border overflow at ${width}`,
      );
    }
    const unicode_row = stripTerminalSequences(footer.render(140)[0]);
    const shell_column = visibleWidth(
      unicode_row.slice(0, unicode_row.indexOf("shell:2")),
    );
    footer.handleMouse({
      type: "click",
      button: "left",
      x: shell_column,
      y: 0,
      width: 140,
      height: 2,
    });
    assert.equal(opened.at(-1), "shell");
    let returned = false;
    assert(
      footer.focus(() => {
        tui.setFocus(editor);
        returned = true;
      }),
    );
    assert.doesNotMatch(
      footer.render(140).join("\n"),
      /\x1b\[(?:48;|4[0-7]m|10[0-7]m)/,
    );
    footer.handleInput("\x1b[C");
    footer.handleInput("\r");
    assert.equal(opened.at(-1), "monitor");
    assert(returned);
    sections.pop();
    assert.equal(footer.render(140).length, 3);
    assert.equal(stripTerminalSequences(footer.render(140)[2]), "");
    unbind();
    const restored = bindCostLedger(
      manager.getEntries(),
      (type, value) => manager.appendCustomEntry(type, value),
      manager.getSessionId(),
    );
    assert.match(
      stripTerminalSequences(footer.render(140)[1]),
      /^\$1\.7500 \(Subagents: \$0\.5000\) •/,
    );
    restored();
    Object.assign(config.providers, {
      deepseek: { apiKey },
      google: { apiKey },
    });
    await writeFile(modelsPath, JSON.stringify(config));
    await runtime.refresh();
    const now = Date.now();
    const codex_report = parseUsageReport(
      {
        rate_limit: {
          primary_window: { used_percent: 40, reset_after_seconds: 529200 },
        },
      },
      now,
    );
    const balance = parseBalance({
      balance_infos: [{ currency: "USD", total_balance: "25.00" }],
    });
    assert(codex_report && balance);
    for (const [provider, telemetry, expected] of [
      [
        "openai-codex",
        codexUsage.format(codex_report, now, theme),
        / • openai-codex\s+60%\s+6d 3h /,
      ],
      [
        "deepseek",
        deepseekBalance.format(balance, now, theme),
        / • deepseek \$25 /,
      ],
      ["google", undefined, / • google /],
    ]) {
      const model = runtime
        .getModels()
        .find((model) => model.provider === provider && model.reasoning);
      assert(model, provider);
      await session.setModel(model);
      session.setThinkingLevel("medium");
      if (telemetry) sections.push({ name: "usage", value: telemetry });
      const rendered = footer.render(140);
      const text = rendered.map(stripTerminalSequences);
      assert.match(text[1], expected);
      assert(text[1].startsWith("$1.7500 (Subagents: $0.5000) • "), text[1]);
      assert(
        text[1].endsWith(`${model.id} • ${session.thinkingLevel}`),
        text[1],
      );
      assert.equal(visibleWidth(text[1]), 140);
      assert.doesNotMatch(text[0], /openai-codex|deepseek|60%|6d 3h/);
      if (provider !== "openai-codex")
        assert.doesNotMatch(
          rendered.join("\n"),
          /\x1b\[(?:48;|4[0-7]m|10[0-7]m)/,
        );
      for (let width = 1; width <= 140; width++) {
        for (const row of footer.render(width))
          assert(visibleWidth(row) <= width);
      }
      if (telemetry) sections.pop();
      assert(
        stripTerminalSequences(footer.render(140)[1]).includes(
          ` • ${provider} `,
        ),
      );
    }
    console.log(
      "Footer layout passed provider telemetry, cost deduplication/restore, compact widths, and activity mouse targets.",
    );
  } finally {
    unbind();
    data.dispose();
    session.dispose();
  }
});
