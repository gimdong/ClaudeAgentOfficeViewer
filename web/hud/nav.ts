import type { Member, SessionView } from "../../src/shared/types";
import { floorDomId } from "../building/Floor";

export function decisionQueue(sessions: SessionView[]): Array<{ session: SessionView; member: Member }> {
  return sessions
    .flatMap((session) => session.members.filter((m) => m.state === "decision" && m.decision).map((member) => ({ session, member })))
    .sort((a, b) => Date.parse(a.member.decision!.since) - Date.parse(b.member.decision!.since));
}

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 층으로 스크롤한다(디자인 5.5). "fold"면 그 층의 접기 버튼에 포커스를 준다(바로 — 키보드 사용자가 기다리지 않게).
 * delayMs: 장면 엘리베이터가 그 층에 닿아 문이 열린 뒤 스크롤(Phase 7b, SPEC §2b)
 */
let pending: ReturnType<typeof setTimeout> | undefined;

export function goToFloor(sessionId: string, focus: "fold" | "none" = "fold", delayMs = 0): void {
  const floor = document.getElementById(floorDomId(sessionId));
  if (!floor) return;
  const scroll = () => floor.scrollIntoView?.({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
  // 빠르게 두 번 누르면 마지막 층만(앞 지연 스크롤이 나중에 와서 다른 층으로 가지 않게, reviewer 2b m2)
  clearTimeout(pending);
  pending = undefined;
  if (delayMs > 0) pending = setTimeout(scroll, delayMs);
  else scroll();
  if (focus === "fold") floor.querySelector<HTMLElement>(".fold")?.focus({ preventScroll: true });
}
