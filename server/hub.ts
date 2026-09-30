import { watch, type FSWatcher } from "node:fs";
import type { Snapshot } from "../src/shared/types";
import { getLogger } from "./log";

export interface HubOptions {
  intervalMs?: number;
  debounceMs?: number;
  watchDir?: string;
  pokeMs?: number;
  /** 첫 빌드가 실패해 아직 스냅샷이 없을 때 대신 쓸 스냅샷(error 필드에 쉬운 말 원인). 다음 주기에 다시 빌드한다 */
  fallback?: (e: unknown) => Snapshot;
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
  private pokeTimer?: NodeJS.Timeout;

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
      this.watcher.on("error", (e) => getLogger().warn("hub", "watch error, polling continues", { error: e.message }));
    } catch (e) {
      getLogger().warn("hub", "watch unavailable, polling only", { error: String((e as Error)?.message ?? e) });
    }
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    clearTimeout(this.pokeTimer);
    this.watcher?.close();
  }

  /**
   * hook 이벤트가 올 때 부른다. 첫 호출 뒤 pokeMs(기본 200ms) 안에 한 번만 다시 만든다.
   * debounce가 아니라 throttle이다 — 이벤트가 끊임없이 와도 갱신이 밀리지 않고, 초당 5번을 넘지 않는다.
   */
  poke(): void {
    if (this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = undefined;
      void this.refresh();
    }, this.opts.pokeMs ?? 200);
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
        getLogger().error("hub", "snapshot build failed", { error: String((e as Error)?.message ?? e) });
        if (!this.snapshot && this.opts.fallback) {
          this.snapshot = this.opts.fallback(e);
          for (const l of this.listeners) l(this.snapshot);
        }
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
