import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
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
  /**
   * 대화를 실제로 돌리는 쪽의 sessionId(버그 3, B192). 대시보드가 띄운 층은 interactive 기록(tmux 쪽, 신원)과
   * 백그라운드 job 기록(대화 기록 쪽)이 따로 있다. 짝을 지으면 대화 기록·hook 상태는 이 id로 찾는다. 없으면 sessionId와 같다
   */
  convId?: string;
  /**
   * 합친 층의 bg 쪽(대안 A, beta.23 설계 7.5): 확인 창에 보이고 연결 옮기기를 켤지 정하는 데 쓴다.
   * trusted: 두 기록 파일 모두 자기 소유 일반 파일이고 그룹·남이 쓸 수 없음(S2). ambiguous: 같은 jobId의 bg나 같은 parkedJobId의 앞면이 둘 이상(L1)
   */
  bg?: { pid: number; alive: boolean; name: string; cwd: string; startedAt: number; trusted: boolean; ambiguous?: true };
}

const DAY = 86_400_000;
/** 짝짓기용 관찰 필드 + 파일을 믿을 수 있는지(대안 A — 버튼 판단에만 쓴다) */
interface Side { kind?: string; jobId?: string; parkedJobId?: string; trusted?: boolean }
/** 자기 소유 일반 파일이고 그룹·남이 쓸 수 없는가(S2). uid가 없는 플랫폼(Windows)은 믿지 않는다 — 대안 A는 tmux 층(macOS·Linux)만 */
const ownFile = (st: { isFile(): boolean; uid: number; mode: number }) =>
  st.isFile() && typeof process.getuid === "function" && st.uid === process.getuid() && (st.mode & 0o022) === 0;
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

/**
 * parkedJobId로 bg job과 짝지어진 층(관찰)의 두 기록을 하나로 합친다(버그 3, B192·B194). 살아 있는 기록의 parkedJobId가
 * kind:"bg" 기록의 jobId와 같으면 같은 세션의 두 면이다(Claude Code 2.1.301 관찰 — parkedJobId·jobId의 뜻은 문서에 없다.
 * 대시보드로 띄운 층에서 봤지만 그 층에만 생긴다는 근거는 없다). 신원(층 id·pid·종료 대상)은 그 기록, 대화(convId·갱신 시각,
 * bg가 살아 있으면 상태도)는 bg 기록. bg 기록은 목록에서 뺀다. 짝이 죽었거나 없으면 그대로 둔다. 같은 jobId에 짝이 둘이면 첫 짝만
 */
function pairLaunched(list: SessionRecord[], side: Map<SessionRecord, Side>): SessionRecord[] {
  const bgByJob = new Map<string, SessionRecord>();
  // 짝이 모호한지(L1): 같은 jobId의 bg 수, 같은 parkedJobId의 살아 있는 앞면 수. Map은 마지막 bg가 이긴다 — 둘 이상이면 ambiguous로 표시만
  const bgCount = new Map<string, number>();
  const frontCount = new Map<string, number>();
  for (const r of list) {
    const s = side.get(r);
    if (s?.kind === "bg" && s.jobId) {
      bgByJob.set(s.jobId, r);
      bgCount.set(s.jobId, (bgCount.get(s.jobId) ?? 0) + 1);
    }
    if (r.alive && s?.parkedJobId) frontCount.set(s.parkedJobId, (frontCount.get(s.parkedJobId) ?? 0) + 1);
  }
  const merged = new Set<SessionRecord>();
  const out: SessionRecord[] = [];
  for (const r of list) {
    const park = side.get(r)?.parkedJobId;
    const bg = r.alive && park ? bgByJob.get(park) : undefined;
    if (!bg || bg === r || merged.has(bg)) {
      out.push(r);
      continue;
    }
    merged.add(bg);
    const ambiguous = (bgCount.get(park!) ?? 0) > 1 || (frontCount.get(park!) ?? 0) > 1;
    const trusted = !!side.get(r)?.trusted && !!side.get(bg)?.trusted;
    out.push({
      ...r,
      convId: bg.sessionId,
      status: bg.alive ? bg.status : r.status,
      updatedAt: Math.max(r.updatedAt, bg.updatedAt),
      bg: { pid: bg.pid, alive: bg.alive, name: bg.name, cwd: bg.cwd, startedAt: bg.startedAt, trusted, ...(ambiguous ? { ambiguous: true as const } : {}) },
    });
  }
  return out.filter((r) => !merged.has(r));
}

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
  // 짝짓기용(관찰 필드, 문서에 없음): interactive 기록의 parkedJobId ↔ kind:"bg" 기록의 jobId
  const side = new Map<SessionRecord, Side>();
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let raw: Record<string, unknown>;
    let trusted = false;
    try {
      trusted = ownFile(await lstat(join(dir, n)));
      raw = JSON.parse(await readFile(join(dir, n), "utf8"));
    } catch (e) {
      warnCaught("sessions", "cannot read session file", e, n); // n은 파일 이름뿐(폴더 경로 없음)
      continue;
    }
    // Claude Code(2.1.301 관찰)가 빠른 시작용으로 미리 띄워 두는 예비 프로세스. 대화 기록이 없고 사용자 창도 아니다(버그 2)
    if (raw?.spare === true) continue;
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
    const rec: SessionRecord = {
      pid,
      sessionId,
      name: str(raw.name) ?? sessionId.slice(0, 8),
      cwd: str(raw.cwd) ?? "",
      status: str(raw.status) ?? "idle",
      startedAt: num(raw.startedAt) ?? 0,
      updatedAt,
      alive,
      ...(procStart ? { procStart } : {}),
    };
    out.push(rec);
    side.set(rec, { kind: str(raw.kind), jobId: str(raw.jobId), parkedJobId: str(raw.parkedJobId), trusted });
  }
  return pairLaunched(out, side);
}
