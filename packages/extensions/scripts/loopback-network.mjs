const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(
      `Test network policy rejects non-loopback request: ${url.origin}`,
    );
  }
  return fetch(input, init);
};
