import { readVcsCommand, readVcsCommandSync } from "./command.ts";
import type { VcsRepository } from "./types.ts";

export class CommandRepository implements VcsRepository {
  private readonly root: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly format: (value: string) => string;
  private readonly callbacks = new Set<() => void>();
  private status: string | null;
  private pending?: AbortController;
  private disposed = false;

  constructor(
    root: string,
    command: string,
    args: string[],
    format: (value: string) => string,
  ) {
    this.root = root;
    this.command = command;
    this.args = args;
    this.format = format;
    const value = readVcsCommandSync(command, args, root);
    this.status = value === null ? null : format(value);
  }

  getStatus(): string | null {
    return this.status;
  }

  onChange(callback: () => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  dispose(): void {
    this.disposed = true;
    this.pending?.abort();
    this.callbacks.clear();
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.pending) return;
    this.pending = new AbortController();
    try {
      const value = await readVcsCommand(
        this.command,
        this.args,
        this.root,
        this.pending.signal,
      );
      if (this.disposed) return;
      const status = value === null ? null : this.format(value);
      if (this.status === status) return;
      this.status = status;
      for (const callback of this.callbacks) callback();
    } finally {
      this.pending = undefined;
    }
  }
}
