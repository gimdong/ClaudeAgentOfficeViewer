import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TokenSum, UsageSummary } from "../../src/shared/types";
import { addSum, emptySum, usageToSum } from "../../src/shared/tokens";
import { readNewLines, type TailState } from "../lib/jsonlTail";
import { warnCaught } from "../log";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export class UsageCollector {
  private tails = new Map<string, TailState>();
  /** file -> (key -> 그 파일이 스스로 관측한 레코드). 같은 key가 여러 파일에 나타날 수 있어 파일별로 보관하고,
   *  대표(승자)는 조회 시점에 key별 total 최댓값으로 고른다. 이렇게 하면 한 파일이 삭제/reset돼도
   *  같은 key의 다른 파일 사본이 함께 사라지지 않는다. */
  private fileRecords = new Map<string, Map<string, UsageRecord>>();
  private last = new Map<string, LastUsage>();
  private mtimes = new Map<string, number>();

  constructor(private readonly projectsDir: string) {}

  async refresh(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.projectsDir, { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (await pathExists(this.projectsDir)) {
        // projectsDir은 있지만 순회 도중 하위 폴더가 사라진 경쟁 상태다.
        // 지금 무엇이 남아있는지 알 수 없으므로 이번 refresh는 상태를 건드리지 않고 다음 기회로 미룬다.
        return;
      }
      entries = []; // projectsDir 자체가 없다 -> 추적 중이던 파일을 전부 drop한다.
    }
    const files = entries.filter((f) => f.endsWith(".jsonl")).map((f) => join(this.projectsDir, f));
    const seen = new Set(files);
    for (const f of [...this.tails.keys()]) if (!seen.has(f)) this.dropFile(f);
    for (const f of files) {
      try {
        await this.readFile(f);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") this.dropFile(f);
        // 그 외 오류(EISDIR, EACCES 등)는 이 파일만 건너뛰고 기존 상태를 유지한 채 다음 파일을 계속 읽는다.
        else warnCaught("usage", "cannot read transcript", e, basename(f));
      }
    }
  }

  /** key별로 모든 파일의 사본 중 total이 가장 큰 것을 대표로 고른다. */
  private winners(): Map<string, UsageRecord> {
    const result = new Map<string, UsageRecord>();
    for (const recs of this.fileRecords.values()) {
      for (const [key, r] of recs) {
        const cur = result.get(key);
        if (!cur || r.sum.total > cur.sum.total) result.set(key, r);
      }
    }
    return result;
  }

  summary(now = Date.now()): UsageSummary {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    let today = emptySum();
    let last5h = emptySum();
    let last7d = emptySum();
    const byModel = new Map<string, TokenSum>();
    const hourly = new Array<number>(24).fill(0);

    for (const r of this.winners().values()) {
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
    const winners = this.winners();
    for (const key of this.fileRecords.get(file)?.keys() ?? []) {
      const w = winners.get(key);
      if (w && w.file === file) sum = addSum(sum, w.sum);
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

    let recs = this.fileRecords.get(file);
    if (!recs) this.fileRecords.set(file, (recs = new Map()));
    const prev = recs.get(key);
    if (!prev || sum.total > prev.sum.total) {
      recs.set(key, { key, ts, model, sum, file });
    }
    const last = this.last.get(file);
    if (!last || ts >= last.ts) this.last.set(file, { ts, model, sum });
  }

  private dropFile(file: string): void {
    this.fileRecords.delete(file);
    this.tails.delete(file);
    this.last.delete(file);
    this.mtimes.delete(file);
  }
}
