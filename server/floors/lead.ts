import { randomBytes } from "node:crypto";
import type { ChannelHub } from "./channels";
import { buildLead } from "./leadText";
import type { ReportStore } from "./reports";
import { getLogger } from "../log";

/**
 * 팀리더 지시(Phase 6b 스펙 2장): 본문을 틀로 만들어 기존 작업 지시 길(ChannelHub.instruct — B268 서명, 휴업 중 보관)로 보낸다.
 * 지시 id(r-8hex)는 요청마다 새로 만들고, 팀리더가 도구를 부를 때 쓴다. 로그에는 kind만(사용자 글은 남기지 않는다)
 */
/** members: 그 층 팀 설정의 팀원 이름(스펙 12장 b — 그 밖의 이름은 400 member) */
export function leadInstruct(hub: Pick<ChannelHub, "instruct">, floorId: string, paused: boolean, body: unknown, members: readonly string[], reports?: Pick<ReportStore, "expect">): { status: number; body: object } {
  const built = buildLead(body, `r-${randomBytes(4).toString("hex")}`, members);
  if (!built.ok) return { status: 400, body: { error: built.error } };
  const r = hub.instruct(floorId, built.text, paused, built.holdKey);
  if (!r.ok) return { status: r.error === "not-launched" ? 404 : 409, body: { error: r.error } };
  // 제출 도구가 쓸 요청 id를 건다(스펙 3장): 보고 요청·수정 요청 → submit_report, 퇴사 → submit_handover(그 팀원 이름으로만, 12장 b)
  if (built.kind === "report" || built.kind === "revise") reports?.expect(built.id, floorId, "report");
  if (built.kind === "retire") reports?.expect(built.id, floorId, "handover", (body as { member: string }).member);
  getLogger().info("floors", "lead", { kind: built.kind, state: r.state });
  return { status: 200, body: { requestId: built.id, id: r.id, state: r.state } };
}
