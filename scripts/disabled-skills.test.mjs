import assert from "node:assert/strict";
import test from "node:test";
import {
  filterDisabledSkills,
  parseDisabledSkills,
} from "../bin/disabled-skills.mjs";

test("parseDisabledSkills trims, drops empties, and dedupes", () => {
  assert.deepEqual(parseDisabledSkills(" a , b,,a "), ["a", "b"]);
  assert.deepEqual(parseDisabledSkills(undefined), []);
  assert.deepEqual(parseDisabledSkills(true), []);
});

test("filterDisabledSkills separates missing names from visible skills", () => {
  const skills = [{ name: "keep" }, { name: "drop" }];
  assert.deepEqual(filterDisabledSkills(skills, ["drop", "typo"]), {
    visible: [{ name: "keep" }],
    missing: ["typo"],
  });
  assert.deepEqual(filterDisabledSkills(skills, []), {
    visible: skills,
    missing: [],
  });
});