import { useContext, useEffect, useRef, useState } from "react";
import type { Snapshot, SessionView } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { BudgetSettingsContext } from "../budget/BudgetDialog";
import { ReopenHost } from "../floors/ReopenDialog";
import { FLOOR_TEXT, useHiddenFloors } from "../floors/useFloors";
import { remainingOf } from "../hud/remaining";
import { BuildingInfo, BUILDING_TEXT } from "./BuildingInfo";
import { Floor } from "./Floor";
import { VacantFloor } from "./VacantFloor";

/** 야근 빌딩(디자인 5.1). 위가 최신 층, 맨 위는 빈 층, 1F가 가장 오래된 세션. 숨긴 층 줄은 탑 아래·땅 위(phase4a §4.3) */
/**
 * 지붕 간판(디자인 phase6b §11.1): `{이름}의 회사`(처음 `User`). snapshot이 있으면 간판이 버튼이 되어 빌딩 정보 창을 연다.
 * 이름 저장(onSaveName)·이름 값(userName)은 서버 API가 생기면 App이 넘긴다(B322) — 없으면 저장은 실패로 보인다
 */
export function Building({
  sessions,
  bubble,
  hiddenFloors = 0,
  experimental,
  snapshot,
  userName = BUILDING_TEXT.signDefault,
  onSaveName,
}: {
  sessions: SessionView[];
  bubble?: BubbleHandlers;
  hiddenFloors?: number;
  experimental?: Snapshot["experimental"];
  snapshot?: Snapshot;
  userName?: string;
  onSaveName?(name: string): Promise<boolean>;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const signRef = useRef<HTMLButtonElement>(null);
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
      <div className="roof">
        <svg className="px" viewBox="0 0 280 18" preserveAspectRatio="none" aria-hidden="true">
          <rect x={0} y={16} width={280} height={2} fill="#2e2852" />
          <rect x={20} y={4} width={2} height={12} fill="#3b3460" />
          <rect x={258} y={6} width={2} height={10} fill="#3b3460" />
        </svg>
        {snapshot ? (
          <button ref={signRef} type="button" className="roof-sign" aria-haspopup="dialog" aria-label={BUILDING_TEXT.signAria(userName)} title={BUILDING_TEXT.sign(userName)} onClick={() => setInfoOpen(true)}>
            {BUILDING_TEXT.sign(userName)}
          </button>
        ) : (
          <div className="roof-sign" aria-hidden="true">
            {BUILDING_TEXT.sign(userName)}
          </div>
        )}
      </div>
      {infoOpen && snapshot && (
        <BuildingInfo
          userName={userName}
          usage={{ today: snapshot.usage.today.total, todayCacheRead: snapshot.usage.today.cacheRead, last5h: snapshot.usage.last5h.total, last7d: snapshot.usage.last7d.total }}
          remaining={remainingOf(snapshot)}
          floors={sessions.length}
          members={sessions.reduce((n, s) => n + s.members.length, 0)}
          serverVersion={snapshot.serverVersion}
          statusline={snapshot.statusline}
          appVersion={__APP_VERSION__}
          onSave={(name) => (onSaveName ? onSaveName(name) : Promise.resolve(false))}
          onClose={() => {
            setInfoOpen(false);
            requestAnimationFrame(() => signRef.current?.focus());
          }}
        />
      )}
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
      {/* 옮겨 열기 창은 층 밖에 둔다 — SIGTERM 뒤 층이 잠깐 사라져도 창과 요청이 이어진다(REOPEN §2.1, B209) */}
      <ReopenHost announce={announce} />
    </main>
  );
}
