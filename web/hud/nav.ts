import type { Member, SessionView } from "../../src/shared/types";
import { floorDomId } from "../building/Floor";

export function decisionQueue(sessions: SessionView[]): Array<{ session: SessionView; member: Member }> {
  return sessions
    .flatMap((session) => session.members.filter((m) => m.state === "decision" && m.decision).map((member) => ({ session, member })))
    .sort((a, b) => Date.parse(a.member.decision!.since) - Date.parse(b.member.decision!.since));
}

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 층으로 스크롤한다(디자인 5.5). "fold"면 그 층의 접기 버튼에 포커스를 준다 */
export function goToFloor(sessionId: string, focus: "fold" | "none" = "fold"): void {
  const floor = document.getElementById(floorDomId(sessionId));
  if (!floor) return;
  floor.scrollIntoView?.({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
  if (focus === "fold") floor.querySelector<HTMLElement>(".fold")?.focus({ preventScroll: true });
}
