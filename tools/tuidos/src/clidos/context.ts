import { resolveProjectId, fail } from "./audit-view";

// The `--project`/`-p` global flag is stripped pre-parse in index.ts and stored
// here as the raw id (ULID). Project-scoped commands (topics, …) resolve it via
// requireProject(). Module-level (single process invocation) — not an env var.
let projectArg: string | null = null;

/** Set by the global-flag pre-parse (`--project`/`-p`). */
export function setProjectArg(value: string): void {
  projectArg = value;
}

/** Resolve the current --project context to a project id, or fail cleanly. */
export function requireProject(): string {
  if (projectArg == null) {
    fail("no project selected — pass --project <id> (e.g. clidos -p <project-id> topics)");
  }
  return resolveProjectId(projectArg);
}
