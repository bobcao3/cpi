import { defineCommand } from "citty";
import { createProject, listProjects, applyProjectDefaults } from "../../core/db";
import { uid } from "../uid";
import { collectAudit, parseLimit, resolveProjectId, fail, guard } from "../audit-view";
import {
  renderProjectList, renderAuditTimeline, renderProjectCreated,
  renderProjectDefaultsApplied, renderUsageShort, ROOT_PARENT, heading, note,
} from "../format";

export const projectCommand = defineCommand({
  meta: { name: "project", description: "Manage projects" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List all projects" },
      run() {
        console.log(renderProjectList(listProjects()));
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new project (with default columns + topics)" },
      args: {
        name: { type: "positional", description: "Project name", required: true },
        description: { type: "string", alias: ["d"], description: "Short description" },
        skipDefaults: { type: "boolean", description: "Skip seeding default columns and topics" },
      },
      run({ args }) {
        if (!args.name) fail("project name is required");
        const name = args.name;
        const description = args.description ?? null;
        const applyDefaults = !args.skipDefaults;
        const project = guard(() => createProject(name, description, { applyDefaults }));
        const ids = listProjects().map((p) => p.id);
        console.log(renderProjectCreated(project.name, uid(project.id, ids)));
        console.log(
          note(
            applyDefaults
              ? "seeded default columns + topics (pass --skip-defaults to skip)"
              : "no defaults — run `clidos project add-defaults <project>` to add them",
          ),
        );
      },
    }),
    "add-defaults": defineCommand({
      meta: { name: "add-defaults", description: "Seed sensible default columns and topics" },
      args: { project: { type: "positional", description: "Project id or name", required: true } },
      run({ args }) {
        if (!args.project) fail("project is required");
        const projectId = resolveProjectId(args.project);
        const result = guard(() => applyProjectDefaults(projectId));
        console.log(renderProjectDefaultsApplied(result));
      },
    }),
    audit: defineCommand({
      meta: { name: "audit", description: "View one project's activity log" },
      args: {
        project: { type: "positional", description: "Project id or name", required: true },
        limit: { type: "string", alias: ["n"], description: "Max events to show (0 = all)", default: "50" },
      },
      run({ args }) {
        if (!args.project) fail("project is required");
        const projectId = resolveProjectId(args.project);
        const limit = parseLimit(args.limit);
        console.log(renderAuditTimeline(collectAudit(limit, projectId), false));
      },
    }),
  },
  // Bare `clidos project` = usage + listing (self-discovering).
  async run({ rawArgs }) {
    // A subcommand was invoked: citty runs ancestor run()s after the leaf, so bail.
    if (rawArgs.length > 0) return;
    console.log(await renderUsageShort(projectCommand, ROOT_PARENT));
    console.log();
    console.log(heading("Projects"));
    console.log(renderProjectList(listProjects()));
  },
});
