/** Sensible out-of-the-box defaults applied to a new project (and re-appliable
 *  via `clidos project add-defaults`). Columns are a minimal kanban flow; topics
 *  are broadly-useful cross-cutting work categories. Names are labels only —
 *  rename or archive them freely. Adjust to taste. */
export const DEFAULT_COLUMNS = [
  ["Backlog", 0],
  ["In Progress", 1],
  ["Done", 2],
] as const;

export const DEFAULT_TOPICS = ["Bug", "Feature", "Maintenance"] as const;
