import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Snapshot } from "../../src/shared/types";
import { DiagnosticsChip } from "../diag/DiagnosticsChip";
import { DiagnosticsPanel } from "../diag/DiagnosticsPanel";
import { useDiagnostics } from "../diag/useDiagnostics";
import { formatTokens, remainingPct } from "../format";
import { DecisionChip } from "./DecisionChip";
import { Elevator } from "./Elevator";
import { HeartBar } from "./HeartBar";
import { TokenCounter } from "./TokenCounter";

export function Hud({ snapshot, live }: { snapshot: Snapshot; live: boolean }) {
  const { usage, budget, limits } = snapshot;
  const five = budget.fiveHour ? remainingPct(usage.last5h.total, budget.fiveHour) : null;
  const week = budget.weekly ? remainingPct(usage.last7d.total, budget.weekly) : null;

  // PLAN 바는 "더 급한" 쪽(더 많이 쓴, 즉 잔여가 더 적은) 창을 보여준다. 세 창 가운데 더 많이 쓴
  // 쪽을 놓치면 실제로는 그 한도가 얼마 안 남았다는 걸 못 보게 된다.
  // 두 값이 같으면 5H를 먼저 넣어두는 것만으로 동점 시 5H가 이긴다(엄격한 >로 비교하므로).
  const planCandidates: Array<{ pct: number; hint: "5H" | "WEEK" | "SPEND" }> = [];
  if (limits?.fiveHourPct !== undefined) planCandidates.push({ pct: limits.fiveHourPct, hint: "5H" });
  if (limits?.weeklyPct !== undefined) planCandidates.push({ pct: limits.weeklyPct, hint: "WEEK" });
  if (limits?.spendPct !== undefined) planCandidates.push({ pct: limits.spendPct, hint: "SPEND" });
  const worst = planCandidates.reduce<(typeof planCandidates)[number] | undefined>(
    (acc, c) => (!acc || c.pct > acc.pct ? c : acc),
    undefined,
  );
  const plan = worst ? 100 - worst.pct : null;
  const planHint = worst?.hint;

  // 진단 칩과 패널(베타 디자인 2·3·7장)
  const [diagOpen, setDiagOpen] = useState(false);
  const diag = useDiagnostics(diagOpen);
  const chip = useRef<HTMLButtonElement>(null);
  const closeDiag = () => {
    setDiagOpen(false);
    chip.current?.focus();
  };
  useEffect(() => {
    if (!diagOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // 말풍선이 떠 있으면 Esc는 말풍선이 먼저 닫는다(Phase 1 규칙). 패널은 다음 Esc에 닫는다
      if (e.key !== "Escape" || document.querySelector('.say[role="tooltip"]')) return;
      setDiagOpen(false);
      chip.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [diagOpen]);

  return (
    <header className="hud">
      <TokenCounter label="TODAY" value={usage.today.total} sub={`캐시 읽기 ${formatTokens(usage.today.cacheRead)}`} />
      <TokenCounter label="5H" value={usage.last5h.total} hint="추정" />
      <TokenCounter label="WEEK" value={usage.last7d.total} hint="추정" />
      <HeartBar label="5H" remaining={five} emptyText="-- 설정 필요" />
      <HeartBar label="WEEK" remaining={week} emptyText="-- 설정 필요" />
      <HeartBar label="PLAN" remaining={plan} emptyText="-- 데이터 없음" hint={planHint} />
      <DecisionChip snapshot={snapshot} />
      <DiagnosticsChip
        ref={chip}
        errorsLastHour={diag.data?.errorsLastHour ?? 0}
        open={diagOpen}
        onToggle={() => (diagOpen ? closeDiag() : setDiagOpen(true))}
      />
      <span className={`live ${live ? "on" : "off"}`}>{live ? "● LIVE" : "○ 재연결 중"}</span>
      <Elevator sessions={snapshot.sessions} />
      {/* .hud는 sticky라 그 안의 fixed 서랍이 HUD 쌓임 맥락에 갇힌다. body에 그린다 */}
      {diagOpen &&
        createPortal(
          <DiagnosticsPanel data={diag.data} error={diag.error} checkedAt={diag.checkedAt} busy={diag.busy} onReload={diag.reload} onClose={closeDiag} />,
          document.body,
        )}
    </header>
  );
}
