import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { calculateCost } from "@earendil-works/pi-ai";
import { installFastModels } from "../bin/fast-models.mjs";
import { fixture } from "./fast-fixture.mjs";

installFastModels(ModelRuntime);

test("full streaming preserves generated identity and native priority pricing across context tiers", async () => {
  for (const input_tokens of [100, 300000]) {
    await fixture(async ({ runtime, requests }) => {
      for (const provider of ["openai", "openai-codex"]) {
        for (const id of ["gpt-5.4", "gpt-5.5"]) {
          const model = runtime.getModel(provider, `${id}-fast`);
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
          assert.equal(requests.at(-1).body.reasoning.effort, "low");
          const expected = structuredClone(result.usage);
          calculateCost(model, expected);
          for (const field of Object.keys(expected.cost))
            assert.ok(
              Math.abs(result.usage.cost[field] - expected.cost[field]) < 1e-9,
              `${provider}/${id}: ${field}`,
            );
        }
      }
    }, input_tokens);
  }
});
