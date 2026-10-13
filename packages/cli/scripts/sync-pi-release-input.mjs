import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseInput(tag) {
  assert.equal(typeof tag, "string", "release_tag must be a string");
  assert(tag.length <= 100, "release_tag exceeds the length limit");
  const match =
    /^cpi-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([1-9]\d*)$/.exec(
      tag,
    );
  assert(match, "release_tag must match cpi-<base-semver>-<positive serial>");
  for (const number of [...match[1].split("."), match[2]])
    assert(
      Number.isSafeInteger(Number(number)),
      "Release numbers must be safe integers",
    );
  return {
    tag,
    version: `${match[1]}-cpi.${match[2]}`,
    branch: `automation/pi-${tag}`,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert(
    process.env.CPI_PIN_UPDATE_TOKEN,
    "The generated GitHub App token is unavailable; configure the pin App Client ID, signing key, and cpi installation.",
  );
  assert(
    ["repository_dispatch", "workflow_dispatch"].includes(
      process.env.GITHUB_EVENT_NAME,
    ),
  );
  const bytes = await readFile(process.env.GITHUB_EVENT_PATH);
  assert(
    bytes.length <= 1024 * 1024,
    "Dispatch payload exceeds the size limit",
  );
  const event = JSON.parse(bytes);
  if (process.env.GITHUB_EVENT_NAME === "repository_dispatch")
    assert.equal(event.action, "pi-fork-release");
  const input = releaseInput(
    process.env.GITHUB_EVENT_NAME === "repository_dispatch"
      ? event.client_payload?.release_tag
      : event.inputs?.release_tag,
  );
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(input)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
