export interface ToolTreeTickTarget {
  needsAnimation(): boolean;
  tick(frame: number, elapsed: boolean): void;
}

export class ToolTreeTicker {
  private readonly targets = new Set<ToolTreeTickTarget>();
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private second = 0;

  register(target: ToolTreeTickTarget): void {
    if (!this.targets.has(target) && this.targets.size >= 1024)
      this.targets.delete(this.targets.values().next().value!);
    this.targets.add(target);
    if (this.timer) return;
    this.timer = setInterval(() => {
      const second = Math.floor(Date.now() / 1000);
      const elapsed = second !== this.second;
      this.second = second;
      this.frame++;
      for (const target of this.targets)
        if (target.needsAnimation()) target.tick(this.frame, elapsed);
    }, 100);
    this.timer.unref();
  }

  unregister(target: ToolTreeTickTarget): void {
    this.targets.delete(target);
    if (this.targets.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.targets.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
