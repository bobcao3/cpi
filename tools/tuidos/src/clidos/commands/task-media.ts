import { defineCommand } from "citty";
import { requireProject } from "../context";
import { listMediaForTask, addMedia, archiveMedia } from "../../core/media";
import { mediaPath } from "../../core/paths";
import { guard, fail } from "../audit-view";
import { uid } from "../uid";
import { existsSync, copyFileSync } from "node:fs";
import {
  resolveTaskId,
  resolveMessageId,
  resolveMediaId,
  renderMediaAdded,
  renderMediaRemoved,
  renderMediaList,
  renderMediaExported,
} from "../card-view";

export const mediaSubcommand = defineCommand({
  meta: {
    name: "media",
    description: "Manage media attached to a task's messages",
  },
  subCommands: {
    add: defineCommand({
      meta: { name: "add", description: "Attach a file to a message" },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
        message: {
          type: "positional",
          description: "Message id or prefix",
          required: true,
        },
        file: {
          type: "positional",
          description: "Path to the file",
          required: true,
        },
        filename: { type: "string", description: "Override stored filename" },
      },
      run({ args }) {
        if (!args.task || !args.message || !args.file)
          fail("add requires <task> <message> <file>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const messageId = resolveMessageId(projectId, taskId, args.message);
        const m = guard(() =>
          addMedia(
            projectId,
            taskId,
            messageId,
            args.file,
            args.filename ?? null,
            null,
          ),
        );
        const ids = listMediaForTask(projectId, taskId).map((x) => x.id);
        console.log(renderMediaAdded(m.filename, uid(m.id, ids)));
      },
    }),
    list: defineCommand({
      meta: {
        name: "list",
        description: "List media across a task's messages",
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
        console.log(renderMediaList(listMediaForTask(projectId, taskId)));
      },
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Archive (detach) a media row" },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
        media: {
          type: "positional",
          description: "Media id or prefix",
          required: true,
        },
      },
      run({ args }) {
        if (!args.task || !args.media) fail("remove requires <task> <media>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const mediaId = resolveMediaId(projectId, taskId, args.media);
        const filename = guard(() => archiveMedia(projectId, taskId, mediaId));
        console.log(renderMediaRemoved(filename));
      },
    }),
    export: defineCommand({
      meta: {
        name: "export",
        description: "Copy a media blob to a destination path",
      },
      args: {
        task: {
          type: "positional",
          description: "Task id or prefix",
          required: true,
        },
        media: {
          type: "positional",
          description: "Media id or prefix",
          required: true,
        },
        dest: {
          type: "positional",
          description: "Destination path",
          required: true,
        },
      },
      run({ args }) {
        if (!args.task || !args.media || !args.dest)
          fail("export requires <task> <media> <dest>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const mediaId = resolveMediaId(projectId, taskId, args.media);
        const media = listMediaForTask(projectId, taskId).find(
          (m) => m.id === mediaId,
        );
        if (!media) fail(`no media '${args.media}'`);
        const blob = mediaPath(projectId, media.content_hash);
        if (!existsSync(blob)) fail(`blob missing on disk: ${blob}`);
        copyFileSync(blob, args.dest);
        console.log(renderMediaExported(media.filename, args.dest));
      },
    }),
  },
});
