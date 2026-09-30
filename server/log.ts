import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./events/summarize";

export type Level = "info" | "warn" | "error";
export interface LogLine { t: string; level: Level; src: string; msg: string; data?: Record<string, unknown> }
export interface LoggerOptions { dir: string; now?: () => number; home?: string; maxBytes?: number; retainDays?: number; dedupeMs?: number }

const DAY = 86_400_000;
const FILE = /^office-(\d{4}-\d{2}-\d{2})\.log$/;

/**
 * 문자열마다 redact()를 거치고 홈 경로를 "~"로 바꾼다(사용자 이름 보호). 객체 키·값과 배열은 재귀.
 * Claude Code 프로젝트 폴더 이름은 홈 경로의 영숫자 아닌 문자를 "-"로 바꾼 형태(-Users-name-…)라 그것도 바꾼다.
 */
export function scrub(v: unknown, home: string): unknown {
  if (typeof v === "string") return redact(home ? v.split(home).join("~").split(home.replace(/[^A-Za-z0-9]/g, "-")).join("~") : v);
  if (Array.isArray(v)) return v.map((x) => scrub(x, home));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k, home), scrub(x, home)]));
  return v;
}

/**
 * 한 줄에 JSON 하나(JSON Lines)로 `office-YYYY-MM-DD.log`에 쓴다. 로거는 종료 직전에도 불리므로 동기 API를 쓴다.
 * 쓰기 실패는 던지지 않는다 — 로그 때문에 서버가 멈추면 안 된다.
 */
export class Logger {
  readonly dir: string;
  private readonly now: () => number;
  private readonly home: string;
  private readonly maxBytes: number;
  private readonly retainDays: number;
  private readonly dedupeMs: number;
  private capped = ""; // 한도에 닿은 날짜
  private warned = new Map<string, { at: number; suppressed: number }>();
  private errors: number[] = [];

  constructor(o: LoggerOptions) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
    this.home = o.home ?? homedir();
    this.maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
    this.retainDays = o.retainDays ?? 7;
    this.dedupeMs = o.dedupeMs ?? 10 * 60_000;
  }

  info(src: string, msg: string, data?: Record<string, unknown>): void {
    this.write("info", src, msg, data);
  }

  error(src: string, msg: string, data?: Record<string, unknown>): void {
    const now = this.now();
    while (this.errors.length && this.errors[0] < now - DAY) this.errors.shift(); // 24시간 넘은 기록은 버린다
    this.errors.push(now);
    this.write("error", src, msg, data);
  }

  /** 같은 src+msg는 dedupeMs(기본 10분)에 한 번만 쓰고, 그 사이 억제한 건수를 다음 줄의 data.suppressed에 붙인다. */
  warn(src: string, msg: string, data?: Record<string, unknown>): void {
    const key = `${src}\u0000${msg}`;
    const w = this.warned.get(key);
    const now = this.now();
    if (w && now - w.at < this.dedupeMs) {
      w.suppressed++;
      return;
    }
    this.warned.set(key, { at: now, suppressed: 0 });
    this.write("warn", src, msg, w?.suppressed ? { ...data, suppressed: w.suppressed } : data);
  }

  errorsSince(ms: number): number {
    return this.errors.filter((t) => t >= ms).length;
  }

  cleanup(): void {
    if (!this.dir) return;
    try {
      const cutoff = this.now() - this.retainDays * DAY;
      for (const f of readdirSync(this.dir)) {
        const m = FILE.exec(f);
        if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) unlinkSync(join(this.dir, f));
      }
    } catch {
      /* 폴더가 없으면 지울 것도 없다 */
    }
  }

  private write(level: Level, src: string, msg: string, data?: Record<string, unknown>): void {
    if (!this.dir) return;
    const t = new Date(this.now()).toISOString();
    const day = t.slice(0, 10);
    if (this.capped === day) return;
    const file = join(this.dir, `office-${day}.log`);
    try {
      // 순환 객체(RangeError)와 BigInt(TypeError)도 여기서 삼킨다
      const line: LogLine = { t, level, src, msg: scrub(msg, this.home) as string, ...(data ? { data: scrub(data, this.home) as Record<string, unknown> } : {}) };
      const text = JSON.stringify(line) + "\n";
      mkdirSync(this.dir, { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        /* 새 파일 */
      }
      if (size + Buffer.byteLength(text) > this.maxBytes) {
        this.capped = day;
        appendFileSync(file, JSON.stringify({ t, level: "warn", src: "log", msg: "log cap reached" }) + "\n");
        return;
      }
      appendFileSync(file, text);
    } catch {
      /* 로그 실패로 서버를 멈추지 않는다 */
    }
  }
}

// dir이 ""이면 아무 것도 쓰지 않는다 — setLogger 전 기본값이자 테스트 기본값
let current: Logger | undefined;
export const setLogger = (l: Logger): void => {
  current = l;
};
export const getLogger = (): Logger => (current ??= new Logger({ dir: "" }));
