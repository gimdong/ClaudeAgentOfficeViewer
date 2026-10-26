import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FloorStatus, SessionView } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { Desk, SceneCell } from "../office/Desk";
import { memberVariant } from "../office/Character";
import { ThemeContext } from "../themes/ThemeContext";
import { CMD_TEXT } from "../office/leadCmdText";
import { LEAD_TEXT, shortTime } from "../office/leadText";
import { openReopen, useReopening } from "../floors/ReopenDialog";
import { SubDesks } from "../office/SubDesks";
import { PantryScene, SOFA_DX, Walker, walkMsOf } from "../office/Pantry";
import { WALK_MS, type PantryMember } from "../office/pantryPlan";
import { usePantry, useReducedMotion } from "../office/usePantry";
import { Icon } from "../pixel/Icon";
import { FloorControls } from "./FloorControls";
import { readFold, writeFold } from "./foldStore";
import { BudgetBar, Siren } from "../budget/BudgetBar";
import { BudgetDialog, BudgetSettingsContext } from "../budget/BudgetDialog";
import { MiniBar } from "./MiniBar";
import { OpenDecisionContext } from "../report/useDecisions";
import { FLOOR_TEXT, useFloorHide, useFloorSwitch, useFloorTerminate, useShownPaused } from "../floors/useFloors";
import { TerminateDialog } from "../floors/TerminateDialog";
import { BriefingDialog, CH_TEXT, InstructDialog } from "../floors/ChannelDialogs";

export const floorDomId = (sessionId: string) => `floor-${sessionId}`;

/** 층 벽지 변형(Phase 7 Task 5): 층 id 해시라 다시 그려도 같은 값. room-wall-N·room-deco-N을 같은 N으로 */
export const floorWallVariant = (floorId: string, count: number) => memberVariant(floorId, count);

const STATUS_LABEL: Record<Exclude<FloorStatus, "ended">, string> = { working: "작업 중", idle: "대기", paused: "멈춤" };

