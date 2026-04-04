import { type FSWatcher, watch } from "node:fs";

export class CampWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
    private readonly debounceMs: number = 500,
  ) {}

  start(): void {
    this.stopped = false;
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          if (!this.stopped) this.onChange();
        }, this.debounceMs);
      });
    } catch {
      // fs.watch can fail on some platforms/dirs — silently degrade
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
