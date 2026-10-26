import { useContext, useEffect, useState, type CSSProperties, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import type { Member, MemberState } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { formatTokens, modelLabel, stateLabel } from "../format";
import { NEON } from "../pixel/palette";
import { PixelSprite } from "../pixel/PixelSprite";
import { FOLDER_DESK, LOCK_DESK, LOCK_DESK_DENIED, spriteRects } from "../pixel/sprites";
import type { SlotName } from "../themes/registry";
import { ThemeContext } from "../themes/ThemeContext";
import { Character, LOOKS, memberVariant, type ActionName } from "./Character";
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
  /** 퇴사 중이면 channel 연결이 없음을 알린다(스펙 12장 m) */
  retireWait?: boolean;
  /** 탕비실에 갔거나 걷는 중(Phase 7 T6b): 캐릭터만 빈 의자로. 버튼·이름표·결정 표시는 그대로 */
  away?: boolean;
}

type Screen = "work" | "ask" | "think" | "rest";
/** 상태 → (동작, 모니터)(Phase 7 Task 5). mail은 받은 일을 살피는 중이라 think */
const POSE: Record<Exclude<MemberState, "offline">, [ActionName, Screen]> = { working: ["type", "work"], decision: ["hand_up", "ask"], mail: ["think", "think"], idle: ["idle", "rest"] };

/** 장면 시트의 한 칸을 그리는 장식 i. 좌표는 --sx·--sy·--sw·--sh(1배율), 시트 폭 --shw, 배율은 CSS */
export function SceneCell({ slot = "desk", name, className }: { slot?: SlotName; name: string; className: string }) {
  const { theme, variant } = useContext(ThemeContext);
  const asset = theme.slots[slot][variant] ?? Object.values(theme.slots[slot])[0];
  const [x, y, w, h] = asset.layout?.slots[name] ?? [0, 0, 0, 0];
  const style = { "--sx": x, "--sy": y, "--sw": w, "--sh": h, "--shw": asset.layout?.sheet?.width ?? 256, backgroundImage: `url(${asset.url})` };
  return <i className={className} aria-hidden="true" style={style as CSSProperties} />;
}

/** 책상 장면(§3 겹침: 의자 등받이 → 오라 → 캐릭터 → 모니터·책상). 빈 자리면 의자 + 쉼 모니터. 모두 장식 */
function DeskScene({ member, pose, vacant }: { member: Member; pose: [ActionName, Screen]; vacant: boolean }) {
  const screen = vacant ? "rest" : pose[1];
  return (
    <div className="desk-scene" aria-hidden="true" data-member={member.name} data-testid={vacant ? "empty-chair" : undefined}>
      <SceneCell name="chair" className="sc chair" />
      {!vacant && <Character name={member.name} action={pose[0]} effort={member.effort} variantIndex={memberVariant(member.name, LOOKS.length)} />}
      <SceneCell name={`desk-${screen}`} className={`sc desk-front monitor-${screen}`} />
    </div>
  );
}

/**
 * 책상. 리드 책상에 서류철이 있으면 결재 칩·서류철 그림을 책상 버튼 밖 형제 버튼으로 둔다(B335 ②) — 책상이 답 칸을 열 때도
 * 서류철로 바로 갈 수 있게. 버튼 안에 버튼을 두지 않는다
 */
