import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Limits } from "../../src/shared/types";
import { warnCaught } from "../log";

type Obj = Record<string, unknown> | undefined;

const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o && o[k] !== undefined) return o[k];
  return undefined;
};

const rawPct = (w: Obj): number | undefined => {
  const v = pick(w, "used_percentage", "usedPercentage", "utilization");
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

const pct = (w: Obj): number | undefined => {
  const v = rawPct(w);
  return v === undefined ? undefined : Math.max(0, Math.min(100, v));
};

// new Date(...)는 ±8.64e15ms 범위를 벗어나면 유효하지 않은(NaN 타임스탬프) Date를 만들 뿐 던지지
// 않지만, 그 위에서 toISOString()을 부르면 RangeError가 난다. 범위를 벗어난/파싱 불가능한 값은
// "resets_at을 모른다"(undefined)로 취급한다 — resets_at이 아예 없는 경우와 같은 취급이다.
const iso = (v: unknown): string | undefined => {
  let d: Date | undefined;
  if (typeof v === "number" && Number.isFinite(v)) d = new Date(v < 1e12 ? v * 1000 : v);
  else if (typeof v === "string") d = new Date(v);
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
};

/**
 * 창 하나(five_hour/seven_day)의 pct와 resetsAt을 계산한다. resetsAt이 있고 이미 now를 지났으면
 * 그 창은 리셋된 것으로 보고 pct/resetsAt 모두 버린다(값을 오래된 채로 계속 보여주지 않기 위함).
 * resetsAt이 없거나(파싱 불가 포함) 아직 지나지 않았으면 기존대로 pct를 쓴다.
 */
function windowPct(w: Obj, now: number): { pct: number | undefined; raw: number | undefined; resetsAt: string | undefined } {
  const resetsAt = iso(pick(w, "resets_at", "resetsAt"));
  if (resetsAt !== undefined && new Date(resetsAt).getTime() <= now) {
    return { pct: undefined, raw: undefined, resetsAt: undefined };
  }
  return { pct: pct(w), raw: rawPct(w), resetsAt };
}

export async function readLimits(claudeHome: string, now = Date.now()): Promise<Limits | null> {
  let raw: Obj;
  try {
    raw = JSON.parse(await readFile(join(claudeHome, "claude-office", "limits.json"), "utf8"));
  } catch (e) {
    warnCaught("limits", "cannot read limits", e, "limits.json"); // ENOENT = statusline tap 미설치, 조용히
    return null;
  }
  const rl = pick(raw, "rate_limits", "rateLimits") as Obj;
  const five = windowPct(pick(rl, "five_hour", "fiveHour") as Obj, now);
  const week = windowPct(pick(rl, "seven_day", "sevenDay", "weekly") as Obj, now);
  const spend = windowPct(pick(rl, "spend_limit", "spendLimit") as Obj, now);
  if (five.pct === undefined && week.pct === undefined && spend.pct === undefined) return null;
  const resetsAt = five.resetsAt ?? week.resetsAt;
  return { fiveHourPct: five.pct, weeklyPct: week.pct, spendPct: spend.pct, spendRawPct: spend.raw, resetsAt, source: "statusline" };
}
