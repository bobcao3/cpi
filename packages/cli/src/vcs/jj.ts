import { existsSync } from "node:fs";
import { join } from "node:path";
import { CommandRepository } from "./command-repository.ts";
import type { VcsProvider } from "./types.ts";

const args = [
  "log",
  "-r",
  "@",
  "-T",
  'if(bookmarks.len()>0, bookmarks.map(|b| b.name()).join(" "), change_id.short())',
  "--no-graph",
  "--ignore-working-copy",
  "--color=never",
];

export const jjProvider: VcsProvider = {
  id: "jj",
  detect: (directory) => existsSync(join(directory, ".jj")),
  open: (root) =>
    new CommandRepository(root, "jj", args, (value) => `jj:${value}`),
};
