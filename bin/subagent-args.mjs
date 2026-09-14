export const SUBAGENT_USAGE =
  "usage: subagent [-p|--provider provider] [-m|--model [provider/]model[:effort]] [-s|--session-id session-id] [task]";

const OPTIONS = new Map([
  ["-p", "provider"],
  ["--provider", "provider"],
  ["-m", "model"],
  ["--model", "model"],
  ["-s", "sessionId"],
  ["--session-id", "sessionId"],
]);

export function parseSubagentArgs(argv) {
  const result = {
    provider: "",
    providerExplicit: false,
    model: "",
    sessionId: "",
    task: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") {
      result.task.push(...argv.slice(index + 1));
      break;
    }
    const option = OPTIONS.get(argument);
    if (option) {
      const value = argv[++index];
      if (!value) throw new Error(SUBAGENT_USAGE);
      result[option] = value;
      if (option === "provider") result.providerExplicit = true;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(SUBAGENT_USAGE);
    result.task.push(argument);
  }
  return result;
}
