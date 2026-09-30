import type { SessionView } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { Floor } from "./Floor";
import { VacantFloor } from "./VacantFloor";

/** 야근 빌딩(디자인 5.1). 위가 최신 층, 맨 위는 빈 층, 1F가 가장 오래된 세션 */
export function Building({ sessions, bubble }: { sessions: SessionView[]; bubble?: BubbleHandlers }) {
  const floors = [...sessions].sort((a, b) => b.floor - a.floor);
  return (
    <main className="building" aria-label="야근 빌딩">
      <div className="roof" aria-hidden="true">
        <svg className="px" viewBox="0 0 280 18" preserveAspectRatio="none">
          <rect x={0} y={16} width={280} height={2} fill="#2e2852" />
          <rect x={20} y={4} width={2} height={12} fill="#3b3460" />
          <rect x={258} y={6} width={2} height={10} fill="#3b3460" />
        </svg>
        <div className="roof-sign">CLAUDE 야근 빌딩</div>
      </div>
      <div className="tower">
        <VacantFloor />
        {floors.length === 0 && <p className="empty">빌딩이 비어 있습니다. 빈 층에서 새 세션을 시작하세요</p>}
        {floors.map((s) => (
          <Floor key={s.id} session={s} bubble={bubble} />
        ))}
      </div>
      <div className="ground" aria-hidden="true" />
    </main>
  );
}
