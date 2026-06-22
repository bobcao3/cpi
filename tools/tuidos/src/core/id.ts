import { webcrypto } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a 160-bit random id as 32 Crockford base32 chars — SHA-1-strength
 * entropy, no timestamp, no dashes. High enough entropy that ids stay unique
 * when state from independent sites is merged (git/jj-style collaboration):
 * the birthday bound is ~2^80 ids. Locally it is shown and addressed by a
 * short unique prefix (shortId); the full id is the canonical, merge-safe key.
 * Generated locally — no coordination server. See DESIGN.md.
 */
export function newId(): string {
  const r = webcrypto.getRandomValues(new Uint8Array(32));
  let out = "";
  for (let i = 0; i < 32; i++) out += CROCKFORD.charAt(r[i]! & 0x1f);
  return out;
}

/**
 * The shortest prefix of `id` that uniquely identifies it among `allIds`
 * (git-style abbreviation), within [min,max] chars; falls back to the full id
 * if no shorter unique prefix exists. Case-insensitive (Crockford base32 is
 * case-free). The prefix is unique at call time — it may later become ambiguous
 * as ids are added; matchIdPrefix re-checks ambiguity at resolve time.
 */
export function shortId(id: string, allIds: string[], min = 6, max = 12): string {
  const upper = id.toUpperCase();
  const all = allIds.map((x) => x.toUpperCase());
  for (let len = min; len <= max; len++) {
    const p = upper.slice(0, len);
    if (all.filter((x) => x.startsWith(p)).length === 1) return upper.slice(0, len);
  }
  return id;
}

/** All ids that case-insensitively start with `prefix` (Crockford is case-free). */
export function matchIdPrefix(prefix: string, ids: string[]): string[] {
  const p = prefix.toUpperCase();
  return ids.filter((id) => id.toUpperCase().startsWith(p));
}
