import { expect, test } from "bun:test";
import { createWebHandler } from "./router";

const handler = createWebHandler();
const internalUrl = "https://127.0.0.1:3443/unavailable";
const publicOrigin = "https://node.example.ts.net:3443";

function mutation(headers: Record<string, string>) {
  return handler(
    new Request(internalUrl, {
      method: "POST",
      headers: {
        "HX-Request": "true",
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(),
    }),
  );
}

test("same-origin Fetch Metadata tolerates adapter authority differences", async () => {
  const response = await mutation({
    Origin: publicOrigin,
    "Sec-Fetch-Site": "same-origin",
  });
  const text = await response.text();
  expect(response.status).toBe(422);
  expect(text).toContain("action is unavailable");
  expect(text).not.toContain("request origin did not match");
});

test("cross-origin Fetch Metadata and unverified fallback origins are blocked", async () => {
  const sameSite = await mutation({
    Origin: publicOrigin,
    "Sec-Fetch-Site": "same-site",
  });
  expect(sameSite.status).toBe(422);
  expect(await sameSite.text()).toContain("cross-origin write blocked");

  const missingMetadata = await mutation({ Origin: publicOrigin });
  expect(missingMetadata.status).toBe(422);
  expect(await missingMetadata.text()).toContain(
    "request origin did not match",
  );

  const missingOrigin = await mutation({ "Sec-Fetch-Site": "same-origin" });
  expect(missingOrigin.status).toBe(422);
  expect(await missingOrigin.text()).toContain("request origin is missing");
});
