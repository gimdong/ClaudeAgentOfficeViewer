import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Limits } from "../../src/shared/types";

type Obj = Record<string, unknown> | undefined;

const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o && o[k] !== undefined) return o[k];
  return undefined;
};

const pct = (w: Obj): number | undefined => {
  const v = pick(w, "used_percentage", "usedPercentage", "utilization");
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;
};

const iso = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
};

export async function readLimits(claudeHome: string): Promise<Limits | null> {
  let raw: Obj;
  try {
    raw = JSON.parse(await readFile(join(claudeHome, "claude-office", "limits.json"), "utf8"));
  } catch {
    return null;
  }
  const rl = pick(raw, "rate_limits", "rateLimits") as Obj;
  const five = pick(rl, "five_hour", "fiveHour") as Obj;
  const week = pick(rl, "seven_day", "sevenDay", "weekly") as Obj;
  const fiveHourPct = pct(five);
  const weeklyPct = pct(week);
  if (fiveHourPct === undefined && weeklyPct === undefined) return null;
  const resetsAt = iso(pick(five, "resets_at", "resetsAt")) ?? iso(pick(week, "resets_at", "resetsAt"));
  return { fiveHourPct, weeklyPct, resetsAt, source: "statusline" };
}
