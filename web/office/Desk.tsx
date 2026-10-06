import { useContext, useEffect, useState, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import type { Member, MemberState } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { stateLabel } from "../format";
import { NEON, roleOf, shirtColor } from "../pixel/palette";
import { PixelSprite } from "../pixel/PixelSprite";
import { characterRows, LOCK_DESK, LOCK_DESK_DENIED, QMARK, QRING, spriteRects } from "../pixel/sprites";
import { remainingSeconds } from "../report/text";
import { OpenDecisionContext } from "../report/useDecisions";
import { targetKeyOf } from "../policy/text";
import { OpenPolicyContext } from "../policy/usePolicy";
import { StatusBubble } from "./StatusBubble";

interface DeskProps {
  member: Member;
  /** 층이 휴업이면 캐릭터를 멈추고 모니터를 끈다(디자인 5.2). Phase 1에서는 쓰이지 않는다 */
  paused?: boolean;
  bubbleKey?: string;
  bubble?: BubbleHandlers;
}

/** 남은 시간이 60초 이하이면 ?를 급함 팔레트로(디자인 phase2 §1.3, Phase 1 6장). deadline이 있을 때만 매초 다시 본다 */
function useUrgent(deadline: string | undefined): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  return !!deadline && remainingSeconds(deadline, Date.now()) <= 60;
}

