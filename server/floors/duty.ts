import { randomBytes } from "node:crypto";
import type { ChannelHub } from "./channels";
import type { LeadSent } from "./lead";
import { retireNudgeText } from "./leadText";
import type { ReportStore } from "./reports";
import { getLogger } from "../log";

/** 퇴근 요청 뒤 이만큼 활동이 없으면 퇴근(스펙 6장) */
export const OFF_IDLE_MS = 10 * 60_000;
/** 마지막 활동이 이만큼 지나면 "오래 쉬는 중"(표시만, 스펙 6장) */
export const LONG_IDLE_MS = 3_600_000;
/** 퇴사 뒤 이만큼 인수인계가 없으면 팀리더에게 "대신 써 달라"를 한 번(스펙 7장 2번·11장 e) */
export const RETIRE_NUDGE_MS = 5 * 60_000;

export interface DutyView { duty?: "requested" | "off"; longIdle?: true; retiring?: { since: string } }

/**
 * 퇴근·출근·오래 쉼·퇴사(Phase 6b 스펙 6장·7장·11장 a d e f).
 * - "퇴근 요청함"은 지시가 실제로 channel로 나갔을 때만(휴업 중 보관은 보낼 때) 기억한다(11장 a). 메모리에만 — 층이 끝나거나 숨겨지면 지운다
 * - 퇴근: 그 팀원 프로세스가 끝났거나(팀 설정 isActive false) 10분 동안 활동이 없으면. 오래 쉼: 마지막 활동이 1시간 넘음
 * - 휴업 중인 층과 손든(결정 대기) 팀원은 두 판정에서 뺀다(11장 d)
 * - 퇴사는 reports.json에 시작 시각을 남기고(다시 켜도 이어 감), 5분 동안 인수인계가 없으면 channel이 연결돼 있을 때만 한 번 재촉한다
 */
export class DutyBoard {
  private readonly off = new Map<string, Map<string, number>>();
  constructor(private readonly o: { reports: ReportStore; now?: () => number }) {}
  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** 팀리더 지시가 실제로 channel로 나갔을 때(바로 보냈거나 보관한 것이 나갈 때) */
  onSent({ floor, kind, member, requestId, handoverId }: LeadSent): void {
    if (!member) return;
    let m = this.off.get(floor);
    if (kind === "offduty") {
      if (!m) this.off.set(floor, (m = new Map()));
      m.set(member, this.now());
    } else if (kind === "onduty") m?.delete(member);
    else if (kind === "retire" && requestId) this.o.reports.startRetire(floor, member, requestId);
    else if (kind === "rehire") {
      m?.delete(member);
      this.o.reports.finishRetire(floor, member);
      if (handoverId) this.o.reports.setState(floor, handoverId, "started");
    }
  }

  view(floor: string, member: string, c: { paused: boolean; decision: boolean; active?: boolean; lastActivityAt?: string; joinedAt?: number }): DutyView {
    const now = this.now();
    const out: DutyView = {};
    const retire = this.o.reports.retires(floor).find((r) => r.member === member);
    if (retire) out.retiring = { since: new Date(retire.startedAt).toISOString() };
    if (retire && retire.joinedAt === undefined && c.joinedAt !== undefined) this.o.reports.noteJoined(floor, member, c.joinedAt);
    const last = c.lastActivityAt ? Date.parse(c.lastActivityAt) : NaN;
    const requested = this.off.get(floor)?.get(member);
    if (requested !== undefined) {
      // 요청 뒤의 활동만 본다(요청 전부터 쉬고 있었으면 요청 시각부터 잰다)
      const since = Math.max(requested, Number.isFinite(last) ? last : 0);
      const gone = c.active === false || now - since > OFF_IDLE_MS;
      out.duty = gone && !c.paused && !c.decision ? "off" : "requested";
      return out;
    }
    if (!c.paused && !c.decision && Number.isFinite(last) && now - last > LONG_IDLE_MS) out.longIdle = true;
    return out;
  }

  predecessors(floor: string): Array<{ name: string; retiredAt: number; startedAt?: number }> {
    return this.o.reports.predecessors(floor);
  }

  /** 스냅샷 빌드마다: 보이는(끝나지 않고 숨기지 않은) 층만 남기고, 퇴사 5분 재촉을 확인한다 */
  sweep(visible: ReadonlySet<string>, hub?: Pick<ChannelHub, "connected" | "instruct">, isPaused?: (floor: string) => boolean): void {
    for (const id of [...this.off.keys()]) if (!visible.has(id)) this.off.delete(id);
    if (!hub) return;
    const now = this.now();
    for (const r of this.o.reports.retires()) {
      if (r.nudged || now - r.startedAt < RETIRE_NUDGE_MS || !visible.has(r.floor) || !hub.connected(r.floor)) continue;
      // 인수인계가 이미 왔으면 재촉하지 않는다
      if (this.o.reports.find(r.floor, r.requestId)?.kind === "handover") continue;
      // 다시 켠 뒤면 메모리의 요청 id가 없다 — 저장된 requestId를 다시 걸어야 재촉에 따른 제출이 409로 막히지 않는다(B324 I-C)
      if (!this.o.reports.peek(r.requestId, r.floor, "handover")) this.o.reports.expect(r.requestId, r.floor, "handover", r.member);
      const id = `r-${randomBytes(4).toString("hex")}`;
      const res = hub.instruct(r.floor, retireNudgeText(id, r.member, r.requestId), isPaused?.(r.floor) ?? false, `lead:retire-nudge:${r.member}`);
      if (res.ok) {
        this.o.reports.markNudged(r.floor, r.member);
        getLogger().info("floors", "retire-nudge", { state: res.state });
      }
    }
  }
}
