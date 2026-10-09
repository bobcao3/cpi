import { computeEditsDiff, type Edit } from "./builtins/edit-preview.ts";

export class ToolPresentationJobs {
  private key?: string;
  private generation = 0;
  private disposed = false;

  update(
    toolName: string,
    args: unknown,
    cwd: string,
    state: Record<string, unknown>,
    invalidate: () => void,
  ): void {
    if (this.disposed || toolName !== "edit") return;
    const value = args as {
      path?: unknown;
      file_path?: unknown;
      edits?: unknown;
      oldText?: unknown;
      newText?: unknown;
    };
    const path = value?.file_path ?? value?.path;
    if (typeof path !== "string") return;
    const edits = Array.isArray(value.edits)
      ? value.edits
      : [{ oldText: value.oldText, newText: value.newText }];
    if (
      !edits.length ||
      edits.length > 256 ||
      edits.some(
        (edit) =>
          typeof edit?.oldText !== "string" ||
          typeof edit?.newText !== "string",
      )
    )
      return;
    const key = JSON.stringify([cwd, path, edits]);
    if (key.length > 2_000_000 || key === this.key) return;
    this.key = key;
    const generation = ++this.generation;
    delete state.editPreview;
    void computeEditsDiff(path, edits as Edit[], cwd).then((preview) => {
      if (this.disposed || generation !== this.generation) return;
      state.editPreview = preview;
      invalidate();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
  }
}
