import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localFixture } from "./local-fixture.mjs";

export async function observationFixture() {
  let path;
  const fixture = await localFixture(({ messages }) => {
    const text = (message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? "").join("\n");
    const index = messages.findLastIndex(
      (message) =>
        message.role === "user" &&
        /Reply (?:exactly|only)|Read .*with the read tool|List integers|Make two sh tool calls/.test(
          text(message),
        ),
    );
    if (index < 0) throw new Error("Unrecognized observation fixture task");
    const task = text(messages[index]);
    const results = messages
      .slice(index + 1)
      .filter((message) => message.role === "tool");
    if (task.includes("List integers"))
      return {
        chunks: Array.from({ length: 1000 }, (_, i) => `${i + 1} `),
        delayMs: 20,
      };
    if (task.includes("Make two sh tool calls"))
      return results.length
        ? { content: "DONE" }
        : {
            tools: [
              {
                name: "sh",
                args: {
                  description: "First fixture",
                  command: "printf FIRST_DISPLAY_OK",
                },
              },
              {
                name: "sh",
                args: {
                  description: "Second fixture",
                  command: "printf SECOND_DISPLAY_OK",
                },
              },
            ],
          };
    if (task.includes("Read ") && !results.length)
      return { tools: [{ name: "read", args: { path } }] };
    if (task.includes("*** Begin Patch"))
      return { content: task.slice(task.indexOf("*** Begin Patch")) };
    if (task.includes("VIEWER_OBSERVATION_OK"))
      return {
        content: JSON.stringify({
          one_line_summary: "VIEWER_OBSERVATION_OK",
          ranges: [],
        }),
      };
    const marker = [
      "FIRST_DONE",
      "SECOND_DONE",
      "CLI_OBSERVATION_OK",
      "FORK_OBSERVATION_OK",
      "ACTIVITY_OK",
    ].find((marker) => task.includes(marker));
    if (!marker)
      throw new Error(`Unrecognized observation fixture task: ${task}`);
    return { content: marker };
  });
  path = join(fixture.directory, "fixture.txt");
  await writeFile(path, "OBSERVATION_CONTENT\n\n\nsecond line\n");
  return { ...fixture, path };
}
