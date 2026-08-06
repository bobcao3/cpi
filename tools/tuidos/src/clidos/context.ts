import { resolveProjectId, fail } from "./audit-view";

let projectArg: string | null = null;

export function setProjectArg(value: string): void {
  projectArg = value;
}

export function requireProject(): string {
  if (projectArg == null) {
    fail(
      "no project selected — pass --project <id> (e.g. clidos -p <project-id> topics)",
    );
  }
  return resolveProjectId(projectArg);
}
