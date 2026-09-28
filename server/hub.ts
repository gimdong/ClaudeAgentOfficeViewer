import { watch, type FSWatcher } from "node:fs";
import type { Snapshot } from "../src/shared/types";

export interface HubOptions {
  intervalMs?: number;
  debounceMs?: number;
  watchDir?: string;
}

const WATCHED = /^(projects|sessions|teams|claude-office)([\\/]|$)/;

export class SnapshotHub {
  private snapshot: Snapshot | undefined;
  private key = "";
  private listeners = new Set<(s: Snapshot) => void>();
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly builder: { build(now?: number): Promise<Snapshot> },
    private readonly opts: HubOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.intervalMs ?? 3000);
    if (!this.opts.watchDir) return;
    try {
      this.watcher = watch(this.opts.watchDir, { recursive: true }, (_event, file) => {
        if (WATCHED.test(String(file ?? ""))) this.schedule();
      });
      this.watcher.on("error", (e) => console.warn(`[hub] 파일 감시 오류, 주기 갱신은 계속됩니다: ${e.message}`));
    } catch (e) {
      console.warn(`[hub] 파일 감시를 시작하지 못해 주기 갱신만 씁니다: ${(e as Error).message}`);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.watcher?.close();
  }

  current(): Snapshot {
    if (!this.snapshot) throw new Error("SnapshotHub가 아직 시작되지 않았습니다");
    return this.snapshot;
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const s = await this.builder.build();
          const { generatedAt: _ignored, ...rest } = s;
          const key = JSON.stringify(rest);
          this.snapshot = s;
          if (key !== this.key) {
            this.key = key;
            for (const l of this.listeners) l(s);
          }
        } while (this.again);
      } catch (e) {
        console.error("[hub] 스냅샷 생성 실패:", e);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private schedule(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), this.opts.debounceMs ?? 500);
  }
}
