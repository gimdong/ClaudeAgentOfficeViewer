import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getLogger, warnCaught } from "../log";

const execFileAsync = promisify(execFile);

export interface SessionRecord {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  alive: boolean;
  /** 파일의 procStart 그대로(Phase 4a B114). 종료 신호 전에 matcher가 pid 재사용을 가린다. 파일에 없으면 없음 */
  procStart?: string;
}

const DAY = 86_400_000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * ctime 스타일 문자열("Mon Sep 28 12:59:39 2026")을 UTC epoch ms로 해석한다. 세션 파일의 procStart와
 * `LC_ALL=C TZ=UTC ps -o lstart=` 출력이 모두 이 형식이다. 문자열 자체엔 타임존 표기가 없으므로 값을
 * 그대로 UTC로 취급한다. 한 자리 날짜의 공백 패딩(예: "Sep  8")을 허용한다. 파싱 실패 시 undefined.
 */
export function parseCTime(s: string): number | undefined {
  const m = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s.trim());
  if (!m) return undefined;
  const [, monStr, dayStr, hh, mm, ss, yearStr] = m;
  const month = MONTHS.indexOf(monStr);
  if (month < 0) return undefined;
  const ms = Date.UTC(Number(yearStr), month, Number(dayStr), Number(hh), Number(mm), Number(ss));
  return Number.isFinite(ms) ? ms : undefined;
}

async function psLstart(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 1000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const PROC_START_TOLERANCE_MS = 2000;

/**
 * true=procStart 일치(같은 프로세스), false=불일치(pid 재사용, 즉 실제로는 죽은 세션),
 * undefined=판단 불가(procStart/ps 출력 파싱 실패, 대상 프로세스 없음 등) — 이 경우 호출자는
 * 기존 kill(pid,0) 판정을 그대로 쓴다("살아있는 세션을 잘못 숨기는 쪽 오류"를 피하기 위함).
 */
export type ProcStartMatcher = (pid: number, procStart: string) => Promise<boolean | undefined>;

export const defaultProcStartMatcher: ProcStartMatcher = async (pid, procStart) => {
  const expected = parseCTime(procStart);
  if (expected === undefined) return undefined;
  const line = await psLstart(pid);
  if (!line) return undefined;
  const actual = parseCTime(line);
  if (actual === undefined) return undefined;
  return Math.abs(actual - expected) <= PROC_START_TOLERANCE_MS;
};

export async function readSessions(
  claudeHome: string,
  now = Date.now(),
  isAlive = pidAlive,
  matchProcStart: ProcStartMatcher = defaultProcStartMatcher,
  platform: NodeJS.Platform = process.platform,
): Promise<SessionRecord[]> {
  const dir = join(claudeHome, "sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const out: SessionRecord[] = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(join(dir, n), "utf8"));
    } catch (e) {
      warnCaught("sessions", "cannot read session file", e, n); // n은 파일 이름뿐(폴더 경로 없음)
      continue;
    }
    const pid = num(raw?.pid);
    const sessionId = str(raw?.sessionId);
    if (pid === undefined || !sessionId) {
      getLogger().warn("sessions", "missing pid or sessionId", { file: n });
      continue;
    }
    let alive = isAlive(pid);
    const procStart = str(raw.procStart);
    // Windows에는 ps가 없어 pid 재사용을 못 가린다 — 필요하면 wmic/Get-Process로 시작 시각 비교.
    // (ponytail: 일단 pid 생존 판정만 쓴다, 필요해지면 위 대안으로 확장)
    if (alive && procStart && platform !== "win32") {
      // pid 재사용 감지: kill(pid,0)이 살아있다고 해도, 세션이 기록해둔 procStart와
      // 실제 그 pid의 프로세스 시작 시각이 다르면 그 pid는 이미 다른 프로세스에 재할당된 것이다.
      let matches: boolean | undefined;
      try {
        matches = await matchProcStart(pid, procStart);
      } catch (e) {
        warnCaught("sessions", "cannot match proc start", e);
        matches = undefined; // 판단 불가 -> 기존 판정을 그대로 쓴다
      }
      if (matches === false) alive = false;
    }
    const updatedAt = num(raw.updatedAt) ?? num(raw.startedAt) ?? 0;
    if (!alive && now - updatedAt > DAY) continue;
    out.push({
      pid,
      sessionId,
      name: str(raw.name) ?? sessionId.slice(0, 8),
      cwd: str(raw.cwd) ?? "",
      status: str(raw.status) ?? "idle",
      startedAt: num(raw.startedAt) ?? 0,
      updatedAt,
      alive,
      ...(procStart ? { procStart } : {}),
    });
  }
  return out;
}
