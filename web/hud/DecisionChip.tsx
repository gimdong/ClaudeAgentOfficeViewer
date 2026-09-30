import type { Snapshot } from "../../src/shared/types";
import { NEON } from "../pixel/palette";
import { Icon } from "../pixel/Icon";
import { decisionQueue, goToFloor } from "./nav";

/** HUD "결정 대기 N"(디자인 6장 5번). Phase 1에서는 보고서가 없으므로 가장 오래 기다린 층으로 스크롤만 한다(6장 끝 표) */
export function DecisionChip({ snapshot }: { snapshot: Snapshot }) {
  const count = snapshot.decisionCount;
  if (count <= 0) return null;
  const go = () => {
    const first = decisionQueue(snapshot.sessions)[0];
    if (first) goToFloor(first.session.id, "none");
  };
  return (
    <button type="button" className="q-chip" onClick={go} aria-label={`결정 대기 ${count}건, 가장 오래 기다린 층으로 이동`}>
      <Icon name="ask" ink={NEON.wall} />
      결정 대기 {count}
    </button>
  );
}
