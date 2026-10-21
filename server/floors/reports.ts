import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FolderView, ReportView } from "../../src/shared/types";
import { errInfo, getLogger } from "../log";

/** 층마다 화면에 두는 보고서 수(스펙 5장) */
export const MAX_FLOOR_REPORTS = 50;
/** 층마다 파일에 두는 수(보고서 + 보관함, 스펙 11장 g) */
export const MAX_FLOOR_FILE = 100;
/** 보이지 않은 지 이만큼 지난 층은 정리(스펙 5장 — 층이 사라져도 7일 보관) */
export const STALE_FLOOR_MS = 7 * 24 * 3_600_000;
/** lastSeenAt은 메모리에서 고치고, 저장한 값보다 이만큼 지났을 때만 파일에 쓴다(B321 I1 — 스냅샷마다 동기 저장하지 않게) */
export const SEEN_SAVE_MS = 3_600_000;
/** 답을 기다리는 요청 id 상한(층 수와 무관하게 메모리가 늘지 않게) */
const MAX_PENDING = 200;

/** 있으면 0600으로(Windows는 권한 비트가 뜻이 없어 무시된다) */
function narrow(file: string): void {
  try {
    if (existsSync(file)) chmodSync(file, 0o600);
  } catch {
    /* 소유자가 다르면 못 바꾼다 — 그대로 두고 쓰기에서 실패를 로그로 */
  }
}

export type ReportKind = "report" | "handover";
/** started: 인수인계 메모로 새 팀원을 시작함(rehire) */
export type ReportState = "pending" | "approved" | "revise" | "started";
/** from: 제출한 에이전트 이름(짝짓기 주인), decidedAt: 결재·새 팀원 시작 시각 */
export interface Report { id: string; kind: ReportKind; title?: string; member?: string; from?: string; body: string; at: number; state: ReportState; decidedAt?: number }
/** 보고 요청 뒤 이만큼 보고서가 없으면 화면에 알린다(스펙 10장) */
export const REPORT_OVERDUE_MS = 10 * 60_000;
/** 퇴사 진행(스펙 7장·11장 e): 시작 시각을 남겨 다시 켜도 이어 간다. nudged: 5분 뒤 "대신 써 달라"를 보냈음 */
export interface Retire { member: string; requestId: string; startedAt: number; nudged?: boolean }
export interface Predecessor { name: string; retiredAt: number }
interface FloorData { lastSeenAt: number; reports: Report[]; archived: Report[]; retires?: Retire[]; predecessors?: Predecessor[] }

/**
 * 보고서·인수인계 저장소(Phase 6b 스펙 5장·11장 g). `<PREFIX>/reports.json`(0600, 임시 파일 뒤 rename으로 원자 쓰기)에만 둔다.
 * 진단 묶음에는 넣지 않는다(보고서 본문은 모델 글). 요청 id(r-8hex)는 lead 지시 때 expect로 걸고, 제출 때 그 층·그 종류로 한 번만 take한다.
 * ask_user 질문은 questions.ts(QuestionBoard)
 */