function hhmm(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Floor({ session, bubble, onHidden }: { session: SessionView; bubble?: BubbleHandlers; onHidden?(id: string, hidden: number): void }) {
  // 종료 층은 처음에 접힌다. 사용자가 바꾼 상태는 세션 id별로 기억한다(디자인 5.5)
  const [collapsed, setCollapsed] = useState(() => readFold(session.id, session.floorStatus === "ended"));
  const toggle = () => {
    const next = !collapsed;
    writeFold(session.id, next);
    setCollapsed(next);
  };

  const budgetCtx = useContext(BudgetSettingsContext);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtn = useRef<HTMLButtonElement>(null);
  const closeSettings = () => {
    setSettingsOpen(false);
    settingsBtn.current?.focus();
  };

  const openDecision = useContext(OpenDecisionContext);
  // 재개 직후 이 층에서 가장 오래 기다린 결정의 보고서를 연다. 닫으면 스위치로 돌아온다
  const openOldestDecision = () => {
    const oldest = session.members
      // ask_user(kind chat)는 결정 보고서가 아니라 답 칸이라 뺀다(Phase 6b)
      .flatMap((m) => (m.state === "decision" && m.decision?.id && m.decision.kind !== "chat" ? [m.decision] : []))
      .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
    if (oldest?.id) openDecision?.(oldest.id, document.getElementById(floorDomId(session.id))?.querySelector<HTMLElement>('[role="switch"]'));
  };
  const sw = useFloorSwitch(session, budgetCtx.announce, openOldestDecision);
  // Phase 4b: 작업 지시 창과 재개 브리핑 창
  const [instructOpen, setInstructOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const ch = session.channel;
  const swEl = () => document.getElementById(floorDomId(session.id))?.querySelector<HTMLElement>('[role="switch"]');
  const term = useFloorTerminate(session, budgetCtx.announce, settingsOpen);
  const hider = useFloorHide(session, onHidden, budgetCtx.announce);
  const sectionRef = useRef<HTMLElement>(null);
  // 창이 닫히면 그 층의 "종료" 버튼으로(끝나 "숨기기"로 바뀌었으면 그것으로, §3.1)
  const prevStage = useRef(term.stage);
  useEffect(() => {
    if (prevStage.current !== 0 && term.stage === 0) sectionRef.current?.querySelector<HTMLElement>('[data-floor-action="terminate"], [data-floor-action="delete"]')?.focus();
    prevStage.current = term.stage;
  }, [term.stage]);
  // 화면 상태: 기다리는 값(응답)을 스냅샷보다 먼저 따른다(디자인 §1.2). 칩·셔터·LED도 같은 값
  const reopening = useReopening(session.id) || session.reopen === "busy";
  const paused = session.floorStatus !== "ended" && sw.paused;
  useShownPaused(session.id, paused);
  const floorStatus = session.floorStatus === "ended" ? "ended" : paused ? "paused" : session.floorStatus !== "paused" ? session.floorStatus : session.members.some((m) => m.state === "working" || m.state === "decision") ? "working" : "idle";
  // 셔터는 영업 중 → 멈춤으로 바뀐 순간에만 내려오는 애니메이션(첫 렌더에는 없음, §2.4)
  const wasPaused = useRef(paused);
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    if (paused && !wasPaused.current) setDropping(true);
    if (!paused) setDropping(false);
    wasPaused.current = paused;
  }, [paused]);

  // 탕비실 걷기(Phase 7 T6b, 계약 SPEC §3). 휴업 층은 계획기에서 뺀다(모두 책상). 걷는 시간은 책상 ↔ 커피 자리 실제 거리
  const roomRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Record<string, [desk: number, pantry: number, y: number]>>({});
  const names = session.members.map((m) => m.name).join("\n");
  useLayoutEffect(() => {
    const measure = () => {
      const room = roomRef.current?.getBoundingClientRect();
      const p = roomRef.current?.querySelector(".pantry-scene")?.getBoundingClientRect();
      if (!room || !p) return;
      const next: typeof geo = {};
      for (const d of roomRef.current!.querySelectorAll<HTMLElement>(".desk-scene[data-member]")) next[d.dataset.member!] = [d.getBoundingClientRect().left - room.left + 8, p.left - room.left + 2, p.top - room.top + 32];
      setGeo((g) => (JSON.stringify(g) === JSON.stringify(next) ? g : next));
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [names, collapsed]);
  const plan: PantryMember[] = paused
    ? []
    : session.members.map((m) => {
        const since = m.state === "idle" && m.lastActivityAt ? Date.parse(m.lastActivityAt) : NaN;
        const g = geo[m.name];
        return { name: m.name, state: m.state, duty: m.duty, idleSince: Number.isFinite(since) ? since : undefined, walkMs: g && walkMsOf(Math.abs(g[1] - g[0])), sofaWalkMs: g && walkMsOf(Math.abs(g[1] + SOFA_DX - g[0])) };
      });
  // 스냅샷마다 새 배열이면 계획 타이머를 다시 맞추므로, 내용이 같으면 같은 배열(reviewer m2)
  const planKey = JSON.stringify(plan);
  const planMembers = useMemo(() => plan, [planKey]);
  const pantry = usePantry(planMembers, useReducedMotion());
  const spotOf = (name: string) => pantry[name]?.spot ?? "desk";
  // 걷는 사람의 탕비실 쪽 끝 = 계획기가 출발 때 정한 자리(I1). 걷는 시간도 그 자리까지 거리(속도 3칸/120ms 고정)
  const seatX = (name: string) => (pantry[name]?.seat === "sofa" ? SOFA_DX : 0);
  const walkMs = (name: string) => {
    const p = planMembers.find((x) => x.name === name);
    return (pantry[name]?.seat === "sofa" ? p?.sofaWalkMs : p?.walkMs) ?? WALK_MS;
  };

  const id = floorDomId(session.id);
  const { theme, variant } = useContext(ThemeContext);
  const wall = floorWallVariant(session.id, Object.values(theme.slots["room-wall"])[0]?.layout?.wallVariants ?? 1);
  // 벽지 타일 낱장(24칸 반복). 없으면 CSS의 --th-wall 줄무늬
  const tile = theme.sheets[`room-wall-${wall}-${variant}.png`];
  const decisions = session.members.filter((m) => m.state === "decision").length;
  const working = session.members.filter((m) => m.state === "working").length;
  const ended = floorStatus === "ended";
  // 칩은 하나(§1.5): 종료 중 → 멈춤 → 그 밖. TS가 ended 변수만으로는 좁히지 못해 조건을 다시 직접 검사한다
  // 옮겨 여는 동안도 "종료 중"(REOPEN §4)
  const terminating = !ended && (term.terminating || reopening);
  const statusText = floorStatus === "ended" ? `종료됨 ${hhmm(session.endedAt)}`.trim() : terminating ? FLOOR_TEXT.terminating : STATUS_LABEL[floorStatus];
  const chipClass = terminating ? "terminating" : floorStatus;
  const noteId = `${id}-pause-note`;
  // 예산 도달(§7): 결정 대기가 있으면 Phase 1처럼 결정(노랑)이 먼저
  const alarm = !!session.budget?.reached && !ended;
  const led = decisions ? "decision" : alarm ? "budget" : floorStatus;
  const ctx = session.context;

  return (
    <section
      ref={sectionRef}
      className={`floor floor--${floorStatus}${alarm ? " floor--alarm" : ""}${collapsed ? " collapsed" : ""}`}
      id={id}
      aria-labelledby={`${id}-name`}
      data-testid="floor"
    >
      <div className="shaft">
        <span className="fl-no">{session.floor}F</span>
        <span className={`led led--${led}`} title={decisions ? "결정 대기" : alarm ? "예산 도달" : statusText} />
        {alarm && <Siren />}
      </div>
      <div className="floor-body">
        <header className="floor-head">
          <button type="button" className="fold" onClick={toggle} aria-expanded={!collapsed} aria-controls={`${id}-room`} aria-label={collapsed ? "펼치기" : "접기"}>
            <Icon name="fold" />
          </button>
          <h2 className="floor-name" id={`${id}-name`} title={session.cwd}>
            {session.isCurrent && (
              <span className="star" aria-label="지금 이 세션">
                ★
              </span>
            )}
            {session.name}
          </h2>
          <span className={`chip chip--${chipClass}`} {...(paused && !terminating ? { title: FLOOR_TEXT.pauseNote } : {})}>
            {statusText}
          </span>
          {paused && (session.pausedDenied ?? 0) > 0 && <span className="fl-blocked">{FLOOR_TEXT.blocked(session.pausedDenied ?? 0)}</span>}
          {paused && (
            <span className="sr-only" id={noteId}>
              {FLOOR_TEXT.pauseNote}
            </span>
          )}
          {session.stale && <span className="stale">⚠ 갱신 지연</span>}
          {alarm && <span className="chip chip--budget">예산 도달</span>}
          {ch && (
            <span className="chip chip--channel" data-testid="channel-chip" title={ch.unreceived ? CH_TEXT.unreceived : undefined}>
              {CH_TEXT.chipLaunched} · {ch.connected ? CH_TEXT.chipConnected : CH_TEXT.chipWaiting}
              {ch.held > 0 ? ` · ${CH_TEXT.chipHeld(ch.held)}` : ch.unreceived ? ` · ${CH_TEXT.chipUnreceived}` : ch.last ? ` · ${ch.last === "delivered" ? CH_TEXT.chipDelivered : CH_TEXT.chipSent}` : ""}
            </span>
          )}
          {decisions > 0 && <span className="chip chip--decision">? 결정 {decisions}</span>}
          <span className="summary">
            팀원 {session.members.length} · 작업 중 {working}
            {decisions > 0 ? ` · 결정 ${decisions}` : ""}
          </span>
          {!ended && (
            <span className="bars">
              <MiniBar label="CTX" remaining={ctx ? 100 - ctx.pct : null} noneText="--" hint={ctx?.estimated ? "추정" : undefined} />
              <BudgetBar ref={settingsBtn} budget={session.budget} floorName={session.name} onOpenSettings={() => setSettingsOpen(true)} />
            </span>
          )}
          <FloorControls
            session={session}
            paused={paused}
            busy={sw.busy}
            // 보관 지시가 있는 층을 재개할 때는 브리핑 창부터(스펙 7장)
            onToggle={() => (paused && (ch?.held ?? 0) > 0 ? setBriefOpen(true) : void sw.toggle())}
            onTerminate={term.open}
            onHide={() => void hider.hide()}
            hideBusy={hider.busy}
            noteId={noteId}
            reopening={reopening}
            onReopen={() => openReopen(session)}
            instruct={!ch ? { enabled: false, title: CH_TEXT.notLaunched, onClick: () => {} } : ch.connected || paused ? { enabled: true, onClick: () => setInstructOpen(true) } : { enabled: false, title: ch.reconnecting ? LEAD_TEXT.reconnecting : CH_TEXT.notConnected, onClick: () => {} }}
          />
          {(sw.error ?? hider.error) && (
            <span className="fc-err" role="alert">
              {sw.error ?? hider.error}
            </span>
          )}
        </header>
        <div className="room" id={`${id}-room`} data-wall={wall} ref={roomRef} style={tile ? { backgroundImage: `url(${tile})` } : undefined}>
          <i className="win" aria-hidden="true" />
          <SceneCell slot="room-wall" name={`room-deco-${wall}`} className={`sc room-deco deco-${wall}`} />
          {paused && (
            // animationend 뒤 클래스를 내려, 접었다 펼칠 때(display 복귀) 다시 내려오지 않게(B129 M2)
            <div className={`shutter${dropping ? " shutter-down" : ""}`} aria-hidden="true" onAnimationEnd={() => setDropping(false)}>
              <span className="shutter-sign">
                휴업<small>잠시 쉬는 중</small>
              </span>
              {decisions > 0 && <span className="shutter-note">{FLOOR_TEXT.waiting(decisions)}</span>}
            </div>
          )}
          <div className="desks">
            {session.members.map((m, i) => (
              <Fragment key={m.name}>
                <Desk member={m} paused={paused} bubbleKey={`${session.id}:${m.name}`} bubble={bubble} floorId={session.id} folder={i === 0 ? session.folder : undefined} retireWait={!session.channel?.connected} away={spotOf(m.name) !== "desk"} />
                {/* 임시 책상 묶음은 리드 바로 오른쪽(서브에이전트 임시 책상 SPEC §1) */}
                {i === 0 && <SubDesks list={session.subagents ?? []} paused={paused} />}
              </Fragment>
            ))}
            <PantryScene coffee={session.members.find((m) => spotOf(m.name) === "pantry" && pantry[m.name].seat === "coffee")} sofa={session.members.find((m) => spotOf(m.name) === "pantry" && pantry[m.name].seat === "sofa")} />
          </div>
          <div className="walk-layer" aria-hidden="true">
            {session.members.map((m) => {
              const s = pantry[m.name];
              const g = geo[m.name] ?? [0, 0, 0];
              if (s?.spot !== "walking-out" && s?.spot !== "walking-back") return null;
              const seat = g[1] + seatX(m.name);
              const out = s.spot === "walking-out";
              return <Walker key={m.name} member={m} from={out ? g[0] : seat} to={out ? seat : g[0]} y={g[2]} since={s.since} ms={walkMs(m.name)} out={out} />;
            })}
          </div>
          {(session.predecessors?.length ?? 0) > 0 && (
            // 전임자 서랍(Phase 6b designer SPEC §6·B323): 방 오른쪽 아래, 펼친 목록은 방 위로 겹친다. 시작 시각이 있으면 기간, 없으면 퇴사 시각만(글자로만)
            <details className="predecessors">
              <summary aria-label={CMD_TEXT.predecessorsAria(session.predecessors!.length)}>
                <Icon name="fold" />
                {CMD_TEXT.predecessors(session.predecessors!.length)}
              </summary>
              <ul>
                {session.predecessors!.some((p) => p.startedAt) && <li className="pd-head">{CMD_TEXT.period}</li>}
                {session.predecessors!.map((p) => (
                  <li key={`${p.name}-${p.retiredAt}`}>
                    <span className="pd-name">{p.name}</span>
                    <span className="pd-time">{p.startedAt ? `${shortTime(p.startedAt)} ~ ${shortTime(p.retiredAt)}` : `${CMD_TEXT.retiredAt} ${shortTime(p.retiredAt)}`}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
      {term.stage !== 0 && (
        <TerminateDialog session={session} stage={term.stage} sending={term.sending} error={term.error} forceDisabled={term.forceDisabled} onConfirm={() => void term.confirm()} onClose={term.close} />
      )}
      {instructOpen && (
        <InstructDialog
          id={session.id}
          name={session.name}
          paused={paused}
          working={session.members.some((m) => m.state === "working")}
          announce={budgetCtx.announce}
          onClose={() => {
            setInstructOpen(false);
            document.getElementById(floorDomId(session.id))?.querySelector<HTMLElement>(".controls [aria-haspopup='dialog']:not([data-floor-action])")?.focus();
          }}
        />
      )}
      {briefOpen && (
        <BriefingDialog
          id={session.id}
          name={session.name}
          decisions={session.members.filter((m) => m.state === "decision").length}
          onGoDecision={() => {
            setBriefOpen(false);
            openOldestDecision();
          }}
          onResume={(sendHeld) => sw.toggle({ sendHeld })}
          onClose={() => {
            setBriefOpen(false);
            swEl()?.focus();
          }}
        />
      )}
      {settingsOpen && <BudgetDialog session={session} defaultTokens={budgetCtx.defaultTokens} announce={budgetCtx.announce} onClose={closeSettings} />}
    </section>
  );
}
