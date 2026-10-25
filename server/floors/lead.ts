import { randomBytes } from "node:crypto";
import type { ChannelHub } from "./channels";
import { buildLead, type LeadKind } from "./leadText";
import type { ReportStore } from "./reports";
import { getLogger } from "../log";

/**
 * 팀리더 지시(Phase 6b 스펙 2장): 본문을 틀로 만들어 기존 작업 지시 길(ChannelHub.instruct — B268 서명, 휴업 중 보관)로 보낸다.
 * 지시 id(r-8hex)는 요청마다 새로 만들고, 팀리더가 도구를 부를 때 쓴다. 로그에는 kind만(사용자 글은 남기지 않는다)
 */
/** 퇴근·퇴사 기록에 쓰는 값(지시가 실제로 나갈 때 DutyBoard.onSent로) */
export interface LeadSent { floor: string; kind: LeadKind; member?: string; requestId: string; handoverId?: string; reportId?: string }

/** 보관한 결재가 실제로 나가면 그 도장(승인됨·수정 요청), 보관함에서 지우면 대기로(스펙 12장 l) */
export function verdictHeldGone(reports: Pick<ReportStore, "setState" | "setHeld">, meta: LeadSent, sent: boolean): void {
  if ((meta.kind !== "approve" && meta.kind !== "revise") || !meta.reportId) return;
  if (sent) reports.setState(meta.floor, meta.reportId, meta.kind === "approve" ? "approved" : "revise");
  else reports.setHeld(meta.floor, meta.reportId, undefined);
}

/**
 * members: 그 층 팀 설정의 팀원 이름(스펙 12장 b — 그 밖의 이름은 400 member).
 * rehire는 그 팀원의 인수인계 메모가 서류철에 있어야 하고(없으면 409 handover), 메모 본문을 틀의 메모 칸에 싣는다.
 * 바로 보냈으면 onSent를 곧바로, 휴업 중 보관했으면 보관 지시의 meta로 넘겨 나갈 때 부른다(11장 a)
 */
export function leadInstruct(
  hub: Pick<ChannelHub, "instruct">,
  floorId: string,
  paused: boolean,
  body: unknown,
  members: readonly string[],
  reports?: Pick<ReportStore, "expect" | "find" | "asked" | "setState" | "setHeld">,
  onSent?: (s: LeadSent) => void,
): { status: number; body: object } {
  const b = (body ?? {}) as { kind?: unknown; member?: unknown; handoverId?: unknown };
  let memo: string | undefined;
  if (b.kind === "rehire" && reports && typeof b.handoverId === "string") {
    const h = reports.find(floorId, b.handoverId);
    if (!h || h.kind !== "handover" || h.member !== b.member) return { status: 409, body: { error: "handover" } };
    memo = h.body;
  }
  const built = buildLead(body, `r-${randomBytes(4).toString("hex")}`, members, { memo });
  if (!built.ok) return { status: 400, body: { error: built.error } };
  // 결재는 그 층 서류철에 있는 보고서에만(qa #659 — 틀이 사실 아닌 승인을 만들지 않게). 형식(B316 400)을 먼저 본 뒤
  const rid0 = (b as { reportId?: unknown }).reportId as string;
  if ((built.kind === "approve" || built.kind === "revise") && reports && reports.find(floorId, rid0)?.kind !== "report") return { status: 404, body: { error: "report" } };
  const rid = (body as { reportId?: unknown }).reportId;
  const sent: LeadSent = { floor: floorId, kind: built.kind, requestId: built.id, ...(typeof b.member === "string" ? { member: b.member } : {}), ...(typeof b.handoverId === "string" ? { handoverId: b.handoverId } : {}), ...(typeof rid === "string" ? { reportId: rid } : {}) };
  const r = hub.instruct(floorId, built.text, paused, built.holdKey, sent);
  if (!r.ok) return { status: r.error === "not-launched" ? 404 : 409, body: { error: r.error } };
  // 제출 도구가 쓸 요청 id를 건다(스펙 3장): 보고 요청·수정 요청 → submit_report, 퇴사 → submit_handover(그 팀원 이름으로만, 12장 b)
  if (built.kind === "report" || built.kind === "revise") reports?.expect(built.id, floorId, "report");
  if (built.kind === "report") reports?.asked(floorId);
  // 결재: 보냈으면 바로 도장, 휴업 중 보관이면 held 표시("보관됨") — 실제로 나갈 때 도장을 바꾼다(verdictHeldGone, 스펙 12장 l)
  if (r.state === "held" && sent.reportId && (built.kind === "approve" || built.kind === "revise")) reports?.setHeld(floorId, sent.reportId, built.kind);
  else if (r.state === "sent" && reports) verdictHeldGone(reports, sent, true);
  if (built.kind === "retire") reports?.expect(built.id, floorId, "handover", b.member as string);
  if (r.state === "sent") onSent?.(sent);
  getLogger().info("floors", "lead", { kind: built.kind, state: r.state });
  return { status: 200, body: { requestId: built.id, id: r.id, state: r.state } };
}
