// @ts-expect-error Bun test types are runtime-provided and not a package dependency.
import { describe, expect, test } from "bun:test";
import { DIRECT_EDIT_CANCELED, parseDirectDiff } from "./direct-diff.ts";

const wrapped = (diff: string) => `<<<<<<< DIFF\n${diff}\n>>>>>>> DIFF`;

describe("direct diff envelope", () => {
  test("extracts one bounded unified diff", () => {
    expect(parseDirectDiff(wrapped("@@\n-a\n+b"), "angle")).toEqual({
      ok: true,
      diff: "@@\n-a\n+b",
    });
  });

  test("parses the exact cancel sentinel with surrounding whitespace only", () => {
    expect(parseDirectDiff(`  ${DIRECT_EDIT_CANCELED}  `, "angle")).toEqual({
      ok: true,
      cancel: true,
    });
    expect(
      parseDirectDiff(`${DIRECT_EDIT_CANCELED} plus prose`, "angle"),
    ).toMatchObject({ ok: false, error: "missing_envelope" });
  });

  test("extracts one bounded unified diff with patch markers", () => {
    expect(
      parseDirectDiff("*** Begin Patch\n@@\n-a\n+b\n*** End Patch"),
    ).toEqual({
      ok: true,
      diff: "@@\n-a\n+b",
    });
  });

  test("allows whitespace outside and marker text in prefixed rows", () => {
    const raw = `\n<<<<<<< DIFF\n@@\n-<<<<<<< DIFF\n+>>>>>>> DIFF\n>>>>>>> DIFF\n`;
    expect(parseDirectDiff(raw, "angle")).toEqual({
      ok: true,
      diff: "@@\n-<<<<<<< DIFF\n+>>>>>>> DIFF",
    });
  });

  test("rejects missing, repeated, reversed, and empty envelopes", () => {
    expect(parseDirectDiff("@@\n-a\n+b", "angle")).toMatchObject({
      ok: false,
      error: "missing_envelope",
    });
    expect(
      parseDirectDiff(
        "<<<<<<< DIFF\n@@\n-a\n+b\n>>>>>>> DIFF\n<<<<<<< DIFF\n>>>>>>> DIFF",
        "angle",
      ),
    ).toMatchObject({ ok: false, error: "multiple_envelopes" });
    expect(
      parseDirectDiff(">>>>>>> DIFF\n<<<<<<< DIFF", "angle"),
    ).toMatchObject({
      ok: false,
      error: "bad_envelope",
    });
    expect(parseDirectDiff(wrapped(""), "angle")).toMatchObject({
      ok: false,
      error: "empty_diff",
    });
  });

  test("rejects prose outside the envelope", () => {
    expect(
      parseDirectDiff(`Here is the patch:\n${wrapped("@@\n-a\n+b")}`, "angle"),
    ).toMatchObject({ ok: false, error: "outside_text" });
  });
});
