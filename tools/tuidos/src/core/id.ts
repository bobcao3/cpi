import { webcrypto } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Locally generated 160-bit Crockford-base32 id; no coordination required. */
export function newId(): string {
  const r = webcrypto.getRandomValues(new Uint8Array(32));
  let out = "";
  for (let i = 0; i < 32; i++) out += CROCKFORD.charAt(r[i]! & 0x1f);
  return out;
}

export function shortId(
  id: string,
  allIds: string[],
  min = 6,
  max = 12,
): string {
  const upper = id.toUpperCase();
  const all = allIds.map((x) => x.toUpperCase());
  for (let len = min; len <= max; len++) {
    const p = upper.slice(0, len);
    if (all.filter((x) => x.startsWith(p)).length === 1)
      return upper.slice(0, len);
  }
  return id;
}

export function matchIdPrefix(prefix: string, ids: string[]): string[] {
  const p = prefix.toUpperCase();
  return ids.filter((id) => id.toUpperCase().startsWith(p));
}
