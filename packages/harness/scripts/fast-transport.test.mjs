import assert from "node:assert/strict";
import { test } from "node:test";
import { hostAi } from "../bin/host-pi.mjs";
import { fixture } from "./fast-fixture.mjs";
import { isGeneratedFastModel } from "../bin/fast-models.mjs";

const { calculateCost } = await hostAi();

// GPT-6 keeps reasoning.effort fixed and sends the level as configuration_update.
function effectiveEffort(body) {
  const update = body.input.findLast(
    (item) => item.type === "configuration_update",
  );
  return update?.reasoning.effort ?? body.reasoning.effort;
}

function toolTurn(base, producer) {
  const id = "call_1|fc_1";
  const signature = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "plan" }],
    encrypted_content: "opaque",
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return [
    { role: "user", content: "Look it up", timestamp: 1 },
    {
      role: "assistant",
      api: base.api,
      provider: base.provider,
      model: producer,
      content: [
        {
          type: "thinking",
          thinking: "plan",
          thinkingSignature: JSON.stringify(signature),
        },
        { type: "toolCall", id, name: "lookup", arguments: {} },
      ],
      usage: { ...usage, totalTokens: 0, cost: { ...usage, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "lookup",
      content: [{ type: "text", text: "found" }],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "Continue", timestamp: 4 },
  ];
}

test("full streaming preserves generated identity and native priority pricing across context tiers", async () => {
  for (const input_tokens of [100, 300000]) {
    await fixture(async ({ runtime, requests }) => {
      const models = runtime.getModels().filter(isGeneratedFastModel);
      assert.ok(models.length > 0);
      for (const model of models) {
        const provider = model.provider;
        const id = model.id.slice(0, -5);
        const stream = runtime.stream(
          model,
          {
            messages: [
              { role: "user", content: "Say OK", timestamp: Date.now() },
            ],
          },
          {
            reasoningEffort: "low",
            maxTokens: 32,
            transport: "sse",
            onPayload: (payload) => ({
              ...payload,
              model: "wrong-id",
              service_tier: "default",
            }),
          },
        );
        for await (const event of stream) {
          const message = event.partial ?? event.message ?? event.error;
          if (message) assert.equal(message.model, model.id);
        }
        const result = await stream.result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.equal(result.model, model.id);
        assert.equal(requests.at(-1).body.model, id);
        assert.equal(requests.at(-1).body.service_tier, "priority");
        assert.equal(effectiveEffort(requests.at(-1).body), "low");
        const expected = structuredClone(result.usage);
        calculateCost(model, expected);
        for (const field of Object.keys(expected.cost))
          assert.ok(
            Math.abs(result.usage.cost[field] - expected.cost[field]) < 1e-9,
            `${provider}/${id}: ${field}`,
          );
      }
    }, input_tokens);
  }
});

test("toggling Fast replays earlier turns as the same backend model", async () => {
  await fixture(async ({ runtime, requests }) => {
    const models = runtime.getModels().filter(isGeneratedFastModel);
    assert.ok(models.length > 0);
    for (const fast of models) {
      const base = runtime.getModel(fast.provider, fast.id.slice(0, -5));
      const inputs = [];
      for (const [target, producer] of [
        [base, base.id],
        [base, fast.id],
        [fast, fast.id],
        [fast, base.id],
      ]) {
        const stream = runtime.stream(
          target,
          { messages: toolTurn(base, producer) },
          { reasoningEffort: "low", maxTokens: 32, transport: "sse" },
        );
        const result = await stream.result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        inputs.push(requests.at(-1).body.input);
      }
      const label = `${fast.provider}/${fast.id}`;
      for (const input of inputs) assert.deepEqual(input, inputs[0], label);
      assert.ok(
        inputs[0].some((item) => item.type === "reasoning"),
        label,
      );
      assert.ok(
        inputs[0].some((item) => item.id === "fc_1"),
        label,
      );
    }
  });
});
