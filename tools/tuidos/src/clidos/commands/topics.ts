import { defineCommand } from "citty";
import { requireProject } from "../context";
import { listTopics, listAllTopics, createTopic, renameTopic, archiveTopic } from "../../core/topics";
import { listAllProjects } from "../../core/db";
import { guard, fail } from "../audit-view";
import { shortId, matchIdPrefix } from "../../core/id";
import { renderTopicList, renderTopicCreated, renderTopicRenamed, renderTopicArchived, renderUsageShort, ROOT_PARENT, heading } from "../format";

/** Resolve a topic reference to its id within a project: exact id, exact
 *  name, an unambiguous id prefix (git-style), or a case-insensitive name.
 *  Names are unique per project (UNIQUE); prefixes are re-checked for
 *  ambiguity. Core never keys by name. */
function resolveTopicId(projectId: string, arg: string): string {
  if (!arg) fail("topic id or name is required");
  const topics = listAllTopics(projectId);
  const ids = topics.map((t) => t.id);
  if (ids.includes(arg)) return arg;
  const exact = topics.find((t) => t.name === arg);
  if (exact) return exact.id;
  const pm = matchIdPrefix(arg, ids);
  if (pm.length > 1) fail(`ambiguous id prefix '${arg}' — matches ${pm.length} topics (use more characters)`);
  const pmMatch = pm[0];
  if (pmMatch) return pmMatch;
  const lower = arg.toLowerCase();
  const ci = topics.filter((t) => t.name.toLowerCase() === lower);
  if (ci.length > 1) fail(`ambiguous topic name '${arg}'`);
  const ciMatch = ci[0];
  if (ciMatch) return ciMatch.id;
  fail(`no topic '${arg}' in this project`);
}

export const topicsCommand = defineCommand({
  meta: { name: "topics", description: "Manage a project's topics (use --project/-p <id-or-name>)" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List the project's topics" },
      run() {
        console.log(renderTopicList(listTopics(requireProject())));
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a topic" },
      args: { name: { type: "positional", description: "Topic name", required: true } },
      run({ args }) {
        if (!args.name) fail("topic name is required");
        const name = args.name;
        const projectId = requireProject();
        const t = guard(() => createTopic(projectId, name));
        const ids = listTopics(projectId).map((x) => x.id);
        console.log(renderTopicCreated(t.name, shortId(t.id, ids)));
      },
    }),
    rename: defineCommand({
      meta: { name: "rename", description: "Rename a topic" },
      args: {
        topic: { type: "positional", description: "Topic id or name", required: true },
        name: { type: "positional", description: "New name", required: true },
      },
      run({ args }) {
        if (!args.topic || !args.name) fail("rename requires <topic-id-or-name> <new-name>");
        const topic = args.topic;
        const newName = args.name;
        const projectId = requireProject();
        const topicId = resolveTopicId(projectId, topic);
        const oldName = guard(() => renameTopic(projectId, topicId, newName));
        console.log(renderTopicRenamed(oldName, newName));
      },
    }),
    archive: defineCommand({
      meta: { name: "archive", description: "Archive a topic" },
      args: { topic: { type: "positional", description: "Topic id or name", required: true } },
      run({ args }) {
        if (!args.topic) fail("topic id or name is required");
        const topic = args.topic;
        const projectId = requireProject();
        const topicId = resolveTopicId(projectId, topic);
        const name = guard(() => archiveTopic(projectId, topicId));
        console.log(renderTopicArchived(name));
      },
    }),
  },
  // Bare `clidos -p <id-or-name> topics` = usage + listing (self-discovering).
  async run({ rawArgs }) {
    if (rawArgs.length > 0) return; // a subcommand was invoked
    const projectId = requireProject();
    const projectName = listAllProjects().find((p) => p.id === projectId)?.name ?? projectId;
    console.log(await renderUsageShort(topicsCommand, ROOT_PARENT));
    console.log();
    console.log(heading(`Topics in \`${projectName}\``));
    console.log(renderTopicList(listTopics(projectId)));
  },
});
