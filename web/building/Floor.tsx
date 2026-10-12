import { useContext, useEffect, useRef, useState } from "react";
import type { FloorStatus, SessionView } from "../../src/shared/types";
import type { BubbleHandlers } from "../bubble/types";
import { Desk } from "../office/Desk";
import { Icon } from "../pixel/Icon";
import { Backdrop } from "./Backdrop";
import { FloorControls } from "./FloorControls";
import { readFold, writeFold } from "./foldStore";
import { BudgetBar, Siren } from "../budget/BudgetBar";
import { BudgetDialog, BudgetSettingsContext } from "../budget/BudgetDialog";
import { MiniBar } from "./MiniBar";
import { OpenDecisionContext } from "../report/useDecisions";
import { FLOOR_TEXT, useFloorHide, useFloorSwitch, useFloorTerminate, useShownPaused } from "../floors/useFloors";
import { TerminateDialog } from "../floors/TerminateDialog";

export const floorDomId = (sessionId: string) => `floor-${sessionId}`;

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
      .flatMap((m) => (m.state === "decision" && m.decision?.id ? [m.decision] : []))
      .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
    if (oldest?.id) openDecision?.(oldest.id, document.getElementById(floorDomId(session.id))?.querySelector<HTMLElement>('[role="switch"]'));
  };
  const sw = useFloorSwitch(session, budgetCtx.announce, openOldestDecision);
  const term = useFloorTerminate(session, budgetCtx.announce, settingsOpen);
  const hider = useFloorHide(session, onHidden, budgetCtx.announce);
  const sectionRef = useRef<HTMLElement>(null);
  // 창이 닫히면 그 층의 "종료" 버튼으로(끝나 "삭제"로 바뀌었으면 그것으로, §3.1)
  const prevStage = useRef(term.stage);
  useEffect(() => {
    if (prevStage.current !== 0 && term.stage === 0) sectionRef.current?.querySelector<HTMLElement>('[data-floor-action="terminate"], [data-floor-action="delete"]')?.focus();
    prevStage.current = term.stage;
  }, [term.stage]);
  // 화면 상태: 기다리는 값(응답)을 스냅샷보다 먼저 따른다(디자인 §1.2). 칩·셔터·LED도 같은 값
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

  const id = floorDomId(session.id);
  const decisions = session.members.filter((m) => m.state === "decision").length;
  const working = session.members.filter((m) => m.state === "working").length;
  const ended = floorStatus === "ended";
  // 칩은 하나(§1.5): 종료 중 → 멈춤 → 그 밖. TS가 ended 변수만으로는 좁히지 못해 조건을 다시 직접 검사한다
  const terminating = !ended && term.terminating;
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
          <FloorControls session={session} paused={paused} busy={sw.busy} onToggle={() => void sw.toggle()} onTerminate={term.open} onHide={() => void hider.hide()} hideBusy={hider.busy} noteId={noteId} />
          {(sw.error ?? hider.error) && (
            <span className="fc-err" role="alert">
              {sw.error ?? hider.error}
            </span>
          )}
        </header>
        <div className="room" id={`${id}-room`}>
          <Backdrop />
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
            {session.members.map((m) => (
              <Desk key={m.name} member={m} paused={paused} bubbleKey={`${session.id}:${m.name}`} bubble={bubble} />
            ))}
          </div>
        </div>
      </div>
      {term.stage !== 0 && (
        <TerminateDialog session={session} stage={term.stage} sending={term.sending} error={term.error} forceDisabled={term.forceDisabled} onConfirm={() => void term.confirm()} onClose={term.close} />
      )}
      {settingsOpen && <BudgetDialog session={session} defaultTokens={budgetCtx.defaultTokens} announce={budgetCtx.announce} onClose={closeSettings} />}
    </section>
  );
}
