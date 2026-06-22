// Shared display helpers — pure functions, no deps, no JSX. Mirrors the
// clidos/format.ts + card-view.ts semantics so both clients render the same
// way (the data model is shared; the reading of it should be too).

/** Render a millisecond timestamp as a short relative age. */
export function relativeTime(ms: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** A short label for a task priority (0 none .. 4 urgent). "" for none. */
export function priorityLabel(p: number | null): string {
  if (p == null || p === 0) return "";
  return ["", "low", "med", "high", "urgent"][p] ?? `p${p}`;
}

/** A due date as YYYY-MM-DD, or null. */
export function dueDate(ms: number | null): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Human byte size, binary (KiB/MiB). */
export function humanSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MiB`;
}
