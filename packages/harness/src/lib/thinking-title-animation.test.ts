import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { toolTreeTicker } from "../presentation/registry.ts";
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

function title(component: AssistantMessageComponent): string | undefined {
  return component
    .render(80)
    .map(stripTerminalSequences)
    .find((line) => line.includes("Thinking:"))
    ?.trim();
}

test(
  "streamed titles mutate on redraws without further provider events, then stop",
  { timeout: 2000 },
  async (context) => {
    initTheme("dark");
    context.after(() => toolTreeTicker.dispose());
    const frames: string[] = [];
    let finish: () => void = () => {};
    const complete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const component = new AssistantMessageComponent(
      undefined,
      false,
      undefined,
      "Thinking...",
      1,
      [],
      render_thinking_summary,
      () => {
        const current = title(component);
        if (!current) return;
        frames.push(current);
        if (current === "💡▸ Thinking: sitting") finish();
      },
    );
    component.updateContent(message("**kitten**\n\nFirst summary"), true);
    assert.equal(title(component), "💡▸ Thinking: kitten");
    component.updateContent(
      message("**kitten**\n\nFirst summary\n\n**sitting**"),
      true,
    );
    await complete;
    assert.deepEqual(frames, [
      "💡▸ Thinking: sitten",
      "💡▸ Thinking: sittin",
      "💡▸ Thinking: sitting",
    ]);
    const count = frames.length;
    await delay(150);
    assert.equal(frames.length, count);
    component.updateContent(message("**sitting**"), false);
    assert.equal(title(component), "💡▸ Thinking: sitting");
  },
);

test(
  "interrupted mutations rebase from the displayed title and never finish an obsolete target",
  { timeout: 2000 },
  async (context) => {
    initTheme("dark");
    context.after(() => toolTreeTicker.dispose());
    const frames: string[] = [];
    let finish: () => void = () => {};
    let interrupted = false;
    const complete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const component = new AssistantMessageComponent(
      undefined,
      false,
      undefined,
      "Thinking...",
      1,
      [],
      render_thinking_summary,
      () => {
        const current = title(component);
        if (!current) return;
        frames.push(current);
        if (current === "💡▸ Thinking: sitten" && !interrupted) {
          interrupted = true;
          component.updateContent(message("**written**"), true);
        }
        if (current === "💡▸ Thinking: written") finish();
      },
    );
    component.updateContent(message("**kitten**"), true);
    component.updateContent(message("**sitting**"), true);
    await complete;
    assert.equal(interrupted, true);
    assert.equal(frames.at(-1), "💡▸ Thinking: written");
    assert.ok(!frames.includes("💡▸ Thinking: sitting"));
    assert.equal(title(component), "💡▸ Thinking: written");
  },
);

test(
  "partial heading deltas update the latest title before closing delimiters arrive",
  { timeout: 2000 },
  async (context) => {
    initTheme("dark");
    context.after(() => toolTreeTicker.dispose());
    let finish: () => void = () => {};
    const complete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const component = new AssistantMessageComponent(
      undefined,
      false,
      undefined,
      "Thinking...",
      1,
      [],
      render_thinking_summary,
      () => {
        if (title(component) === "💡▸ Thinking: Forecast") finish();
      },
    );
    component.updateContent(message("**Weather**\n\nSummary"), true);
    component.updateContent(message("**Weather**\n\nSummary\n\n**Fore"), true);
    component.updateContent(
      message("**Weather**\n\nSummary\n\n**Forecast*"),
      true,
    );
    await complete;
    assert.equal(title(component), "💡▸ Thinking: Forecast");
    component.updateContent(
      message("**Weather**\n\nSummary\n\n**Forecast**"),
      false,
    );
    assert.equal(title(component), "💡▸ Thinking: Forecast");
    component.updateContent(message("**Final answer**"), true);
    component.updateContent(message("**Final answer**"), false);
    assert.equal(title(component), "💡▸ Thinking: Final answer");
  },
);

test(
  "unformatted Muse title lines animate toward the newest streamed line",
  { timeout: 2000 },
  async (context) => {
    initTheme("dark");
    context.after(() => toolTreeTicker.dispose());
    let finish: () => void = () => {};
    const complete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const frames: string[] = [];
    const component = new AssistantMessageComponent(
      undefined,
      false,
      undefined,
      "Thinking...",
      1,
      [],
      render_thinking_summary,
      () => {
        const current = title(component);
        if (!current) return;
        frames.push(current);
        if (current === "💡▸ Thinking: Applying constraints") finish();
      },
    );
    component.updateContent(
      message("Analyzing constraints", "meta", "muse-spark-1.3"),
      true,
    );
    assert.equal(title(component), "💡▸ Thinking: Analyzing constraints");
    component.updateContent(
      message("Analyzing constraints\n\nApplying", "meta", "muse-spark-1.3"),
      true,
    );
    component.updateContent(
      message(
        "Analyzing constraints\n\nApplying constraints",
        "meta",
        "muse-spark-1.3",
      ),
      true,
    );
    await complete;
    assert.ok(frames.length > 0);
    assert.ok(frames.every((frame) => !frame.includes("Summary")));
    assert.equal(title(component), "💡▸ Thinking: Applying constraints");
    component.updateContent(
      message(
        "Analyzing constraints\n\nApplying constraints",
        "meta",
        "muse-spark-1.3",
      ),
      false,
    );
    component.setHideThinkingBlock(false);
    const visible = component
      .render(80)
      .map((line) => stripTerminalSequences(line).trimEnd())
      .filter(Boolean);
    assert.deepEqual(visible, [
      "💡▾ Thinking",
      "    ├─  Analyzing constraints",
      "    └─  Applying constraints",
    ]);
  },
);
