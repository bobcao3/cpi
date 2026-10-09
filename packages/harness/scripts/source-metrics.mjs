import { resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import * as ast from "typescript/unstable/ast";

export function withSourceFiles(files, visit, contents = new Map()) {
  if (files.length > 10000) throw new Error("Source file limit exceeded");
  const api = new API({
    cwd: process.cwd(),
    fs: {
      readFile: (file) => contents.get(resolve(file)),
      fileExists: (file) => (contents.has(resolve(file)) ? true : undefined),
    },
  });
  let snapshot;
  try {
    const paths = files.map((file) => resolve(file));
    snapshot = api.updateSnapshot({ openFiles: paths });
    for (let index = 0; index < paths.length; index++) {
      const file = paths[index];
      const project = snapshot.getDefaultProjectForFile(file);
      const source = project?.program.getSourceFile(file);
      if (!source) throw new Error(`Cannot parse source file: ${file}`);
      visit(files[index], source);
    }
  } finally {
    try {
      snapshot?.dispose();
    } finally {
      api.close();
    }
  }
}

export function sourceMetrics(source) {
  const text = source.text;
  const commentLines = new Set();
  const ranges = new Map();
  const commentsAt = (position) => {
    for (const range of [
      ...(ast.getLeadingCommentRanges(text, position) ?? []),
      ...(ast.getTrailingCommentRanges(text, position) ?? []),
    ])
      ranges.set(range.pos, range.end);
  };
  const pending = [source];
  let statements = 0;
  let visited = 0;
  while (pending.length) {
    if (++visited > 1000000)
      throw new Error(`AST node limit exceeded: ${source.fileName}`);
    const node = pending.pop();
    if (ast.isStatement(node)) statements++;
    commentsAt(node.getFullStart());
    commentsAt(node.end);
    node.forEachChild(
      (child) => {
        pending.push(child);
      },
      (children) => {
        commentsAt(children.pos);
        commentsAt(children.end);
        if (pending.length + children.length > 1000000) {
          throw new Error(`AST queue limit exceeded: ${source.fileName}`);
        }
        for (const child of children) pending.push(child);
      },
    );
  }
  let uncommented = "";
  let offset = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const first = source.getLineAndCharacterOfPosition(start).line;
    const last = source.getLineAndCharacterOfPosition(end - 1).line;
    for (let line = first; line <= last; line++) commentLines.add(line);
    uncommented +=
      text.slice(offset, start) +
      text.slice(start, end).replace(/[^\r\n]/g, " ");
    offset = end;
  }
  uncommented += text.slice(offset);
  return {
    totalLines: text.split("\n").length,
    commentLines: commentLines.size,
    sourceLines: uncommented.split("\n").filter((line) => line.trim()).length,
    statements,
  };
}