export function Desk({ member, paused = false, bubbleKey, bubble }: DeskProps) {
  const openDecision = useContext(OpenDecisionContext);
  const openPolicy = useContext(OpenPolicyContext);
  const urgent = useUrgent(member.state === "decision" ? member.decision?.deadline : undefined);
  const role = roleOf(member.name);
  const colors = { h: NEON.hair, s: NEON.skin, e: NEON.eye, c: shirtColor(role, member.color), p: NEON.pants, g: NEON.glasses, t: NEON.pink };
  const decision = member.state === "decision";
  // 큐가 붙인 id가 있어야 보고서를 열 수 있다. id가 없는 결정(큐 없이 만든 스냅샷)은 Phase 1처럼 누를 수 없다
  const decisionId = decision ? member.decision?.id : undefined;
  const openable = !!decisionId;
  const shown: MemberState = paused && !decision ? "idle" : member.state;
  const working = member.state === "working" && !paused;
  const screenOn = (working || member.state === "mail" || decision) && !paused;
  const denied = !!member.policyDenied;
  const locked = !!member.policy || denied;
  // 접근 이름 덧붙임(phase3 §8.7)
  const marks = `${locked ? ", 권한 정책 있음" : ""}${denied ? ", 방금 정책으로 막힘" : ""}`;

  const svg = (
    <svg className="desk-svg" viewBox="0 0 24 30" shapeRendering="crispEdges" aria-hidden="true">
      {decision ? (
        <>
          {/* 누를 수 있는 결정(id가 있음)만 호버·포커스일 때 점선 링을 보인다(디자인 4.4, 6장 "Phase 2 이후") */}
          {openable && <PixelSprite rects={spriteRects(QRING, { y: NEON.yellow })} x={1} y={-2} className="q-ring" />}
          <g className="qmark">
            <PixelSprite rects={spriteRects(QMARK, urgent ? { y: NEON.pink, Y: NEON.pinkDeep } : { y: NEON.yellow, Y: NEON.yellowDeep })} x={3} y={0} />
          </g>
        </>
      ) : (
        !paused && (
          <g transform="translate(1,0)">
            <StatusBubble state={member.state} unread={member.unread} />
          </g>
        )
      )}
      {member.state === "offline" ? (
        <g data-testid="empty-chair">
          <rect x={3} y={13} width={6} height={6} fill={NEON.deskDark} />
          <rect x={4} y={19} width={1} height={2} fill={NEON.deskDark} />
          <rect x={7} y={19} width={1} height={2} fill={NEON.deskDark} />
        </g>
      ) : decision ? (
        <g className="char hand">
          <g className="hop">
            <PixelSprite rects={spriteRects(characterRows(role, "up"), colors)} x={2} y={9} />
          </g>
        </g>
      ) : (
        <g className="char">
          <PixelSprite rects={spriteRects(characterRows(role, "a"), colors)} x={2} y={9} className="frame-a" />
          {working && <PixelSprite rects={spriteRects(characterRows(role, "b"), colors)} x={2} y={9} className="frame-b" />}
        </g>
      )}
      <rect x={12} y={11} width={8} height={6} fill={NEON.monitor} />
      <rect data-testid="screen" x={13} y={12} width={6} height={4} fill={screenOn ? NEON.screenOn : NEON.screenOff} />
      {working && (
        <g className="code">
          <rect x={14} y={13} width={3} height={1} fill={NEON.monitor} />
          <rect x={14} y={14} width={4} height={1} fill={NEON.monitor} />
        </g>
      )}
      {locked && (
        // 자물쇠(phase3 §6.2): 오른쪽 위 (18, 3). 방금 막힘은 분홍 + 느낌표 한 줄을 붙인 다른 모양(§6.3)
        <g data-testid="lock" className="lock" data-shape={denied ? "denied" : "normal"}>
          <PixelSprite rects={spriteRects(denied ? LOCK_DESK_DENIED : LOCK_DESK, { x: denied ? NEON.pink : NEON.violet, a: NEON.monitor })} x={18} y={3} />
        </g>
      )}
      <rect x={15} y={17} width={2} height={2} fill={NEON.monitor} />
      <rect x={0} y={19} width={24} height={2} fill={NEON.desk} />
      <rect x={1} y={21} width={2} height={8} fill={NEON.deskDark} />
      <rect x={21} y={21} width={2} height={8} fill={NEON.deskDark} />
    </svg>
  );

  const handlers =
    bubble && bubbleKey
      ? {
          onMouseEnter: (e: MouseEvent<HTMLElement>) => bubble.enter(e.currentTarget, bubbleKey),
          onMouseLeave: () => bubble.leave(),
          onFocus: (e: FocusEvent<HTMLElement>) => bubble.focus(e.currentTarget, bubbleKey),
          onBlur: () => bubble.blur(),
          // 터치는 호버가 없으므로 첫 탭에 바로 보여준다(디자인 7.5)
          onPointerDown: (e: PointerEvent<HTMLElement>) => {
            if (e.pointerType === "touch") bubble.focus(e.currentTarget, bubbleKey);
          },
        }
      : {};

  const cls = `desk state-${shown}${decision ? " desk--decision" : ""}${urgent ? " urgent" : ""}`;
  if (openable) {
    // Phase 2: 결정 대기 책상은 보고서를 여는 버튼이다(디자인 11장, phase2 §9.2)
    return (
      <button
        type="button"
        className={cls}
        data-testid={`desk-${member.name}`}
        data-policy-key={targetKeyOf(member)}
        aria-haspopup="dialog"
        aria-label={`${member.name}, 결정 필요${marks}. 결정 보고서 열기`}
        onClick={(e) => openDecision?.(decisionId, e.currentTarget)}
        {...handlers}
      >
        {svg}
        <span className="nametag">
          {member.name}
          <span className="open-hint"> · 열기</span>
        </span>
      </button>
    );
  }
  if (openPolicy) {
    // Phase 3: 결정이 없는 책상은 에이전트 패널을 여는 버튼이다(디자인 phase3 §6.1, Ruling B83)
    const key = targetKeyOf(member);
    return (
      <button
        type="button"
        className={`${cls} desk--policy`}
        data-testid={`desk-${member.name}`}
        data-policy-key={key}
        aria-haspopup="dialog"
        aria-label={`${member.name}, ${decision ? "결정 필요" : stateLabel(member.state)}${marks}. 권한 정하기`}
        onClick={(e) => openPolicy(key, e.currentTarget)}
        {...handlers}
      >
        {svg}
        <span className="nametag">
          {member.name}
          <span className="open-hint"> · 열기</span>
        </span>
      </button>
    );
  }
  // 누를 수 없는 책상(컨텍스트 없는 렌더, 또는 id 없는 결정)은 v1과 같은 div로 둔다(디자인 6장 끝 표, Ruling P7)
  return (
    <div
      className={cls}
      data-testid={`desk-${member.name}`}
      tabIndex={0}
      role="img"
      aria-label={`${decision ? `${member.name}, 결정 필요` : `${member.name}, ${stateLabel(member.state)}`}${marks}`}
      {...handlers}
    >
      {svg}
      <span className="nametag">{member.name}</span>
    </div>
  );
}
