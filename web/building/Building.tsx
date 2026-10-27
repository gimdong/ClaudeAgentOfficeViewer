import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Snapshot, SessionView } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { BudgetSettingsContext } from "../budget/BudgetDialog";
import { ReopenHost } from "../floors/ReopenDialog";
import { FLOOR_TEXT, useHiddenFloors } from "../floors/useFloors";
import { remainingOf } from "../hud/remaining";
import { BuildingInfo, BUILDING_TEXT } from "./BuildingInfo";
import { CafeFloor, LobbyFloor, RoofRow, Sky, Street } from "./Exterior";
import { Floor } from "./Floor";
import { ElevatorCar } from "./ElevatorCar";
import { CafeContext, cafeKey, useCafe } from "./useCafe";
import { Character, LOOKS, memberVariant } from "../office/Character";
import { Walker, walkMsOf } from "../office/Pantry";
import { WALK_MS } from "../office/pantryPlan";
import { DOOR_FRAME_MS, RIDE_FLOOR_MS } from "./elevatorPlan";
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
  variant,
  variantCount,
  onSaveVariant,
}: {
  sessions: SessionView[];
  bubble?: BubbleHandlers;
  hiddenFloors?: number;
  experimental?: Snapshot["experimental"];
  snapshot?: Snapshot;
  userName?: string;
  onSaveName?(name: string): Promise<boolean>;
  /** 낮·밤 설정(Phase 7 Task 3) — 빌딩 정보 창으로 넘긴다 */
  variant?: "day" | "night" | "system";
  variantCount?: number;
  onSaveVariant?(v: "day" | "night" | "system"): Promise<boolean>;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const signRef = useRef<HTMLButtonElement>(null);
  const { announce } = useContext(BudgetSettingsContext);
  const h = useHiddenFloors(sessions, hiddenFloors, announce);
  const floors = [...h.visible].sort((a, b) => b.floor - a.floor);
  // 카페 오래 쉬기와 엘리베이터(Phase 7b Task 8). ponytail: 탑승 행(11·12)은 오피스 시트에 늘 있다(없는 장은 오피스 것) — 행을 빼는 테마가 생기면 매니페스트 표시로
  const cafe = useCafe(floors, true);
  const people = floors.flatMap((f) => f.members.map((m) => [cafeKey(f.id, m.name), m] as const));
  const memberOf = (k?: string) => (k ? people.find(([x]) => x === k)?.[1] : undefined);
  // 카페 방 안 자리 위치(걷는 층 x·y). 문 = 방 왼쪽 끝
  const [cafeGeo, setCafeGeo] = useState<Array<[number, number]>>([]);
  useLayoutEffect(() => {
    const measure = () => {
      const room = towerRef.current?.querySelector(".floor--cafe .room")?.getBoundingClientRect();
      if (!room) return;
      const next = [...towerRef.current!.querySelectorAll(".cafe-seat")].map((e): [number, number] => [Math.round(e.getBoundingClientRect().left - room.left), Math.round(e.getBoundingClientRect().top - room.top)]);
      setCafeGeo((g) => (JSON.stringify(g) === JSON.stringify(next) ? g : next));
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, []);
  // 카페 자리(SPEC §2b·MOTION §3.3): 내리면 문에서 자리까지 걸어 앉고(앉은 그림은 도착 때 보임), 돌아갈 때는 자리에서 문까지 걸어 상자에 탄다.
  // 카페 장면은 aria-hidden이라 이름표도 장식 복제다. 책상 버튼·이름표·포커스는 자기 층에 그대로
  const active = cafe.elevator.active;
  const now = Date.now();
  const seatNodes: [ReactNode?, ReactNode?] = [undefined, undefined];
  const cafeWalkers: ReactNode[] = [];
  cafe.seats.forEach((p, i) => {
    const m = memberOf(p?.key);
    if (!p || !m) return;
    // 걷는 사람은 바닥선 위에: 테이블 칸(44×46 ×2) 바닥 = 앉은 칸 top − 10 + 92, 서 있는 발 = 칸 y + 56 → 앉은 칸보다 26px 아래
    const [x, seatY] = cafeGeo[i] ?? [0, 0];
    const y = seatY + 26;
    const ms = walkMsOf(x) ?? WALK_MS;
    if (p.spot === "cafe") {
      const left = p.since + ms - now;
      seatNodes[i] = (
        <span className="cafe-sitter" style={left > 0 ? { animation: `walker-wait ${left}ms step-end` } : undefined}>
          <Character name={m.name} action="idle" variantIndex={memberVariant(m.name, LOOKS.length)} />
          <span className="cafe-name">{m.name}</span>
        </span>
      );
      if (left > 0) cafeWalkers.push(<Walker key={p.key} member={m} from={0} to={x} y={y} since={p.since} ms={ms} out={false} hideAt={p.since + ms} />);
    } else {
      const boardAt = active?.name === p.key ? active.start + Math.abs(active.from - active.pick) * RIDE_FLOOR_MS + 3 * DOOR_FRAME_MS : undefined;
      if ((boardAt ?? Infinity) > now) cafeWalkers.push(<Walker key={p.key} member={m} from={x} to={0} y={y} since={p.since} ms={ms} out hideAt={boardAt} />);
    }
  });
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

  const sign = snapshot ? (
    <button ref={signRef} type="button" className="roof-sign" aria-haspopup="dialog" aria-label={BUILDING_TEXT.signAria(userName)} title={BUILDING_TEXT.sign(userName)} onClick={() => setInfoOpen(true)}>
      {BUILDING_TEXT.sign(userName)}
    </button>
  ) : (
    <div className="roof-sign" aria-hidden="true">
      {BUILDING_TEXT.sign(userName)}
    </div>
  );

  return (
    <main className="building" aria-label="야근 빌딩">
      <Sky />
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
          variant={variant}
          variantCount={variantCount}
          onSaveVariant={onSaveVariant}
          announce={announce}
          onClose={() => {
            setInfoOpen(false);
            requestAnimationFrame(() => signRef.current?.focus());
          }}
        />
      )}
      <div className="tower" ref={towerRef}>
        <RoofRow sign={sign} />
        <VacantFloor experimental={experimental} />
        {floors.length === 0 && h.count === 0 && !h.reloading && <p className="empty">빌딩이 비어 있습니다. 빈 층에서 새 세션을 시작하세요</p>}
        <CafeContext.Provider value={cafe}>
          {floors.map((s) => (
            <Floor key={s.id} session={s} bubble={bubble} onHidden={onHidden} />
          ))}
        </CafeContext.Provider>
        <CafeFloor seats={seatNodes}>
          <div className="walk-layer" aria-hidden="true">
            {cafeWalkers}
          </div>
        </CafeFloor>
        <LobbyFloor />
        {/* 엘리베이터 상자(통로 위, Task 8). 위치의 원본은 계획 상태 */}
        <div className="elevator-layer" aria-hidden="true" data-testid="elevator-layer">
          <ElevatorCar state={cafe.elevator} riderName={memberOf(cafe.elevator.active?.name)?.name} />
        </div>
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
      <Street />
      {/* 옮겨 열기 창은 층 밖에 둔다 — SIGTERM 뒤 층이 잠깐 사라져도 창과 요청이 이어진다(REOPEN §2.1, B209) */}
      <ReopenHost announce={announce} />
    </main>
  );
}