export class ReportStore {
  private data: { floors: Record<string, FloorData> } = { floors: {} };
  private readonly pending = new Map<string, { floor: string; kind: ReportKind; member?: string; at: number }>();
  /** 층마다 마지막 보고 요청 시각(메모리) — 그 뒤 보고서가 오면 지운다 */
  private readonly askedAt = new Map<string, number>();
  private broken = false;
  /** 파일에 쓴 lastSeenAt(층마다) */
  private readonly savedSeen = new Map<string, number>();
  constructor(private readonly o: { file?: string; now?: () => number } = {}) {
    if (!o.file || !existsSync(o.file)) return;
    narrow(o.file); // 읽기만 해도 넓은 권한을 남기지 않는다(security Minor-3)
    try {
      const d = JSON.parse(readFileSync(o.file, "utf8"));
      if (d && typeof d === "object" && d.floors && typeof d.floors === "object") this.data = d;
      else throw new Error("shape");
      for (const [id, f] of Object.entries(this.data.floors)) this.savedSeen.set(id, f.lastSeenAt);
    } catch (e) {
      this.broken = true; // 다음 쓰기 전에 .broken으로 남긴다(정책 파일과 같은 방식)
      getLogger().warn("reports", "load failed", { error: errInfo(e) });
    }
  }
  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private floor(id: string): FloorData {
    return (this.data.floors[id] ??= { lastSeenAt: this.now(), reports: [], archived: [] });
  }
  private save(): void {
    const file = this.o.file;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      if (this.broken) {
        renameSync(file, `${file}.broken`);
        this.broken = false;
      }
      const tmp = `${file}.tmp`;
      narrow(tmp); // 남아 있던 임시 파일은 writeFileSync의 mode가 적용되지 않는다
      writeFileSync(tmp, JSON.stringify(this.data) + "\n", { mode: 0o600 });
      renameSync(tmp, file);
      this.savedSeen.clear();
      for (const [id, f] of Object.entries(this.data.floors)) this.savedSeen.set(id, f.lastSeenAt);
    } catch (e) {
      getLogger().warn("reports", "save failed", { error: errInfo(e) });
    }
  }

  /** lead 지시(report·revise → report, retire → handover)를 보냈을 때 요청 id를 건다 */
  /** 보고 요청을 보냄(10분 무응답 표시용) */
  asked(floor: string): void {
    this.askedAt.set(floor, this.now());
  }
  expect(id: string, floor: string, kind: ReportKind, member?: string): void {
    this.pending.set(id, { floor, kind, ...(member ? { member } : {}), at: this.now() });
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }
  /** 꺼내지 않고 본다(인수인계 이름 대조 등) */
  peek(id: string, floor: string, kind: ReportKind): { floor: string; kind: ReportKind; member?: string } | null {
    const p = this.pending.get(id);
    return p && p.floor === floor && p.kind === kind ? p : null;
  }
  /** 그 층·그 종류로 건 요청 id면 꺼내고(한 번만), 아니면 null */
  take(id: string, floor: string, kind: ReportKind): { floor: string; kind: ReportKind; member?: string } | null {
    const p = this.pending.get(id);
    if (!p || p.floor !== floor || p.kind !== kind) return null;
    this.pending.delete(id);
    return p;
  }

  add(floor: string, r: Omit<Report, "at" | "state">): void {
    const f = this.floor(floor);
    if (r.kind === "report") this.askedAt.delete(floor);
    f.lastSeenAt = this.now();
    f.reports.push({ ...r, at: this.now(), state: "pending" });
    // 상한: 오래된 결재된 것부터 지우고, 대기 중인 것뿐이면 가장 오래된 대기 보고서를 보관함으로(스펙 11장 g)
    while (f.reports.length > MAX_FLOOR_REPORTS) {
      const i = f.reports.findIndex((x) => x.state !== "pending");
      if (i >= 0) f.reports.splice(i, 1);
      else f.archived.push(f.reports.shift()!);
    }
    while (f.reports.length + f.archived.length > MAX_FLOOR_FILE) f.archived.shift();
    this.save();
  }
  /** 최신 먼저 */
  list(floor: string): Report[] {
    return [...(this.data.floors[floor]?.reports ?? [])].reverse();
  }
  archived(floor: string): Report[] {
    return [...(this.data.floors[floor]?.archived ?? [])].reverse();
  }
  find(floor: string, id: string): Report | undefined {
    return this.data.floors[floor]?.reports.find((x) => x.id === id) ?? this.data.floors[floor]?.archived.find((x) => x.id === id);
  }
  /** 퇴사 시작(그 팀원의 진행 중인 것은 새것으로) */
  startRetire(floor: string, member: string, requestId: string): void {
    const f = this.floor(floor);
    f.retires = [...(f.retires ?? []).filter((r) => r.member !== member), { member, requestId, startedAt: this.now() }];
    this.save();
  }
  retires(floor?: string): Array<Retire & { floor: string }> {
    return Object.entries(this.data.floors)
      .filter(([id]) => floor === undefined || id === floor)
      .flatMap(([id, f]) => (f.retires ?? []).map((r) => ({ ...r, floor: id })));
  }
  markNudged(floor: string, member: string): void {
    const r = this.data.floors[floor]?.retires?.find((x) => x.member === member);
    if (!r) return;
    r.nudged = true;
    this.save();
  }
  /** 새 팀원 시작(rehire를 보냄): 퇴사를 끝내고 전임자로 남긴다(이름·퇴사 시각만) */
  finishRetire(floor: string, member: string): void {
    const f = this.floor(floor);
    f.retires = (f.retires ?? []).filter((r) => r.member !== member);
    f.predecessors = [...(f.predecessors ?? []), { name: member, retiredAt: this.now() }].slice(-20);
    this.save();
  }
  predecessors(floor: string): Predecessor[] {
    return [...(this.data.floors[floor]?.predecessors ?? [])];
  }
  /** 스냅샷용 수(대기는 보관함 포함) */
  counts(floor: string): { pending: number; total: number; overdue?: true } | undefined {
    const f = this.data.floors[floor];
    const asked = this.askedAt.get(floor);
    const overdue = asked !== undefined && this.now() - asked > REPORT_OVERDUE_MS;
    if (!f && !overdue) return undefined;
    const all = [...(f?.reports ?? []), ...(f?.archived ?? [])];
    return { pending: all.filter((r) => r.state === "pending").length, total: all.length, ...(overdue ? { overdue: true as const } : {}) };
  }
  setState(floor: string, id: string, state: ReportState): boolean {
    const r = this.data.floors[floor]?.reports.find((x) => x.id === id) ?? this.data.floors[floor]?.archived.find((x) => x.id === id);
    if (!r) return false;
    r.state = state;
    if (state !== "pending") r.decidedAt = this.now();
    this.save();
    return true;
  }
  /**
   * 스냅샷 빌드마다: 살아 있는 층의 lastSeenAt을 새로 하고, 7일 넘게 보이지 않은 층을 정리한다.
   * 서버를 켠 직후 첫 스냅샷 전에는 부르지 않으므로(살아 있는 층을 아직 모른다) 그때는 정리하지 않는다
   */
  sweep(alive: ReadonlySet<string>): void {
    const now = this.now();
    let changed = false;
    for (const [id, f] of Object.entries(this.data.floors)) {
      if (alive.has(id)) {
        f.lastSeenAt = now;
        if (now - (this.savedSeen.get(id) ?? 0) > SEEN_SAVE_MS) changed = true;
      } else if (now - f.lastSeenAt > STALE_FLOOR_MS) {
        delete this.data.floors[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const viewOf = (r: Report): ReportView => ({
  id: r.id,
  kind: r.kind,
  ...(r.title !== undefined ? { title: r.title } : {}),
  ...(r.member !== undefined ? { member: r.member } : {}),
  from: r.from ?? "team-lead",
  body: r.body,
  at: iso(r.at),
  state: r.state,
  ...(r.decidedAt !== undefined ? { decidedAt: iso(r.decidedAt) } : {}),
});
/** 서류철 화면 모양(GET /api/floors/:id/reports) */
export function folderView(store: Pick<ReportStore, "list" | "archived">, floor: string): FolderView {
  return { reports: store.list(floor).map(viewOf), archived: store.archived(floor).map(viewOf) };
}
