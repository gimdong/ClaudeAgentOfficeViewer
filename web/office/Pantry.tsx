import { useLayoutEffect, useRef } from "react";
import type { Member } from "../../src/shared/types";
import { ACTIONS, Character, LOOKS, memberVariant } from "./Character";
import { SceneCell } from "./Desk";

/** 걷는 시간(MOTION §3.1a): 실제 거리 px ÷ 배율 2 ÷ 25칸/초. 거리를 모르면(0) 계획기 기본 WALK_MS */
/** 커피 자리 → 소파 자리 가로 거리 px(기준점 x14 → x57, ×2) */
export const SOFA_DX = 86;

export const walkMsOf = (px: number) => (px > 0 ? Math.round((px / 2 / 25) * 1000) : undefined);

const look = (name: string) => memberVariant(name, LOOKS.length);
const hand = (m: Member) => m.state === "decision";

/**
 * 층 안 탕비실(계약 SPEC §2 pantry, 80×46 ×2). 겹침: pantry-back → 소파 사람 → pantry-front → 커피 자리 사람.
 * 커피 자리는 서서 coffee(손들면 hand_up_stand), 소파는 앉아 idle(손들면 hand_up). 자리는 계획기가 도착 순으로 준다. 모두 장식
 */
export function PantryScene({ coffee, sofa }: { coffee?: Member; sofa?: Member }) {
  return (
    <div className="pantry-scene" aria-hidden="true">
      <SceneCell slot="pantry" name="pantry-back" className="sc pantry-back" />
      {sofa && <Character name={sofa.name} action={hand(sofa) ? "hand_up" : "idle"} variantIndex={look(sofa.name)} />}
      <SceneCell slot="pantry" name="pantry-front" className="sc pantry-front" />
      {coffee && <Character name={coffee.name} action={hand(coffee) ? "hand_up_stand" : "coffee"} variantIndex={look(coffee.name)} />}
    </div>
  );
}

/** 걷는 중인 요소가 지금 그려진 x(전이 중간값). 브라우저는 matrix(…), jsdom은 적어 둔 translate(…) */
function shownX(el: HTMLElement): number | null {
  const t = getComputedStyle(el).transform;
  const v = /matrix\(([^)]+)\)/.exec(t)?.[1].split(",")[4] ?? /translate\((-?[\d.]+)px/.exec(t)?.[1];
  return v === undefined ? null : Number(v);
}

/**
 * 걷는 사람 하나(walk-layer 안). from → to 가로로, since부터 ms 동안. 다시 그려지면 지금 있어야 할 자리에서 남은 시간만 걷는다.
 * 나갈 때는 처음 sit_down 한 바퀴(책상에서 일어서는 동안) 숨어 기다렸다 걷는다(I2). 이동은 transform만, 3칸(6px)마다 한 걸음(steps)
 */
export function Walker({ member, from, to, y, since, ms, out }: { member: Member; from: number; to: number; y: number; since: number; ms: number; out: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const now = Date.now();
    // 가다가 돌아서면 지금 보이는 자리에서 남은 시간 동안 걷는다(일어서는 300ms 때문에 since로 다시 재면 어긋남, designer-motion I1)
    const turned = lastTo.current !== null && lastTo.current !== to;
    lastTo.current = to;
    const seen = turned ? shownX(el) : null;
    const wait = out && seen === null ? Math.min(ACTIONS.sit_down.ms, ms - 1) : 0;
    const start = since + wait;
    const k = Math.min(1, Math.max(0, (now - start) / (ms - wait)));
    const delay = Math.max(0, start - now);
    const x = seen ?? from + (to - from) * k;
    const left = seen === null ? (ms - wait) * (1 - k) : Math.max(0, since + ms - now);
    el.style.transition = "none";
    el.style.animation = delay ? `walker-wait ${delay}ms step-end` : "";
    el.style.transform = `translate(${Math.round(x)}px, ${y}px)`;
    void el.offsetWidth;
    el.style.transition = `transform ${Math.round(left)}ms steps(${Math.max(1, Math.round(Math.abs(to - x) / 6))}, end) ${delay}ms`;
    el.style.transform = `translate(${Math.round(to)}px, ${y}px)`;
  }, [from, to, y, since, ms, out]);
  return (
    <div ref={ref} className="walker" data-name={member.name}>
      <Character name={member.name} action={to < from ? "walk_left" : "walk_right"} variantIndex={look(member.name)} />
      <span className="walk-tag">{member.name}</span>
    </div>
  );
}
