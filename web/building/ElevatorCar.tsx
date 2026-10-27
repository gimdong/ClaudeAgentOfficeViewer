import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Character, LOOKS, memberVariant, type ActionName } from "../office/Character";
import { SceneCell } from "../office/Desk";
import { BOARD_MS, DOOR_FRAME_MS, hudMoveMs, LURCH_MS, ridePhases, type ElevatorState, type HudMove } from "./elevatorPlan";
import { CAFE_FLOOR, LOBBY_FLOOR } from "./useCafe";

/** 상자 30×34 ×2. 바닥이 그 줄 통로(.shaft) 바닥에 닿는다 */
const CAR_H = 68;
const F = DOOR_FRAME_MS;
const DOOR = 3 * F;
/** 문 밖에서 상자 칸까지 걷는 거리: 4프레임 × 3칸 × 2 */
const STEP_IN = 24;
const lift = (n: number) => (n === CAFE_FLOOR ? "cafe" : n === LOBBY_FLOOR ? "lobby" : String(n));

/** 이 상자가 그려진 탑에서, 층 n 통로 바닥에 상자 바닥을 맞춘 translateY */
function yOf(layer: HTMLElement, n: number): number {
  const shaft = layer.parentElement?.querySelector(`.shaft[data-lift="${lift(n)}"]`);
  if (!shaft) return 0;
  return Math.round(shaft.getBoundingClientRect().bottom - layer.getBoundingClientRect().top - CAR_H);
}

type Range = [number, number];
/** [시작, 끝) 동안만 보이게(visibility, step-end로 바로 바뀜 — 밝기·투명도 변화 없음). 끝이 total이면 끝난 뒤에도 보임 */
function showDuring(el: Element | null, ranges: Range[], total: number) {
  if (!el?.animate) return;
  const k: Keyframe[] = [{ visibility: "hidden", offset: 0, easing: "step-end" }];
  for (const [a, b] of ranges) k.push({ visibility: "visible", offset: a / total, easing: "step-end" }, { visibility: b >= total ? "visible" : "hidden", offset: Math.min(1, b / total), easing: "step-end" });
  el.animate(k, { duration: total, fill: "forwards" });
}

/**
 * 문 프레임 셋이 시각마다 정확히 하나만 보이게(빈 프레임 없음, designer-motion M1). opens·closes = 여는·닫는 시작 시각.
 * 여는 동안 닫힘 → 반 → 열림(100ms씩), 닫는 동안 열림 → 반 → 닫힘
 */
function doorFrames(opens: number[], closes: number[], total: number): [Range[], Range[], Range[]] {
  const marks: Array<[number, 0 | 1 | 2]> = [[0, 0]];
  for (const t of opens) marks.push([t + F, 1], [t + 2 * F, 2]);
  for (const t of closes) marks.push([t + F, 1], [t + 2 * F, 0]);
  marks.sort((a, b) => a[0] - b[0]);
  const r: [Range[], Range[], Range[]] = [[], [], []];
  marks.forEach(([t, f], i) => r[f].push([t, marks[i + 1]?.[0] ?? total]));
  return r;
}

/**
 * 엘리베이터 상자(MOTION §3.2). 상태(elevatorPlan)가 원본: 탄 사람이 없으면 car 층에 문 닫고 서 있고, 탄 사람이 있으면
 * 태우러 감 → 문 열림(3프레임) → 걸어 들어옴(walk_left 4프레임) → 문 닫힘 → ride_lurch → 이동(층마다 2.64초, 2칸씩 steps) → ride_lurch
 * → 문 열림 → 걸어 나감(walk_right 4프레임). HUD 이동은 층마다 한 칸 → 문 2프레임. 이동은 transform만. 모두 장식.
 * 탑 크기가 바뀌면(창 크기·층 추가·접기) 통로 위치를 다시 잰다(reviewer m1)
 */
