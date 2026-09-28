import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TokenSum, UsageSummary } from "../../src/shared/types";
import { addSum, emptySum, usageToSum } from "../../src/shared/tokens";
import { readNewLines, type TailState } from "../lib/jsonlTail";

export interface LastUsage {
  ts: number;
  model: string;
  sum: TokenSum;
}

interface UsageRecord extends LastUsage {
  key: string;
  file: string;
}

const HOUR = 3_600_000;

export class UsageCollector {
  private tails = new Map<string, TailState>();
  private records = new Map<string, UsageRecord>();
  private fileKeys = new Map<string, Set<string>>();
  private last = new Map<string, LastUsage>();
  private mtimes = new Map<string, number>();

  constructor(private readonly projectsDir: string) {}

  async refresh(): Promise<void> {
    let files: string[] = [];
    try {
      const entries = await readdir(this.projectsDir, { recursive: true });
      files = entries.filter((f) => f.endsWith(".jsonl")).map((f) => join(this.projectsDir, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const seen = new Set(files);
    for (const f of [...this.tails.keys()]) if (!seen.has(f)) this.dropFile(f);
    for (const f of files) {
      try {
        await this.readFile(f);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        this.dropFile(f);
      }
    }
  }

  summary(now = Date.now()): UsageSummary {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    let today = emptySum();
    let last5h = emptySum();
    let last7d = emptySum();
    const byModel = new Map<string, TokenSum>();
    const hourly = new Array<number>(24).fill(0);

    for (const r of this.records.values()) {
      const age = now - r.ts;
      if (r.ts >= midnight.getTime() && age >= 0) today = addSum(today, r.sum);
      if (age < 0) continue;
      if (age < 5 * HOUR) last5h = addSum(last5h, r.sum);
      if (age < 168 * HOUR) {
        last7d = addSum(last7d, r.sum);
        byModel.set(r.model, addSum(byModel.get(r.model) ?? emptySum(), r.sum));
      }
      const bucket = 23 - Math.floor(age / HOUR);
      if (bucket >= 0) hourly[bucket] += r.sum.total;
    }
    return {
      today,
      last5h,
      last7d,
      byModel: [...byModel].map(([model, sum]) => ({ model, ...sum })).sort((a, b) => b.total - a.total),
      hourly,
    };
  }

  fileTotal(file: string): TokenSum {
    let sum = emptySum();
    for (const k of this.fileKeys.get(file) ?? []) {
      const r = this.records.get(k);
      if (r && r.file === file) sum = addSum(sum, r.sum);
    }
    return sum;
  }

  lastUsage(file: string): LastUsage | undefined {
    return this.last.get(file);
  }

  mtime(file: string): number | undefined {
    return this.mtimes.get(file);
  }

  findFile(pred: (path: string) => boolean): string | undefined {
    for (const f of this.tails.keys()) if (pred(f)) return f;
    return undefined;
  }

  private async readFile(file: string): Promise<void> {
    const st = await stat(file);
    const prev = this.tails.get(file);
    const res = await readNewLines(file, prev);
    if (res.reset && prev) this.dropFile(file);
    this.mtimes.set(file, st.mtimeMs);
    this.tails.set(file, res.state);
    for (const line of res.lines) this.ingest(file, line);
  }

  private ingest(file: string, line: unknown): void {
    const l = line as { type?: string; requestId?: string; uuid?: string; timestamp?: string; message?: { id?: string; model?: unknown; usage?: unknown } };
    if (l?.type !== "assistant" || !l.message?.usage) return;
    const ts = Date.parse(l.timestamp ?? "");
    if (!Number.isFinite(ts)) return;
    const model = typeof l.message.model === "string" ? l.message.model : "unknown";
    if (model === "<synthetic>") return;
    const sum = usageToSum(l.message.usage);
    const key = l.requestId ?? l.message.id ?? `${file}:${l.uuid}`;

    const prev = this.records.get(key);
    if (!prev || sum.total > prev.sum.total) {
      this.records.set(key, { key, ts, model, sum, file });
      let keys = this.fileKeys.get(file);
      if (!keys) this.fileKeys.set(file, (keys = new Set()));
      keys.add(key);
    }
    const last = this.last.get(file);
    if (!last || ts >= last.ts) this.last.set(file, { ts, model, sum });
  }

  private dropFile(file: string): void {
    for (const k of this.fileKeys.get(file) ?? []) {
      if (this.records.get(k)?.file === file) this.records.delete(k);
    }
    this.fileKeys.delete(file);
    this.tails.delete(file);
    this.last.delete(file);
    this.mtimes.delete(file);
  }
}
