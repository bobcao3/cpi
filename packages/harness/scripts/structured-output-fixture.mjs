import assert from "node:assert/strict";

const values = {
  object: JSON.parse('{"data":{"enabled":false},"__proto__":{"literal":true}}'),
  array: [{ id: 7 }, { id: 19 }],
  nullable: null,
  boolean: false,
  string: '{"still":"a string"}',
  large: { body: "bounded-output".repeat(10000) },
};

export function register_schema_fixture(pi) {
  pi.registerTool({
    name: "schema_fixture",
    label: "schema_fixture",
    description: "Return schema-backed output for renderer verification",
    parameters: {
      type: "object",
      properties: { variant: { type: "string" } },
      required: ["variant"],
    },
    outputSchema: {
      anyOf: [
        { type: "object" },
        { type: "array" },
        { type: "null" },
        { type: "boolean" },
        { type: "string" },
      ],
    },
    async execute(_id, { variant }) {
      if (variant === "object")
        await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        content: [{ type: "text", text: "TEXT_FALLBACK_ONLY" }],
        structuredContent: values[variant],
        details: undefined,
      };
    },
  });
}

export async function verify_structured_output(run) {
  const code = `await Promise.all(${JSON.stringify([...Object.keys(values), "missing"])}.map(async variant => {
    const result = await tools.schema_fixture({variant});
    store("schema-" + variant, result);
  })); text("INDEPENDENT_SCRIPT_OUTPUT");`;
  const result = await run("render-structured", code);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const saved = JSON.parse(JSON.stringify(result));
  assert.equal(saved.details.calls.length, Object.keys(values).length + 1);
  for (const call of saved.details.calls) {
    const preview = saved.details.cpi_calls[call.id];
    const variant = preview.args.variant;
    if (variant === "missing") {
      assert.equal(preview.structuredContent, undefined);
      assert.equal(preview.text, "TEXT_FALLBACK_ONLY");
    } else if (variant === "large") {
      assert.equal(preview.limited, true);
      assert(preview.structuredContent.body.length < values.large.body.length);
    } else {
      assert.deepEqual(preview.structuredContent, values[variant]);
      assert.equal(preview.text, "");
      assert.equal(preview.limited, false);
    }
  }
  assert.equal(saved.content.at(-1).text, "INDEPENDENT_SCRIPT_OUTPUT");
  return { code, saved };
}
