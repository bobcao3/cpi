import { defineCommand } from "citty";
import { requireProject } from "../context";
import { listMessages, createMessage, updateMessage, archiveMessage } from "../../core/messages";
import { guard, fail, warn } from "../audit-view";
import { resolveIdentity, authorString, fallbackWarning, fallbackRemedy } from "../../core/identity";
import { uid } from "../uid";
import {
  resolveTaskId, resolveMessageId, renderThread,
  renderMessageAdded, renderMessageEdited, renderMessageArchived,
} from "../card-view";

export const messageSubcommand = defineCommand({
  meta: { name: "message", description: "Manage a task's conversation thread" },
  subCommands: {
    add: defineCommand({
      meta: { name: "add", description: "Append a message (the first is the body)" },
      args: {
        task: { type: "positional", description: "Task id or prefix", required: true },
        content: { type: "positional", description: "Message text (quote multi-word)", required: true },
        author: { type: "string", description: "Override the author (default: your VCS user.name <user.email>)" },
      },
      run({ args }) {
        if (!args.task || !args.content) fail("add requires <task> <content>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        let author = args.author ?? null;
        if (!args.author) {
          const id = resolveIdentity();
          author = authorString(id);
          if (id.source === "fallback") warn(fallbackWarning(id), fallbackRemedy());
        }
        const m = guard(() => createMessage(projectId, taskId, author, args.content));
        const ids = listMessages(projectId, taskId).map((x) => x.id);
        console.log(renderMessageAdded(uid(m.id, ids)));
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List a task's thread" },
      args: { task: { type: "positional", description: "Task id or prefix", required: true } },
      run({ args }) {
        if (!args.task) fail("task id is required");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        console.log(renderThread(listMessages(projectId, taskId)));
      },
    }),
    edit: defineCommand({
      meta: { name: "edit", description: "Edit a message's content" },
      args: {
        task: { type: "positional", description: "Task id or prefix", required: true },
        message: { type: "positional", description: "Message id or prefix", required: true },
        content: { type: "positional", description: "New text", required: true },
      },
      run({ args }) {
        if (!args.task || !args.message || !args.content) fail("edit requires <task> <message> <content>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const messageId = resolveMessageId(projectId, taskId, args.message);
        guard(() => updateMessage(projectId, taskId, messageId, args.content));
        console.log(renderMessageEdited());
      },
    }),
    archive: defineCommand({
      meta: { name: "archive", description: "Archive (delete) a message" },
      args: {
        task: { type: "positional", description: "Task id or prefix", required: true },
        message: { type: "positional", description: "Message id or prefix", required: true },
      },
      run({ args }) {
        if (!args.task || !args.message) fail("archive requires <task> <message>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const messageId = resolveMessageId(projectId, taskId, args.message);
        guard(() => archiveMessage(projectId, taskId, messageId));
        console.log(renderMessageArchived());
      },
    }),
  },
});
