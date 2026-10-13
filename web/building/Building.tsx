import { useContext, useEffect, useRef } from "react";
import type { Snapshot, SessionView } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { BudgetSettingsContext } from "../budget/BudgetDialog";
import { FLOOR_TEXT, useHiddenFloors } from "../floors/useFloors";
import { Floor } from "./Floor";
import { VacantFloor } from "./VacantFloor";

/** 야근 빌딩(디자인 5.1). 위가 최신 층, 맨 위는 빈 층, 1F가 가장 오래된 세션. 숨긴 층 줄은 탑 아래·땅 위(phase4a §4.3) */
export function Building({ sessions, bubble, hiddenFloors = 0, experimental }: { sessions: SessionView[]; bubble?: BubbleHandlers; hiddenFloors?: number; experimental?: Snapshot["experimental"] }) {
  const { announce } = useContext(BudgetSettingsContext);
  const h = useHiddenFloors(sessions, hiddenFloors, announce);
  const floors = [...h.visible].sort((a, b) => b.floor - a.floor);
  const barRef = useRef<HTMLDivElement>(null);
  const towerRef = useRef<HTMLDivElement>(null);
  /** 다음 렌더 뒤 포커스: 숨긴 뒤 "모두 보이기" 버튼, 모두 보이기 뒤 줄, 층이 돌아오면 1F 접기 버튼(§4.4) */
  const focusNext = useRef<"bar-button" | "bar" | "first-floor" | null>(null);
  const wasReloading = useRef(h.reloading);
  /** 포커스가 숨긴 층 줄(또는 그 버튼) 안에 있는지. 줄이 사라지면 blur가 오지 않으므로 마지막 값이 남는다(B135 ②) */
  const focusInBar = useRef(false);

  useEffect(() => {
    if (wasReloading.current && !h.reloading && focusInBar.current) focusNext.current = "first-floor";
    wasReloading.current = h.reloading;
  });
  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    if (f === "bar-button") barRef.current?.querySelector<HTMLElement>("button")?.focus();
    else if (f === "bar") barRef.current?.focus();
    else {
      const all = towerRef.current?.querySelectorAll<HTMLElement>('[data-testid="floor"] .fold');
      all?.[all.length - 1]?.focus();
    }
  });

  const onHidden = (id: string, n: number) => {
    h.onHidden(id, n);
    focusNext.current = "bar-button";
  };
  const unhide = async () => {
    await h.unhideAll();
    focusNext.current = "bar";
  };

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
      <div className="tower" ref={towerRef}>
        <VacantFloor experimental={experimental} />
        {floors.length === 0 && h.count === 0 && !h.reloading && <p className="empty">빌딩이 비어 있습니다. 빈 층에서 새 세션을 시작하세요</p>}
        {floors.map((s) => (
          <Floor key={s.id} session={s} bubble={bubble} onHidden={onHidden} />
        ))}
      </div>
      {(h.count > 0 || h.reloading) && (
        <div className="hidden-bar" ref={barRef} tabIndex={h.reloading ? -1 : undefined} onFocus={() => (focusInBar.current = true)} onBlur={() => (focusInBar.current = false)}>
          {h.reloading ? (
            <span className="hb-text">{FLOOR_TEXT.reloading}</span>
          ) : (
            <>
              <button type="button" className="pbtn" aria-busy={h.busy || undefined} onClick={() => void unhide()}>
                {FLOOR_TEXT.hiddenBar(h.count)}
              </button>
              {h.error && (
                <span className="fc-err" role="alert">
                  {h.error}
                </span>
              )}
            </>
          )}
        </div>
      )}
      <div className="ground" aria-hidden="true" />
    </main>
  );
}
