import type { Snapshot } from "../../src/shared/types";
import { NEON } from "../pixel/palette";
import { Icon } from "../pixel/Icon";
import { decisionQueue, goToFloor } from "./nav";

/**
 * HUD "결정 대기 N"(디자인 6장 5번). Phase 2: 누르면 가장 오래 기다린 결정의 보고서를 연다(phase2 §9.2, Ruling P8 되돌림).
 * onOpen이 없으면(보고서 없이 그린 HUD) 그 층으로 스크롤만 한다
 */
export function DecisionChip({ snapshot, onOpen }: { snapshot: Snapshot; onOpen?(opener: HTMLElement): void }) {
  const count = snapshot.decisionCount;
  if (count <= 0) return null;
  const go = (el: HTMLElement) => {
    if (onOpen) return onOpen(el);
    const first = decisionQueue(snapshot.sessions)[0];
    if (first) goToFloor(first.session.id, "none");
  };
  return (
    <button type="button" className="q-chip" aria-haspopup={onOpen ? "dialog" : undefined} onClick={(e) => go(e.currentTarget)} aria-label={`결정 대기 ${count}건, 다음 요청 열기`}>
      <Icon name="ask" ink={NEON.wall} />
      결정 대기 {count}
    </button>
  );
}
