import { useContext, useRef, useState } from "react";
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

export const floorDomId = (sessionId: string) => `floor-${sessionId}`;

const STATUS_LABEL: Record<Exclude<FloorStatus, "ended">, string> = { working: "작업 중", idle: "대기", paused: "멈춤" };

function hhmm(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Floor({ session, bubble }: { session: SessionView; bubble?: BubbleHandlers }) {
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

  const id = floorDomId(session.id);
  const decisions = session.members.filter((m) => m.state === "decision").length;
  const working = session.members.filter((m) => m.state === "working").length;
  const ended = session.floorStatus === "ended";
  // TS가 별도의 ended 변수만으로는 floorStatus를 좁히지 못해 조건을 다시 직접 검사한다
  const statusText = session.floorStatus === "ended" ? `종료됨 ${hhmm(session.endedAt)}`.trim() : STATUS_LABEL[session.floorStatus];
  // 예산 도달(§7): 결정 대기가 있으면 Phase 1처럼 결정(노랑)이 먼저
  const alarm = !!session.budget?.reached && !ended;
  const led = decisions ? "decision" : alarm ? "budget" : session.floorStatus;
  const ctx = session.context;

  return (
    <section
      className={`floor floor--${session.floorStatus}${alarm ? " floor--alarm" : ""}${collapsed ? " collapsed" : ""}`}
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
          <span className={`chip chip--${session.floorStatus}`}>{statusText}</span>
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
          <FloorControls session={session} />
        </header>
        <div className="room" id={`${id}-room`}>
          <Backdrop />
          <div className="desks">
            {session.members.map((m) => (
              <Desk key={m.name} member={m} bubbleKey={`${session.id}:${m.name}`} bubble={bubble} />
            ))}
          </div>
        </div>
      </div>
      {settingsOpen && <BudgetDialog session={session} defaultTokens={budgetCtx.defaultTokens} announce={budgetCtx.announce} onClose={closeSettings} />}
    </section>
  );
}
