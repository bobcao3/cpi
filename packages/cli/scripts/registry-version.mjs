import assert from "node:assert/strict";

export function registry_release_version(tag) {
  if (!tag) return undefined;
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
  assert(match, `Invalid cpi release tag: ${tag}`);
  return match[1];
}
