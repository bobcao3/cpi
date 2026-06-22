import pc from "picocolors";
import { shortId } from "../core/id";

// Single source of truth for whether color is emitted — matches format.ts.
// picocolors is false when piped or under NO_COLOR, true in a TTY or with
// FORCE_COLOR, so piped/non-TTY output stays clean (no markup noise).
const color: boolean = pc.isColorSupported;

// The uid highlight: vivid magenta in a TTY — distinct from cyan names
// (accent), green ✓ (ok), and dim meta. Only the minimal unique prefix is
// highlighted; the rest of the ≥6-char display is dimmed so the prefix stands
// out. Both are plain when color is off (piped tables stay clean).
const highlight = (s: string): string => (color ? pc.magenta(s) : s);
const dim = (s: string): string => (color ? pc.dim(s) : s);

/**
 * Render `id` with its minimal unique prefix highlighted and the rest of the
 * ≥6-char display dimmed. The minimal unique prefix has no lower bound (a lone
 * id is unique at 1 char), so only that part — however short — is magenta; the
 * display is padded to at least 6 chars and the padding is dim. `ids` is every
 * id in scope — the listed set, or the set before a create; if `id` is not yet
 * in `ids` it is counted too, so the prefix is never ambiguous. Pass the live
 * set; never a single-element list.
 */
export function uid(id: string, ids: string[]): string {
  const set = ids.includes(id) ? ids : [...ids, id];
  const unique = shortId(id, set, 1, id.length);             // minimal unique (no floor)
  const display = id.slice(0, Math.max(unique.length, 6));  // show at least 6 chars
  return highlight(unique) + dim(display.slice(unique.length));
}
