import { useLayoutEffect, useRef } from "react";
import { Character, LOOKS, memberVariant } from "../office/Character";
import { SceneCell } from "../office/Desk";
import { DOOR_FRAME_MS, hudMoveMs, RIDE_FLOOR_MS, rideMs, type ElevatorState, type HudMove } from "./elevatorPlan";
import { CAFE_FLOOR, LOBBY_FLOOR } from "./useCafe";

/** 상자 30×34 ×2. 바닥이 그 줄 통로(.shaft) 바닥에 닿는다 */
const CAR_H = 68;
const DOOR = 3 * DOOR_FRAME_MS;
const LURCH = 200;
const lift = (n: number) => (n === CAFE_FLOOR ? "cafe" : n === LOBBY_FLOOR ? "lobby" : String(n));

/** 이 상자가 그려진 탑에서, 층 n 통로 바닥에 상자 바닥을 맞춘 translateY */
function yOf(layer: HTMLElement, n: number): number {
  const shaft = layer.parentElement?.querySelector(`.shaft[data-lift="${lift(n)}"]`);
  if (!shaft) return 0;
  return Math.round(shaft.getBoundingClientRect().bottom - layer.getBoundingClientRect().top - CAR_H);
}

/** [시작, 끝) 동안만 보이게(visibility, step-end로 바로 바뀜 — 밝기·투명도 변화 없음) */
function showDuring(el: Element | null, ranges: Array<[number, number]>, total: number) {
  if (!el?.animate) return;
  const k: Keyframe[] = [{ visibility: "hidden", offset: 0, easing: "step-end" }];
  for (const [a, b] of ranges) k.push({ visibility: "visible", offset: a / total, easing: "step-end" }, { visibility: "hidden", offset: Math.min(1, b / total), easing: "step-end" });
  el.animate(k, { duration: total, fill: "forwards", delay: 0 });
}

/**
 * 엘리베이터 상자(MOTION §3.2). 상태(elevatorPlan)가 원본: 탄 사람이 없으면 car 층에 문 닫고 서 있고,
 * 탄 사람이 있으면 태우러 감 → 문 열림(3프레임) → 탐 → 문 닫힘 → 흔들림 → 목적 층까지(층마다 2.64초, 2칸씩 steps) → 흔들림 → 문 열림.
 * 이동은 transform: translateY만. 모두 장식(층 안 사람의 접근 이름·포커스는 책상이 가짐)
 */
export function ElevatorCar({ state, hud, riderName }: { state: ElevatorState; hud?: HudMove | null; riderName?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const a = state.active;
  // HUD 이동(SPEC §2b): 탄 사람이 없을 때, 끝나기 전까지. 층마다 한 칸씩(steps = 층 수), 닿으면 문이 2프레임 열림
  const moving = !a && hud && hud.from !== hud.to && Date.now() < hud.start + hudMoveMs(hud) + 2 * DOOR_FRAME_MS ? hud : null;
  useLayoutEffect(() => {
    const el = ref.current!;
    const layer = el.parentElement!;
    for (const x of el.getAnimations?.({ subtree: true }) ?? []) x.cancel();
    if (moving) {
      const ms = hudMoveMs(moving);
      const total = ms + 2 * DOOR_FRAME_MS;
      const [y0, y1] = [yOf(layer, moving.from), yOf(layer, moving.to)];
      el.style.transform = `translateY(${y1}px)`;
      const anims = [
        el.animate?.([{ transform: `translateY(${y0}px)`, offset: 0, easing: `steps(${Math.abs(moving.to - moving.from)}, end)` }, { transform: `translateY(${y1}px)`, offset: ms / total }, { transform: `translateY(${y1}px)`, offset: 1 }], { duration: total, fill: "forwards" }),
      ];
      showDuring(el.querySelector(".car-door-0"), [[0, ms]], total);
      showDuring(el.querySelector(".car-door-1"), [[ms, ms + DOOR_FRAME_MS]], total);
      showDuring(el.querySelector(".car-door-2"), [[ms + DOOR_FRAME_MS, total]], total);
      for (const x of [...anims, ...(el.getAnimations?.({ subtree: true }) ?? [])]) if (x) x.currentTime = Math.max(0, Date.now() - moving.start);
      return;
    }
    if (!a) {
      el.style.transform = `translateY(${yOf(layer, state.car)}px)`;
      return;
    }
    const total = rideMs(a.pick, a);
    const pick = Math.abs(a.from - a.pick) * RIDE_FLOOR_MS;
    const arrive = total - DOOR;
    const [y0, y1, y2] = [yOf(layer, a.pick), yOf(layer, a.from), yOf(layer, a.to)];
    const steps = (dy: number) => `steps(${Math.max(1, Math.round(Math.abs(dy) / 4))}, end)`; // 프레임마다 2칸(×2 = 4px)
    const t = (y: number) => `translateY(${y}px)`;
    const elapsed = Math.max(0, Date.now() - a.start);
    el.style.transform = t(y2);
    const opts = { duration: total, fill: "forwards" as const, iterationStart: 0 };
    const anims = [
      el.animate?.(
        [
          { transform: t(y0), offset: 0, easing: steps(y1 - y0) },
          { transform: t(y1), offset: pick / total, easing: "step-end" },
          { transform: t(y1), offset: (pick + 2 * DOOR + LURCH) / total, easing: steps(y2 - y1) },
          { transform: t(y2), offset: (arrive - LURCH) / total },
          { transform: t(y2), offset: 1 },
        ],
        opts,
      ),
    ];
    // 문: 태우는 층에서 열림(반 → 열림)·닫힘(열림 → 반), 도착 층에서 열림. 탄 사람은 문이 다 열린 뒤부터 도착 층 문이 열릴 때까지
    showDuring(el.querySelector(".car-door-1"), [[pick, pick + DOOR_FRAME_MS * 2], [pick + DOOR + DOOR_FRAME_MS, pick + DOOR + DOOR_FRAME_MS * 2], [arrive + DOOR_FRAME_MS, arrive + DOOR_FRAME_MS * 2]], total);
    showDuring(el.querySelector(".car-door-2"), [[pick + DOOR_FRAME_MS * 2, pick + DOOR + DOOR_FRAME_MS], [arrive + DOOR_FRAME_MS * 2, total]], total);
    showDuring(el.querySelector(".car-door-0"), [[0, pick], [pick + DOOR + DOOR_FRAME_MS * 2, arrive]], total);
    showDuring(el.querySelector(".car-rider"), [[pick + DOOR, arrive + DOOR]], total);
    for (const x of [...anims, ...(el.getAnimations?.({ subtree: true }) ?? [])]) if (x) x.currentTime = elapsed;
  }, [a, state.car, moving]);
  return (
    <div ref={ref} className="elevator-car" data-floor={a ? undefined : state.car} data-rider={a?.name} data-hud-to={moving?.to}>
      <SceneCell slot="elevator" name="elevator-box-back" className="sc car-back" />
      {a && riderName && (
        <span className="car-rider">
          <Character name={riderName} action="ride" variantIndex={memberVariant(riderName, LOOKS.length)} />
        </span>
      )}
      <SceneCell slot="elevator" name="elevator-door-0" className="sc car-door-0" />
      <SceneCell slot="elevator" name="elevator-door-1" className="sc car-door car-door-1" />
      <SceneCell slot="elevator" name="elevator-door-2" className="sc car-door car-door-2" />
    </div>
  );
}
