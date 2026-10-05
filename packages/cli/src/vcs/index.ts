import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  VcsSource,
  VcsSourceFactory,
} from "@earendil-works/pi-coding-agent";
import { jjProvider } from "./jj.ts";
import type { VcsProvider, VcsRepository } from "./types.ts";

type Selection = { provider: VcsProvider; root: string };

class ProjectSource implements VcsSource {
  private cwd: string;
  private readonly providers: readonly VcsProvider[];
  private readonly callbacks = new Set<() => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private selection: Selection | null = null;
  private repository: VcsRepository | null = null;
  private disposed = false;

  constructor(cwd: string, providers: readonly VcsProvider[]) {
    this.cwd = cwd;
    this.providers = providers;
    this.updateRepository();
    this.timer = setInterval(() => {
      if (this.disposed) return;
      this.updateRepository();
      void this.repository?.refresh?.();
    }, 2000);
    this.timer.unref();
  }

  getStatus(): string | null {
    return this.repository?.getStatus() ?? null;
  }

  setCwd(cwd: string): void {
    if (this.cwd === cwd) return;
    this.cwd = cwd;
    this.updateRepository();
  }

  onChange(callback: () => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.repository?.dispose();
    this.callbacks.clear();
  }

  private detect(): Selection | null {
    let directory = resolve(this.cwd);
    for (let depth = 0; depth < 128; depth++) {
      for (const provider of this.providers) {
        if (provider.detect(directory)) return { provider, root: directory };
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return null;
  }

  private updateRepository(): void {
    const selection = this.detect();
    if (
      this.selection?.provider === selection?.provider &&
      this.selection?.root === selection?.root
    )
      return;
    this.repository?.dispose();
    this.selection = selection;
    this.repository = selection
      ? selection.provider.open(selection.root)
      : null;
    this.repository?.onChange(() => this.notify());
    this.notify();
  }

  private notify(): void {
    for (const callback of this.callbacks) callback();
  }
}

export const createVcsSource: VcsSourceFactory = (cwd, git) => {
  const gitProvider: VcsProvider = {
    id: "git",
    detect: (directory) => existsSync(join(directory, ".git")),
    open: () => {
      git.refresh();
      return {
        getStatus: () => git.getStatus(),
        onChange: () => () => {},
        dispose: () => {},
      };
    },
  };
  return new ProjectSource(cwd, [jjProvider, gitProvider]);
};
