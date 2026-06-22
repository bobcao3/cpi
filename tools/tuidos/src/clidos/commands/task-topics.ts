import { defineCommand } from "citty";
import { requireProject } from "../context";
import { listTopicsForTask, attachTopic, detachTopic } from "../../core/topics";
import { guard, fail } from "../audit-view";
import {
  resolveTaskId, resolveTopicId, renderTaskTopics,
  renderTopicAttached, renderTopicDetached,
} from "../card-view";

export const topicSubcommand = defineCommand({
  meta: { name: "topic", description: "Tag a task with topics" },
  subCommands: {
    add: defineCommand({
      meta: { name: "add", description: "Attach a topic to a task" },
      args: {
        task: { type: "positional", description: "Task id or prefix", required: true },
        topic: { type: "positional", description: "Topic id or name", required: true },
      },
      run({ args }) {
        if (!args.task || !args.topic) fail("add requires <task> <topic>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const topicId = resolveTopicId(projectId, args.topic);
        const r = guard(() => attachTopic(projectId, taskId, topicId));
        console.log(renderTopicAttached(r.name, r.attached));
      },
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Detach a topic from a task" },
      args: {
        task: { type: "positional", description: "Task id or prefix", required: true },
        topic: { type: "positional", description: "Topic id or name", required: true },
      },
      run({ args }) {
        if (!args.task || !args.topic) fail("remove requires <task> <topic>");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        const topicId = resolveTopicId(projectId, args.topic);
        const r = guard(() => detachTopic(projectId, taskId, topicId));
        console.log(renderTopicDetached(r.name, r.detached));
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List a task's topics" },
      args: { task: { type: "positional", description: "Task id or prefix", required: true } },
      run({ args }) {
        if (!args.task) fail("task id is required");
        const projectId = requireProject();
        const taskId = resolveTaskId(projectId, args.task);
        console.log(renderTaskTopics(listTopicsForTask(projectId, taskId)));
      },
    }),
  },
});