export function Desk(props: DeskProps) {
  const lead = useContext(OpenLeadContext);
  const { floorId, folder } = props;
  if (!lead || !floorId || !folder || folder.total === 0) return <DeskBody {...props} />;
  const open = (el: HTMLElement) => lead.openFolder(floorId, el);
  return (
    <div className="desk-slot">
      <DeskBody {...props} folderOutside />
      {/* 서류철 그림 위의 누름 자리(마우스). 키보드·스크린 리더는 아래 칩 버튼과 패널 [서류철]로 간다 */}
      <button type="button" className="desk-folder-hit" data-testid="folder-hit" tabIndex={-1} aria-hidden="true" onClick={(e) => open(e.currentTarget)} />
      {folder.pending > 0 && (
        <button type="button" className="desk-folder desk-folder-btn" aria-label={CMD_TEXT.aria.folderOpen(folder.pending)} onClick={(e) => open(e.currentTarget)}>
          {CMD_TEXT.deskFolder(folder.pending)}
        </button>
      )}
    </div>
  );
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

function DeskBody({ member, paused = false, bubbleKey, bubble, floorId, folder, retireWait = false, away = false, folderOutside = false }: DeskProps & { folderOutside?: boolean }) {
  const openDecision = useContext(OpenDecisionContext);
  const openPolicy = useContext(OpenPolicyContext);
  const lead = useContext(OpenLeadContext);
  const urgent = useUrgent(member.state === "decision" ? member.decision?.deadline : undefined);
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
  const vacant = member.state === "offline" || paused || (offDuty && !decision) || away;
  const denied = !!member.policyDenied;
  const locked = !!member.policy || denied;
  // 접근 이름 덧붙임(phase3 §8.7)
  // 퇴사 중인데 연결이 없으면 title·aria 꼬리만(SPEC §2.6 W2a — 92px 줄에는 넣지 않음, 「스펙」 12장 m)
  const retireTail = member.retiring && retireWait ? `, ${CMD_TEXT.retireResume}` : "";
  const marks = `${locked ? ", 권한 정책 있음" : ""}${denied ? ", 방금 정책으로 막힘" : ""}${retireTail}`;

  // 답을 기다립니다(§2.3·B335 ①): 말머리 자리에 글자 상자(하늘 바탕). 92px에서 말줄임
  const awaitLabel = awaiting && (
    <span className="desk-await" data-testid="await-bubble">
      {CMD_TEXT.awaiting}
    </span>
  );
  const svg = (
    <svg className="desk-svg desk-marks" viewBox="0 0 24 30" shapeRendering="crispEdges" aria-hidden="true">
      {decision && !paused ? null /* 결정은 아래 DOM "!" 풍선(P7a-10 M2) */ : awaiting ? null /* 답을 기다립니다는 아래 글자 말머리(B335 ①) */ : (
        !paused &&
        !offDuty && (
          <g transform="translate(1,0)">
            <StatusBubble state={member.state} unread={member.unread} />
          </g>
        )
      )}
      {offDuty && !paused && !decision && (
        // §2.4 퇴근 팻말: 장면 위 글이라 이름표 판(--th-label-*, §4.1a)
        <g data-testid="offduty-sign">
          <rect x={2} y={10} width={9} height={5} fill="var(--th-label-bg)" />
          <rect x={2} y={15} width={9} height={1} fill="var(--th-label-border)" />
          <text x={6.5} y={13.6} fontSize={3.5} textAnchor="middle" fill="var(--th-label-ink)">
            {CMD_TEXT.offSign}
          </text>
        </g>
      )}
      {locked && (
        // 자물쇠(phase3 §6.2): 오른쪽 위 (18, 3). 방금 막힘은 분홍 + 왼쪽 느낌표를 붙인 7×6을 (16, 3)에(§6.3, B107)
        <g data-testid="lock" className="lock" data-shape={denied ? "denied" : "normal"}>
          <PixelSprite rects={spriteRects(denied ? LOCK_DESK_DENIED : LOCK_DESK, { x: denied ? NEON.pink : NEON.violet, a: NEON.monitor })} x={denied ? 16 : 18} y={3} />
        </g>
      )}
      {folder && folder.total > 0 && (
        // §2.2 리드 책상의 서류철: 대기가 있으면 노랑, 없으면 흐리게
        <g data-testid="folder-mark">
          <PixelSprite rects={spriteRects(FOLDER_DESK, { x: folder.pending > 0 ? NEON.yellow : "var(--muted)", a: "var(--paper)" })} x={20} y={15} />
        </g>
      )}
    </svg>
  );
  // 결정 표시: 공통 노랑 "!" 풍선(계약 §2 바뀌지 않는 칸, --yellow + --yellow-ink). 뜻은 책상 접근 이름이 전한다
  const bang = decision && !paused ? <span className="qmark" aria-hidden="true">!</span> : null;
  const scene = <DeskScene member={member} pose={POSE[member.state === "offline" ? "idle" : member.state]} vacant={vacant} />;

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
  const status = member.retiring ? { text: CMD_TEXT.statusRetiring, cls: "desk-status pink", title: `${CMD_TEXT.statusRetiring}${retireTail}` } : member.duty === "requested" ? { text: CMD_TEXT.statusOffRequested, cls: "desk-status" } : member.longIdle && !offDuty ? { text: CMD_TEXT.statusLongIdle, cls: "desk-status" } : null;
  const extra = (
    <span className="desk-extra" data-testid="extra-line">
      {pending > 0 ? folderOutside ? null : <span className="desk-folder">{CMD_TEXT.deskFolder(pending)}</span> : status && <span className={status.cls} title={"title" in status ? status.title : undefined}>{status.text}</span>}
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
        aria-label={awaiting ? CMD_TEXT.aria.await(member.name, folderMark) : `${member.name}, 결정 필요${marks}${folderMark}. 답하기 열기`}
        onClick={(e) => lead!.openReply(floorId!, member.name, q!.id, e.currentTarget)}
        {...handlers}
      >
        {awaitLabel}
      {scene}
      {svg}
      {bang}
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
        {awaitLabel}
      {scene}
      {svg}
      {bang}
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
        {awaitLabel}
      {scene}
      {svg}
      {bang}
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
      {awaitLabel}
      {scene}
      {svg}
      {bang}
      <span className="nametag">{member.name}</span>
      {meta}
      {extra}
    </div>
  );
}
