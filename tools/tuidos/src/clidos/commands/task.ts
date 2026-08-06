import { defineCommand } from "citty";
import { requireProject } from "../context";
import {
  listTasks,
  listAllTaskIds,
  getTask,
  createTask,
  updateTask,
  moveTask,
  setTaskCompleted,
  archiveTask,
  unarchiveTask,
  type TaskPatch,
} from "../../core/tasks";
import { listColumns } from "../../core/columns";
import { listMessages } from "../../core/messages";
import { listMediaForTask } from "../../core/media";
import { listTopicsForTask } from "../../core/topics";
import { guard, fail } from "../audit-view";
import { uid } from "../uid";
import {
  resolveTaskId,
  resolveColumnId,
  renderTaskList,
  renderTaskShow,
  renderTaskCreated,
  renderTaskMoved,
  renderTaskUpdated,
  renderTaskCompleted,
  renderTaskReopened,
  renderTaskArchived,
  renderTaskRestored,
} from "../card-view";
import { renderUsageShort, ROOT_PARENT, heading } from "../format";
import { messageSubcommand } from "./task-messages";
import { mediaSubcommand } from "./task-media";
import { topicSubcommand } from "./task-topics";

function parsePriority(s: string | undefined): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 4)
    fail(`invalid --priority: ${s} (0..4)`);
  return n;
}

function parseDue(s: string | undefined): number | null {
  if (s == null || s === "") return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms))
    fail(`invalid --due: ${s} (use an ISO date, e.g. 2026-07-15)`);
  return ms;
}

export const taskCommand = defineCommand({
  meta: {
    name: "task",
    description: "Manage a project's cards/tasks (use -p <id-or-name>)",
  },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List the project's tasks" },
      args: {
        column: {
          type: "string",
          alias: ["c"],
          description: "Only one column (id or name)",
        },
      },
      run({ args }) {
        const projectId = requireProject();
        const cols = listColumns(projectId);
        const colId = args.column
          ? resolveColumnId(projectId, args.column)
          : undefined;
        console.log(renderTaskList(listTasks(projectId, colId), cols));
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a card" },
      args: {
        title: {
          type: "positional",
          description: "Card title",
          required: true,
        },
        desc: {
          type: "string",
          alias: ["d"],
          description: "Summary (≤1024 chars)",
        },
        priority: { type: "string", description: "0 none .. 4 urgent" },
        assignee: { type: "string", description: "Peer id" },
        due: { type: "string", description: "ISO date (e.g. 2026-07-15)" },
        column: {
          type: "string",
          alias: ["c"],
          description: "Column id or name (default: first)",
        },
      },
      run({ args }) {
        if (!args.title) fail("title is required");
        const title = args.title;
        const projectId = requireProject();
        const column_id = args.column
          ? resolveColumnId(projectId, args.column)
          : null;
        const t = guard(() =>
          createTask(projectId, {
            title,
            description: args.desc ?? null,
            column_id,
            priority: parsePriority(args.priority),
            assignee: args.assignee ?? null,
            due_at: parseDue(args.due),
          }),
        );
        const ids = listAllTaskIds(projectId);
        console.log(renderTaskCreated(t.title, uid(t.id, ids)));
      },
    }),
    show: defineCommand({
      meta: {
        name: "show",
        description: "Show a card with its thread and media",
      },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
      },
      run({ args }) {
        if (!args.task) fail("task id is required");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const task = getTask(projectId, taskId);
        if (!task) fail(`no task '${args.task}'`);
        const taskIds = listAllTaskIds(projectId);
        console.log(
          renderTaskShow(
            task,
            listMessages(projectId, taskId),
            listMediaForTask(projectId, taskId),
            listColumns(projectId),
            listTopicsForTask(projectId, taskId),
            taskIds,
          ),
        );
      },
    }),
    move: defineCommand({
      meta: { name: "move", description: "Move a card to a column" },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
        column: {
          type: "positional",
          description: "Column id or name",
          required: true,
        },
      },
      run({ args }) {
        if (!args.task || !args.column) fail("move requires <task> <column>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const columnId = resolveColumnId(projectId, args.column);
        guard(() => moveTask(projectId, taskId, columnId));
        const name =
          listColumns(projectId).find((c) => c.id === columnId)?.name ??
          columnId;
        console.log(renderTaskMoved(args.task, name));
      },
    }),
    edit: defineCommand({
      meta: { name: "edit", description: "Edit a card's fields" },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
        title: { type: "string", description: "New title" },
        desc: { type: "string", alias: ["d"], description: "New summary" },
        priority: { type: "string", description: "0..4" },
        assignee: { type: "string", description: "Peer id" },
        estimate: { type: "string", description: "Non-negative int" },
        due: { type: "string", description: "ISO date" },
      },
      run({ args }) {
        if (!args.task) fail("task id is required");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const patch: TaskPatch = {};
        if (args.title != null) patch.title = args.title;
        if (args.desc != null) patch.description = args.desc;
        if (args.priority != null)
          patch.priority = parsePriority(args.priority);
        if (args.assignee != null) patch.assignee = args.assignee;
        if (args.estimate != null) {
          const n = Number(args.estimate);
          if (!Number.isInteger(n) || n < 0)
            fail(`invalid --estimate: ${args.estimate}`);
          patch.estimate = n;
        }
        if (args.due != null) patch.due_at = parseDue(args.due);
        guard(() => updateTask(projectId, taskId, patch));
        console.log(renderTaskUpdated(args.task));
      },
    }),
    done: defineCommand({
      meta: { name: "done", description: "Mark a card complete" },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
      },
      run({ args }) {
        if (!args.task) fail("task id is required");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        guard(() => setTaskCompleted(projectId, taskId, true));
        console.log(renderTaskCompleted(args.task));
      },
    }),
    reopen: defineCommand({
      meta: { name: "reopen", description: "Reopen a completed card" },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
      },
      run({ args }) {
        if (!args.task) fail("task id is required");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        guard(() => setTaskCompleted(projectId, taskId, false));
        console.log(renderTaskReopened(args.task));
      },
    }),
    archive: defineCommand({
      meta: { name: "archive", description: "Archive a card" },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
      },
      run({ args }) {
        if (!args.task) fail("task id is required");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const title = guard(() => archiveTask(projectId, taskId));
        console.log(renderTaskArchived(title));
      },
    }),
    unarchive: defineCommand({
      meta: { name: "unarchive", description: "Restore an archived card" },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
      },
      run({ args }) {
        if (!args.task) fail("task id is required");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const { title, column, relocated } = guard(() =>
          unarchiveTask(projectId, taskId),
        );
        console.log(renderTaskRestored(title, column, relocated));
      },
    }),
    message: messageSubcommand,
    media: mediaSubcommand,
    topic: topicSubcommand,
  },
  // Bare `clidos -p <id-or-name> task` = usage + listing (self-discovering).
  async run({ rawArgs }) {
    if (rawArgs.length > 0) return; // a subcommand was invoked
    const projectId = requireProject();
    console.log(await renderUsageShort(taskCommand, ROOT_PARENT));
    console.log();
    console.log(heading("Tasks"));
    console.log(renderTaskList(listTasks(projectId), listColumns(projectId)));
  },
});
