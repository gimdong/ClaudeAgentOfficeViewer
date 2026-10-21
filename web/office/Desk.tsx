import { useContext, useEffect, useState, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import type { Member, MemberState } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { formatTokens, modelLabel, stateLabel } from "../format";
import { NEON, roleOf, shirtColor } from "../pixel/palette";
import { PixelSprite } from "../pixel/PixelSprite";
import { characterRows, FOLDER_DESK, LOCK_DESK, LOCK_DESK_DENIED, QMARK, QRING, spriteRects } from "../pixel/sprites";
import { CMD_TEXT } from "./leadCmdText";
import { OpenLeadContext } from "./LeadUi";
import { remainingSeconds } from "../report/text";
import { OpenDecisionContext } from "../report/useDecisions";
import { targetKeyOf } from "../policy/text";
import { OpenPolicyContext } from "../policy/usePolicy";
import { StatusBubble } from "./StatusBubble";

interface DeskProps {
  member: Member;
  /** 층이 휴업이면 캐릭터를 그리지 않고(빈 의자) 모니터를 끈다 */
  paused?: boolean;
  bubbleKey?: string;
  bubble?: BubbleHandlers;
  /** 이 책상이 있는 층 id(Phase 6b — 답 칸·지시 절이 그 층을 안다) */
  floorId?: string;
  /** 리드 책상의 서류철 수(Phase 6b designer SPEC §2.2) */
  folder?: { pending: number; total: number };
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

export function Desk({ member, paused = false, bubbleKey, bubble, floorId, folder }: DeskProps) {
  const openDecision = useContext(OpenDecisionContext);
  const openPolicy = useContext(OpenPolicyContext);
  const lead = useContext(OpenLeadContext);
  const urgent = useUrgent(member.state === "decision" ? member.decision?.deadline : undefined);
  const role = roleOf(member.name);
  const colors = { h: NEON.hair, s: NEON.skin, e: NEON.eye, c: shirtColor(role, member.color), p: NEON.pants, g: NEON.glasses, t: NEON.pink };
  const decision = member.state === "decision";
  // 큐가 붙인 id가 있어야 보고서를 열 수 있다. id가 없는 결정(큐 없이 만든 스냅샷)은 Phase 1처럼 누를 수 없다
  // ask_user(kind chat)는 결정 보고서가 아니라 답 칸을 연다(Phase 6b designer SPEC §2.7)
  const chat = decision && member.decision?.kind === "chat";
  const decisionId = decision && !chat ? member.decision?.id : undefined;
  const openable = !!decisionId;
  const q = member.awaitingReply;
  // 답을 기다립니다(Stop 대체, §2.3): 손들기·? 없이 하늘색 말머리
  const awaiting = !!q && q.source === "await" && q.state === "open" && !decision && !paused;
  const replyable = !!lead && !!floorId && !!q && (chat || awaiting);
  // 퇴근함(§2.4): 사용자가 퇴근시킨 자리만 팻말 빈 의자
  const offDuty = member.duty === "off";
  const shown: MemberState = paused && !decision ? "idle" : offDuty && !decision ? "offline" : member.state;
  const working = member.state === "working" && !paused && !offDuty;
  const screenOn = (working || member.state === "mail" || decision) && !paused && !offDuty;
  const denied = !!member.policyDenied;
  const locked = !!member.policy || denied;
  // 접근 이름 덧붙임(phase3 §8.7)
  const marks = `${locked ? ", 권한 정책 있음" : ""}${denied ? ", 방금 정책으로 막힘" : ""}`;

  const svg = (
    <svg className="desk-svg" viewBox="0 0 24 30" shapeRendering="crispEdges" aria-hidden="true">
      {decision && !paused ? (
        <>
          {/* 누를 수 있는 결정(id가 있음)만 호버·포커스일 때 점선 링을 보인다(디자인 4.4, 6장 "Phase 2 이후") */}
          {openable && <PixelSprite rects={spriteRects(QRING, { y: NEON.yellow })} x={1} y={-2} className="q-ring" />}
          <g className="qmark">
            <PixelSprite rects={spriteRects(QMARK, urgent ? { y: NEON.pink, Y: NEON.pinkDeep } : { y: NEON.yellow, Y: NEON.yellowDeep })} x={3} y={0} />
          </g>
        </>
      ) : awaiting ? (
        // §2.3: 하늘색 말머리 + 점 셋(파란 점). StatusBubble과 같은 틀
        <g transform="translate(1,0)" className="bubble bubble-await" data-testid="await-bubble">
          <rect x={0} y={0} width={12} height={7} fill={NEON.cyan} />
          <rect x={3} y={7} width={2} height={1} fill={NEON.cyan} />
          <text x={6} y={5.3} fontSize={4.5} textAnchor="middle" fill={NEON.wall} fontFamily="monospace">
            · · ·
          </text>
        </g>
      ) : (
        !paused &&
        !offDuty && (
          <g transform="translate(1,0)">
            <StatusBubble state={member.state} unread={member.unread} />
          </g>
        )
      )}
      {/* 휴업 층은 모두 퇴근한 사무실처럼 빈 의자만 둔다(사용자 요청 2026-10-12, B130 대체) */}
      {member.state === "offline" || paused || (offDuty && !decision) ? (
        <g data-testid="empty-chair">
          <rect x={3} y={13} width={6} height={6} fill={NEON.deskDark} />
          <rect x={4} y={19} width={1} height={2} fill={NEON.deskDark} />
          <rect x={7} y={19} width={1} height={2} fill={NEON.deskDark} />
          {offDuty && !paused && (
            // §2.4 퇴근 팻말: 휴업 셔터 팻말과 같은 색
            <g data-testid="offduty-sign">
              <rect x={2} y={10} width={9} height={5} fill="var(--shutter-bar)" />
              <rect x={2} y={15} width={9} height={1} fill="var(--shutter-gap)" />
              <text x={6.5} y={13.6} fontSize={3.5} textAnchor="middle" fill="var(--ink)">
                {CMD_TEXT.offSign}
              </text>
            </g>
          )}
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
        // 자물쇠(phase3 §6.2): 오른쪽 위 (18, 3). 방금 막힘은 분홍 + 왼쪽 느낌표를 붙인 7×6을 (16, 3)에(§6.3, B107)
        <g data-testid="lock" className="lock" data-shape={denied ? "denied" : "normal"}>
          <PixelSprite rects={spriteRects(denied ? LOCK_DESK_DENIED : LOCK_DESK, { x: denied ? NEON.pink : NEON.violet, a: NEON.monitor })} x={denied ? 16 : 18} y={3} />
        </g>
      )}
      <rect x={15} y={17} width={2} height={2} fill={NEON.monitor} />
      {folder && folder.total > 0 && (
        // §2.2 리드 책상의 서류철: 대기가 있으면 노랑, 없으면 흐리게
        <g data-testid="folder-mark">
          <PixelSprite rects={spriteRects(FOLDER_DESK, { x: folder.pending > 0 ? NEON.yellow : "var(--muted)", a: "var(--paper)" })} x={20} y={15} />
        </g>
      )}
      <rect x={0} y={19} width={24} height={2} fill={NEON.desk} />
      <rect x={1} y={21} width={2} height={8} fill={NEON.deskDark} />
      <rect x={21} y={21} width={2} height={8} fill={NEON.deskDark} />
    </svg>
  );

  // 이름표 아래 한 줄: 모델 · 토큰 합계(항상 보임). 둘 다 없으면 그리지 않는다
  // 92px 폭에서 숫자가 잘리지 않게 모델과 토큰을 두 줄로 둔다(정적 렌더 확인)
  const metaModel = member.model ? modelLabel(member.model) : "";
  const metaTokens = member.model || member.tokens.total > 0 ? formatTokens(member.tokens.total) : "";
  const meta = metaTokens && (
    <span className="desk-meta" data-testid="desk-meta" title={[metaModel, metaTokens].filter(Boolean).join(" · ")}>
      {metaModel && <span className="dm-model">{metaModel}</span>}
      <span className="dm-tokens">{metaTokens}</span>
    </span>
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

  // 이름표 아래 한 줄 자리(§2.6): 모든 책상에 둔다(비어 있어도 — 바닥선을 맞춘다). 리드는 결재 칩, 팀원은 상태 줄 하나
  const pending = folder?.pending ?? 0;
  const status = member.retiring ? { text: CMD_TEXT.statusRetiring, cls: "desk-status pink" } : member.duty === "requested" ? { text: CMD_TEXT.statusOffRequested, cls: "desk-status" } : member.longIdle && !offDuty ? { text: CMD_TEXT.statusLongIdle, cls: "desk-status" } : null;
  const extra = (
    <span className="desk-extra" data-testid="extra-line">
      {pending > 0 ? <span className="desk-folder">{CMD_TEXT.deskFolder(pending)}</span> : status && <span className={status.cls}>{status.text}</span>}
    </span>
  );
  const folderMark = pending > 0 ? CMD_TEXT.aria.folder(pending) : "";
  const cls = `desk state-${shown}${decision ? " desk--decision" : ""}${urgent ? " urgent" : ""}${awaiting ? " desk--await" : ""}${offDuty ? " desk--offduty" : ""}`;
  if (replyable) {
    // Phase 6b: ask_user(결정 표시)·답을 기다립니다는 답 칸을 연다(§2.1·§2.7)
    return (
      <button
        type="button"
        className={cls}
        data-testid={`desk-${member.name}`}
        data-policy-key={targetKeyOf(member)}
        aria-haspopup="dialog"
        aria-label={awaiting ? CMD_TEXT.aria.await(member.name) : `${member.name}, 결정 필요${marks}${folderMark}. 답하기 열기`}
        onClick={(e) => lead!.openReply(floorId!, member.name, q!.id, e.currentTarget)}
        {...handlers}
      >
        {svg}
        <span className="nametag">
          {member.name}
          <span className="open-hint"> · 열기</span>
        </span>
        {meta}
        {extra}
      </button>
    );
  }
  if (openable) {
    // Phase 2: 결정 대기 책상은 보고서를 여는 버튼이다(디자인 11장, phase2 §9.2)
    return (
      <button
        type="button"
        className={cls}
        data-testid={`desk-${member.name}`}
        data-policy-key={targetKeyOf(member)}
        aria-haspopup="dialog"
        aria-label={`${member.name}, 결정 필요${marks}${folderMark}. 결정 보고서 열기`}
        onClick={(e) => openDecision?.(decisionId, e.currentTarget)}
        {...handlers}
      >
        {svg}
        <span className="nametag">
          {member.name}
          <span className="open-hint"> · 열기</span>
        </span>
        {meta}
        {extra}
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
        aria-label={offDuty ? CMD_TEXT.aria.off(member.name) : member.longIdle && !decision ? CMD_TEXT.aria.longIdle(member.name) : `${member.name}, ${decision ? "결정 필요" : stateLabel(member.state)}${marks}${folderMark}. 권한 정하기`}
        onClick={(e) => openPolicy(key, e.currentTarget, floorId)}
        {...handlers}
      >
        {svg}
        <span className="nametag">
          {member.name}
          <span className="open-hint"> · 열기</span>
        </span>
        {meta}
        {extra}
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
      {meta}
      {extra}
    </div>
  );
}
