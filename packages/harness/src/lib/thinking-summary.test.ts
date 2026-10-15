import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  getThemeByName,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  COMPACT_WIDTH_THRESHOLD,
  stripTerminalSequences,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { TreeView } from "../tree/tree-view.ts";
import { render_thinking_summary } from "./thinking-summary.ts";

function message(
  thinking: string,
  provider = "openai",
  model = "gpt-6.1-sol",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }],
    api: "openai-responses",
    provider,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

const width = Math.max(80, COMPACT_WIDTH_THRESHOLD);
const theme = getThemeByName("dark")!;
const rows = (component: AssistantMessageComponent, available = width) =>
  component
    .render(available)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .filter(Boolean);

function assistant(
  original: AssistantMessage,
  hidden = true,
): AssistantMessageComponent {
  return new AssistantMessageComponent(
    original,
    hidden,
    undefined,
    "Thinking...",
    1,
    [],
    render_thinking_summary,
  );
}

function click(component: AssistantMessageComponent, title: string): void {
  const lines = component.render(width);
  const y = lines.findIndex((line) =>
    stripTerminalSequences(line).includes(title),
  );
  assert.ok(y >= 0);
  const line = stripTerminalSequences(lines[y]!);
  const marker = line.search(/[▸▾]/);
  assert.ok(marker >= 0);
  const x = visibleWidth(line.slice(0, marker));
  const event: TuiMouseEvent = {
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.equal(component.handleMouse(event)?.handled, true);
}

test("thinking interception returns the same TreeView used by tool widgets", () => {
  initTheme("dark");
  const original = message("**Weather**\n\nWeather summary");
  const tree = render_thinking_summary(
    ["**Weather**\n\nWeather summary"],
    {
      message: original,
      hidden: false,
      requestRender: () => {},
      expanded: false,
      isStreaming: false,
      markdownTheme: getMarkdownTheme(),
      transform: (text) => text,
      state: {},
    },
    theme,
  );
  assert.ok(tree instanceof TreeView);
  assert.deepEqual(tree.render(width).map(stripTerminalSequences), [
    "💡▸ Thinking: Weather",
  ]);
  assert.deepEqual(
    tree.render(COMPACT_WIDTH_THRESHOLD - 1).map(stripTerminalSequences),
    ["💡▸Thinking: Weather"],
  );
  tree.dispose();
});

test("shared tree disclosures preserve title and body state through streaming and theme invalidation", () => {
  initTheme("dark");
  const trace =
    "**Thoughts A**\n\nLorem ipsum\n\n**Weather**\n\nThinking about weather of today";
  const component = assistant(message(trace));
  assert.deepEqual(rows(component), ["💡▸ Thinking: Weather"]);
  click(component, "Thinking");
  assert.deepEqual(rows(component), [
    "💡▾ Thinking",
    "    ├─▸ Thoughts A",
    "    └─▸ Weather",
  ]);
  click(component, "Thoughts A");
  assert.deepEqual(rows(component), [
    "💡▾ Thinking",
    "    ├─▾ Thoughts A",
    "    │   Lorem ipsum",
    "    └─▸ Weather",
  ]);
  component.updateContent(message(`${trace}\n\n**Forecast**`), true);
  assert.ok(rows(component).includes("    │   Lorem ipsum"));
  assert.ok(rows(component).includes("    └─  Forecast"));
  initTheme("light");
  component.invalidate();
  assert.ok(rows(component).includes("    │   Lorem ipsum"));
  click(component, "Thinking");
  assert.deepEqual(rows(component), ["💡▸ Thinking: Forecast"]);
  component.setHideThinkingBlock(false);
  assert.ok(
    rows(component).join("\n").includes("Thinking about weather of today"),
  );
  component.setHideThinkingBlock(true);
  assert.deepEqual(rows(component), ["💡▸ Thinking: Forecast"]);
});

test("title-only, untitled, fenced, and inline-bold summaries retain their contents", () => {
  initTheme("dark");
  const component = assistant(
    message(
      "Introductory summary\n\n**First**\nBody one\n**Second**\n**Bold** and **more bold**\n\n## Third\n\n```md\n**Not a title**\n```\n\n__Title only__",
    ),
    false,
  );
  const titles = rows(component).join("\n");
  assert.equal(titles, "💡▸ Thinking: Title only");
  click(component, "Thinking");
  const expanded_titles = rows(component).join("\n");
  assert.match(expanded_titles, /Summary/);
  assert.match(expanded_titles, /First/);
  assert.match(expanded_titles, /Second/);
  assert.match(expanded_titles, /Third/);
  assert.match(expanded_titles, /Title only/);
  assert.doesNotMatch(expanded_titles, /Not a title|more bold/);
  component.setHideThinkingBlock(false);
  const body = rows(component).join("\n");
  for (const text of [
    "Introductory summary",
    "Body one",
    "Bold and more bold",
    "**Not a title**",
  ])
    assert.ok(body.includes(text));
});

test("unformatted thinking lines become title-only nodes instead of a Summary body", () => {
  initTheme("dark");
  const first =
    "Analyzing style constraints and diagram requirements to frame a concise, active-voice explanation of the buddy allocator.";
  const last =
    "Applying style constraints to avoid prohibited phrasing and pronouns while structuring the buddy allocator explanation.";
  const thinking = `${first}\r\n\r\n  ${last}\r\n`;
  const original = message(thinking, "meta", "muse-spark-1.3");
  const component = assistant(original, false);
  assert.deepEqual(rows(component, 240), [`💡▸ Thinking: ${last}`]);
  click(component, "Thinking");
  assert.deepEqual(rows(component, 240), [
    "💡▾ Thinking",
    `    ├─  ${first}`,
    `    └─  ${last}`,
  ]);
  component.setHideThinkingBlock(false);
  assert.deepEqual(rows(component, 240), [
    "💡▾ Thinking",
    `    ├─  ${first}`,
    `    └─  ${last}`,
  ]);
  assert.deepEqual(original.content, [{ type: "thinking", thinking }]);
});

test("separate thinking runs retain independent TreeView states without changing the transcript", () => {
  initTheme("dark");
  const original = message("**Before**");
  original.content.push(
    { type: "thinking", thinking: "Before summary" },
    { type: "text", text: "Answer" },
    { type: "thinking", thinking: "**After**\n\nAfter summary" },
  );
  const component = assistant(original);
  click(component, "Thinking: Before");
  click(component, "Before");
  assert.ok(rows(component).join("\n").includes("Before summary"));
  assert.ok(rows(component).includes("💡▸ Thinking: After"));
  assert.deepEqual(original.content[0], {
    type: "thinking",
    thinking: "**Before**",
  });
});

test("shared responsive layout, Markdown transforms, and all foregrounds remain muted", () => {
  initTheme("dark");
  const contexts: { width: number; streaming: boolean }[] = [];
  const component = new AssistantMessageComponent(
    undefined,
    false,
    undefined,
    "Custom label",
    1,
    [
      (text, context) => {
        contexts.push({
          width: context.availableWidth,
          streaming: context.isStreaming,
        });
        return text.replace("original", "transformed");
      },
    ],
    render_thinking_summary,
  );
  component.updateContent(
    message(
      "**Weather 天気 forecast**\n\noriginal [link](https://example.com) and `code`\n\n```ts\nconst value = 1;\n```\n\n**Last**\n\nFinal summary",
    ),
    true,
  );
  component.setHideThinkingBlock(false);
  for (const available of [1, 2, 3, 4, 6, 12, 24, width]) {
    for (const line of component.render(available))
      assert.ok(visibleWidth(line) <= available);
  }
  const raw = component.render(width).join("\n");
  assert.match(stripTerminalSequences(raw), /transformed link/);
  assert.ok(
    raw.includes(theme.fg("muted", theme.bold("Weather 天気 forecast"))),
  );
  assert.ok(raw.includes(theme.bold("Thinking")));
  const foregrounds = raw.match(/\x1b\[(?:38;[^m]*|3[0-7]|9[0-7])m/g) ?? [];
  assert.ok(foregrounds.length > 0);
  assert.deepEqual(
    new Set(foregrounds),
    new Set([theme.fg("muted", "").match(/\x1b\[[0-9;]*m/)?.[0]]),
  );
  assert.ok(
    contexts.some(
      (context) => context.width === width - 8 && context.streaming,
    ),
  );
});

for (const [provider, model, summarized] of [
  ["openai", "gpt-6.1-sol", true],
  ["openai-codex", "gpt-6.1-sol", true],
  ["anthropic", "claude-opus-4-8", true],
  ["meta", "muse-spark-1.3-contributor", true],
  ["google", "gemini-3.1-pro-preview", true],
  ["google-vertex", "gemini-3.1-pro-preview", true],
  ["xai", "grok-4.7", true],
  ["azure", "o3", true],
  ["github-copilot", "claude-opus-4.8", true],
  ["cloudflare-ai-gateway", "gpt-6.1-sol", true],
  ["opencode", "muse-spark-1.3", true],
  ["opencode-go", "gpt-6.1-sol", true],
  ["radius", "claude-opus-4.8", true],
  ["openrouter", "~openai/gpt-sol-latest", true],
  ["openrouter", "openai/o3:batch", true],
  ["openrouter", "anthropic/claude-opus-4.8", true],
  ["vercel-ai-gateway", "meta/muse-spark-1.3", true],
  ["vercel-ai-gateway", "google/gemini-3.1-pro-preview", true],
  ["openrouter", "x-ai/grok-4.7", true],
  ["amazon-bedrock", "us.anthropic.claude-opus-4-8-v1", true],
  ["amazon-bedrock", "global.openai.gpt-6.1-sol", true],
  ["deepseek", "deepseek-v4-pro", false],
  ["azure", "deepseek-v4-pro", false],
  ["openai", "gpt-oss-120b", false],
  ["openrouter", "openai/gpt-oss-120b", false],
  ["amazon-bedrock", "us-gov.openai.gpt-oss-120b-1:0", false],
  ["cloudflare-ai-gateway", "workers-ai/@cf/openai/gpt-oss-120b", false],
  ["github-copilot", "kimi-k2.5", false],
  ["google", "gemma-3-27b-it", false],
  ["xai", "grok-3-mini-fast", false],
  ["meta", "muse-glimmer-30b", false],
  ["radius", "balanced", false],
  ["custom-provider", "gpt-6.1-sol", false],
] as const) {
  test(`historical provider ${provider}/${model} chooses summarized=${summarized}`, () => {
    initTheme("dark");
    assert.deepEqual(
      rows(
        assistant(message("**Weather**\n\nWeather summary", provider, model)),
      ),
      [summarized ? "💡▸ Thinking: Weather" : "💡 Thinking..."],
    );
  });
}

test("resolved gateway identities override opaque routing aliases", () => {
  initTheme("dark");
  const routed = message("**Weather**", "openrouter", "auto");
  routed.responseModel = "anthropic/claude-opus-4.8";
  assert.deepEqual(rows(assistant(routed)), ["💡▸ Thinking: Weather"]);
});