export function ElevatorCar({ state, hud, riderName }: { state: ElevatorState; hud?: HudMove | null; riderName?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const a = state.active;
  const moving = !a && hud && hud.from !== hud.to && Date.now() < hud.start + hudMoveMs(hud) + 5 * F ? hud : null;
  const [resized, setResized] = useState(0);
  useEffect(() => {
    const tower = ref.current?.parentElement?.parentElement;
    const on = () => setResized((n) => n + 1);
    if (tower && typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(on);
      ro.observe(tower);
      return () => ro.disconnect();
    }
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current!;
    const layer = el.parentElement!;
    for (const x of el.getAnimations?.({ subtree: true }) ?? []) x.cancel();
    const t = (y: number) => `translateY(${y}px)`;
    const sync = (since: number) => {
      for (const x of el.getAnimations?.({ subtree: true }) ?? []) x.currentTime = Math.max(0, Date.now() - since);
    };
    const [d0, d1, d2] = [".car-door-0", ".car-door-1", ".car-door-2"].map((q) => el.querySelector(q));
    if (moving) {
      // 닿으면 문이 반 → 열림(그 뒤 스크롤), 탈 사람이 없으니 열림 → 반 → 닫힘으로 닫는다(designer-motion 2b M1). 끝 그림이 닫힘이라 다시 그리지 않아도 열린 채 남지 않음(reviewer 2b m1)
      const ms = hudMoveMs(moving);
      const total = ms + 5 * F;
      const [y0, y1] = [yOf(layer, moving.from), yOf(layer, moving.to)];
      el.style.transform = t(y1);
      el.animate?.([{ transform: t(y0), offset: 0, easing: `steps(${Math.abs(moving.to - moving.from)}, end)` }, { transform: t(y1), offset: ms / total }, { transform: t(y1), offset: 1 }], { duration: total, fill: "forwards" });
      showDuring(d0, [[0, ms], [ms + 4 * F, total]], total);
      showDuring(d1, [[ms, ms + F], [ms + 3 * F, ms + 4 * F]], total);
      showDuring(d2, [[ms + F, ms + 3 * F]], total);
      sync(moving.start);
      return;
    }
    if (!a) {
      el.style.transform = t(yOf(layer, state.car));
      // 탄 사람이 막 내렸으면 문을 닫는다(열림 → 반 → 닫힘). HUD로 옮긴 뒤(settled가 HUD 끝)는 이미 닫힌 그림
      if (Date.now() - state.settled < DOOR && state.done && Object.values(state.done).includes(state.settled)) {
        showDuring(d2, [[0, F]], DOOR);
        showDuring(d1, [[F, 2 * F]], DOOR);
        showDuring(d0, [[2 * F, DOOR]], DOOR);
        sync(state.settled);
      }
      return;
    }
    const p = ridePhases(a.pick, a);
    const total = p.end;
    const [y0, y1, y2] = [yOf(layer, a.pick), yOf(layer, a.from), yOf(layer, a.to)];
    const steps = (dy: number) => `steps(${Math.max(1, Math.round(Math.abs(dy) / 4))}, end)`; // 프레임마다 2칸(×2 = 4px)
    el.style.transform = t(y2);
    el.animate?.(
      [
        { transform: t(y0), offset: 0, easing: steps(y1 - y0) },
        { transform: t(y1), offset: p.pick / total, easing: "step-end" },
        { transform: t(y1), offset: p.go / total, easing: steps(y2 - y1) },
        { transform: t(y2), offset: p.land / total },
        { transform: t(y2), offset: 1 },
      ],
      { duration: total, fill: "forwards" },
    );
    const [f0, f1, f2] = doorFrames([p.pick, p.arrive], [p.close], total);
    showDuring(d0, f0, total);
    showDuring(d1, f1, total);
    showDuring(d2, f2, total);
    // 탄 사람: 문이 다 열리면 문 밖(오른쪽)에서 걸어 들어와 상자 칸 (2,4)에 서고, 도착해 문이 다 열리면 걸어 나간다
    const inAt = p.pick + DOOR;
    const outAt = p.arrive + DOOR;
    const body = el.querySelector(".car-rider");
    body?.animate?.(
      [
        { transform: `translateX(${STEP_IN}px)`, offset: 0, easing: "step-end" },
        { transform: `translateX(${STEP_IN}px)`, offset: inAt / total, easing: "steps(4, end)" },
        { transform: "translateX(0px)", offset: (inAt + BOARD_MS) / total, easing: "step-end" },
        { transform: "translateX(0px)", offset: outAt / total, easing: "steps(4, end)" },
        { transform: `translateX(${STEP_IN}px)`, offset: 1 },
      ],
      { duration: total, fill: "forwards" },
    );
    const pose = (q: string, r: Range[]) => showDuring(el.querySelector(q), r, total);
    pose(".pose-in", [[inAt, inAt + BOARD_MS]]);
    pose(".pose-ride", [[inAt + BOARD_MS, p.close + DOOR], [p.close + DOOR + LURCH_MS, p.land], [p.arrive, outAt]]);
    pose(".pose-lurch-1", [[p.close + DOOR, p.close + DOOR + LURCH_MS]]);
    pose(".pose-lurch-2", [[p.land, p.arrive]]);
    pose(".pose-out", [[outAt, total - 1]]);
    sync(a.start);
  }, [a, state.car, moving, resized]);
  // ride_lurch는 한 번만 도는 행이라, 보일 때 처음부터 돌도록 그 시각만큼 늦춰 시작한다
  const lurchDelay = (at: "go" | "land") => {
    if (!a) return undefined;
    const p = ridePhases(a.pick, a);
    return { "--lurch-delay": `${(at === "go" ? p.close + DOOR : p.land) - (Date.now() - a.start)}ms` } as CSSProperties;
  };
  const rider = (cls: string, action: ActionName, style?: CSSProperties) => (
    <span className={`car-pose ${cls}`} style={style}>
      <Character name={riderName!} action={action} variantIndex={memberVariant(riderName!, LOOKS.length)} />
    </span>
  );
  return (
    <div ref={ref} className="elevator-car" data-floor={a ? undefined : state.car} data-rider={a?.name} data-hud-to={moving?.to}>
      <SceneCell slot="elevator" name="elevator-box-back" className="sc car-back" />
      {a && riderName && (
        <span className="car-rider">
          {rider("pose-in", "walk_left")}
          {rider("pose-ride", "ride")}
          {rider("pose-lurch-1", "ride_lurch", lurchDelay("go"))}
          {rider("pose-lurch-2", "ride_lurch", lurchDelay("land"))}
          {rider("pose-out", "walk_right")}
        </span>
      )}
      <SceneCell slot="elevator" name="elevator-door-0" className="sc car-door-0" />
      <SceneCell slot="elevator" name="elevator-door-1" className="sc car-door car-door-1" />
      <SceneCell slot="elevator" name="elevator-door-2" className="sc car-door car-door-2" />
    </div>
  );
}

/**
 * 로비 층수 표시 「2F ▲」 글(SPEC §2 lobby — 칸 위치를 따라가는 DOM, 자리는 T7 LobbyFloor indicator). 원본은 계획 상태:
 * 서 있으면 상자가 있는 층, 움직이는 중(탑승·HUD)이면 지금 구간이 갈 층과 방향. 구간이 바뀌는 때 다시 그리는 것은 Building
 */
export function liftText(state: ElevatorState, hud: HudMove | null | undefined, words: { rest: string; lobby: string }): string {
  const name = (n: number) => (n === CAFE_FLOOR ? words.rest : n === LOBBY_FLOOR ? words.lobby : `${n}F`);
  const a = state.active;
  const moving = !a && hud && hud.from !== hud.to && Date.now() < hud.start + hudMoveMs(hud) ? hud : null;
  // 탑승 중이면 지금 구간: 태우러 가는 동안 pick → from, 태운 뒤 from → to(reviewer m1)
  const [from, to] = a ? (Date.now() - a.start < ridePhases(a.pick, a).pick ? [a.pick, a.from] : [a.from, a.to]) : moving ? [moving.from, moving.to] : [state.car, state.car];
  return from === to ? name(to) : `${name(to)} ${to > from ? "▲" : "▼"}`;
}
