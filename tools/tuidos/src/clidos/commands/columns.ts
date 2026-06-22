import { defineCommand } from "citty";
import { requireProject } from "../context";
import {
  listColumns, createColumn, renameColumn, moveColumn, archiveColumn,
  countTasksByColumn,
} from "../../core/columns";
import { guard, fail } from "../audit-view";
import { uid } from "../uid";
import {
  resolveColumnId, renderColumnList, renderColumnCreated,
  renderColumnRenamed, renderColumnMoved, renderColumnArchived,
} from "../card-view";
import { renderUsageShort, ROOT_PARENT, heading } from "../format";

export const columnsCommand = defineCommand({
  meta: { name: "columns", description: "Manage a project's columns (use -p <id-or-name>)" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List the project's columns" },
      run() {
        const projectId = requireProject();
        console.log(renderColumnList(listColumns(projectId), countTasksByColumn(projectId)));
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a column (appended to the end)" },
      args: { name: { type: "positional", description: "Column name", required: true } },
      run({ args }) {
        if (!args.name) fail("column name is required");
        const name = args.name;
        const projectId = requireProject();
        const c = guard(() => createColumn(projectId, name));
        const ids = listColumns(projectId).map((x) => x.id);
        console.log(renderColumnCreated(c.name, uid(c.id, ids)));
      },
    }),
    rename: defineCommand({
      meta: { name: "rename", description: "Rename a column" },
      args: {
        column: { type: "positional", description: "Column id or name", required: true },
        name: { type: "positional", description: "New name", required: true },
      },
      run({ args }) {
        if (!args.column || !args.name) fail("rename requires <column> <new-name>");
        const projectId = requireProject();
        const columnId = resolveColumnId(projectId, args.column);
        const oldName = guard(() => renameColumn(projectId, columnId, args.name));
        console.log(renderColumnRenamed(oldName, args.name));
      },
    }),
    move: defineCommand({
      meta: { name: "move", description: "Reorder a column to a 0-based position" },
      args: {
        column: { type: "positional", description: "Column id or name", required: true },
        position: { type: "positional", description: "0-based position", required: true },
      },
      run({ args }) {
        if (!args.column || args.position == null) fail("move requires <column> <position>");
        const n = Number(args.position);
        if (!Number.isInteger(n) || n < 0) fail(`invalid position: ${args.position} (must be a non-negative integer)`);
        const projectId = requireProject();
        const columnId = resolveColumnId(projectId, args.column);
        guard(() => moveColumn(projectId, columnId, n));
        const name = listColumns(projectId).find((c) => c.id === columnId)?.name ?? columnId;
        console.log(renderColumnMoved(name, n));
      },
    }),
    archive: defineCommand({
      meta: { name: "archive", description: "Archive a column (move its tasks first)" },
      args: { column: { type: "positional", description: "Column id or name", required: true } },
      run({ args }) {
        if (!args.column) fail("column id or name is required");
        const projectId = requireProject();
        const columnId = resolveColumnId(projectId, args.column);
        const name = guard(() => archiveColumn(projectId, columnId));
        console.log(renderColumnArchived(name));
      },
    }),
  },
  // Bare `clidos -p <id-or-name> columns` = usage + listing (self-discovering).
  async run({ rawArgs }) {
    if (rawArgs.length > 0) return; // a subcommand was invoked
    const projectId = requireProject();
    console.log(await renderUsageShort(columnsCommand, ROOT_PARENT));
    console.log();
    console.log(heading("Columns"));
    console.log(renderColumnList(listColumns(projectId), countTasksByColumn(projectId)));
  },
});
