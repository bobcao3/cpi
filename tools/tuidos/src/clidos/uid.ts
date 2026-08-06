import pc from "picocolors";
import { shortId } from "../core/id";

const color: boolean = pc.isColorSupported;

const highlight = (s: string): string => (color ? pc.magenta(s) : s);
const dim = (s: string): string => (color ? pc.dim(s) : s);

/** Highlights the minimal unique prefix, pads to six characters, and includes an absent `id` in uniqueness checks. */
export function uid(id: string, ids: string[]): string {
  const set = ids.includes(id) ? ids : [...ids, id];
  const unique = shortId(id, set, 1, id.length);
  const display = id.slice(0, Math.max(unique.length, 6));
  return highlight(unique) + dim(display.slice(unique.length));
}
