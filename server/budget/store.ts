import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errInfo, getLogger } from "../log";

/** 층(세션)별 토큰 예산 상태 파일(스펙 5.1, Ruling B36) */
export interface BudgetState {
  defaultBudgetTokens?: number;
  sessions: Record<string, { budgetTokens?: number; nextGateAt?: number; seenAt: number }>;
}

export const BUDGET_MIN = 1_000;
export const BUDGET_MAX = 1_000_000_000;
/** 끝난 세션 항목을 남겨 두는 기간 */
export const KEEP_MS = 30 * 86_400_000;
/** seenAt만 바뀌었을 때 저장하는 최소 간격 */
const SEEN_SAVE_MS = 3_600_000;

/** 세션 id가 "__proto__" 같은 이름이어도 안전하게 프로토타입 없는 객체를 쓴다 */
const emptySessions = (): BudgetState["sessions"] => Object.create(null) as BudgetState["sessions"];
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** budget을 더해 가며 used를 처음 넘는 값(Ruling B34). start가 이미 used보다 크면 start */
function firstAbove(start: number, budget: number, used: number): number {
  if (start > used) return start;
  return start + (Math.floor((used - start) / budget) + 1) * budget;
}

/**
 * 상태는 메모리에 두고 바뀔 때만 파일에 쓴다(임시 파일 → rename). 읽기·쓰기 실패는 던지지 않는다 —
 * 예산 판정(PreToolUse)은 메모리 값만 본다.
 */
export class BudgetStore {
  private state: BudgetState = { sessions: emptySessions() };
  private lastSaveAt = -Infinity;
  private seenDirty = false;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 동기. 파일이 없으면 조용히 빈 상태, 깨졌으면 빈 상태 + warn */
  load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") getLogger().warn("budget", "state unreadable, starting empty", { error: errInfo(e) });
      return;
    }
    try {
      this.state = sanitize(JSON.parse(text));
    } catch (e) {
      this.state = { sessions: emptySessions() };
      getLogger().warn("budget", "state unreadable, starting empty", { error: errInfo(e) });
    }
  }

  get(sessionId: string): { budgetTokens: number; nextGateAt: number } | undefined {
    const e = this.state.sessions[sessionId];
    return e?.budgetTokens !== undefined && e.nextGateAt !== undefined ? { budgetTokens: e.budgetTokens, nextGateAt: e.nextGateAt } : undefined;
  }

  defaultTokens(): number | undefined {
    return this.state.defaultBudgetTokens;
  }

  setBudget(sessionId: string, tokens: number | null, usedTokens: number): void {
    const e = this.entry(sessionId);
    if (tokens === null) {
      delete e.budgetTokens;
      delete e.nextGateAt;
    } else {
      e.budgetTokens = tokens;
      e.nextGateAt = firstAbove(tokens, tokens, usedTokens);
    }
    this.save();
  }

  setDefault(tokens: number | null): void {
    if (tokens === null) delete this.state.defaultBudgetTokens;
    else this.state.defaultBudgetTokens = tokens;
    this.save();
  }

  /** "계속": nextGateAt += budgetTokens를 사용량을 넘을 때까지(Ruling B34) */
  raise(sessionId: string, usedTokens: number): void {
    const e = this.state.sessions[sessionId];
    if (e?.budgetTokens === undefined || e.nextGateAt === undefined) return;
    e.nextGateAt = firstAbove(e.nextGateAt + e.budgetTokens, e.budgetTokens, usedTokens);
    this.save();
  }

  /**
   * 스냅샷 빌드마다 살아 있는 세션으로 부른다. 처음 본 세션에 기본값을 주고(이미 쓴 양을 넘는 첫 배수),
   * seenAt을 갱신하고, 30일 넘게 보이지 않은 항목을 지운다. 구조가 바뀌면 바로, seenAt만이면 1시간에 한 번 저장한다
   */
  touch(sessionIds: string[], usedOf: (sessionId: string) => number = () => 0): void {
    const now = this.now();
    let changed = false;
    const seen = new Set(sessionIds);
    for (const id of sessionIds) {
      const e = this.state.sessions[id];
      if (e) {
        if (e.seenAt !== now) this.seenDirty = true;
        e.seenAt = now;
        continue;
      }
      const d = this.state.defaultBudgetTokens;
      this.state.sessions[id] = d === undefined ? { seenAt: now } : { budgetTokens: d, nextGateAt: firstAbove(d, d, usedOf(id)), seenAt: now };
      changed = true;
    }
    for (const [id, e] of Object.entries(this.state.sessions)) {
      if (!seen.has(id) && now - e.seenAt > KEEP_MS) {
        delete this.state.sessions[id];
        changed = true;
      }
    }
    if (changed || (this.seenDirty && now - this.lastSaveAt >= SEEN_SAVE_MS)) this.save();
  }

  private entry(sessionId: string) {
    return (this.state.sessions[sessionId] ??= { seenAt: this.now() });
  }

  private save(): void {
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
      this.lastSaveAt = this.now();
      this.seenDirty = false;
    } catch (e) {
      getLogger().warn("budget", "state save failed", { error: errInfo(e) });
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 임시 파일을 못 지워도 다음 저장이 다시 시도한다 */
      }
    }
  }
}

/** 파일에서 읽은 값을 형식에 맞는 것만 남긴다 */
function sanitize(raw: unknown): BudgetState {
  const r = raw as { defaultBudgetTokens?: unknown; sessions?: unknown } | null;
  const out: BudgetState = { sessions: emptySessions() };
  if (isCount(r?.defaultBudgetTokens)) out.defaultBudgetTokens = r.defaultBudgetTokens;
  const sessions = r?.sessions && typeof r.sessions === "object" && !Array.isArray(r.sessions) ? (r.sessions as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(sessions)) {
    const e = v as { budgetTokens?: unknown; nextGateAt?: unknown; seenAt?: unknown } | null;
    if (!e || typeof e !== "object" || typeof e.seenAt !== "number") continue;
    out.sessions[id] = isCount(e.budgetTokens) && isCount(e.nextGateAt) ? { budgetTokens: e.budgetTokens, nextGateAt: e.nextGateAt, seenAt: e.seenAt } : { seenAt: e.seenAt };
  }
  return out;
}
