export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
} as const;

export function adapterErrorResponse(tooLarge: boolean): Response {
  const message = tooLarge
    ? "Request too large — reduce the submission below 1 MiB and try again."
    : "The server could not process this request — reload the page; if it repeats, verify the project with clidos and report it.";
  const status = tooLarge ? 413 : 500;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Request failed · tuidos</title><link rel="stylesheet" href="/assets/styles.css"></head><body><main class="fatal window"><h1>Request failed</h1><p>${message}</p><a class="primary bevel" href="/">Return to Projects</a></main></body></html>`,
    {
      status,
      headers: {
        ...SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
