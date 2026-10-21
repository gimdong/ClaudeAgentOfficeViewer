import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Snapshot } from "../../src/shared/types";
import { DiagnosticsChip } from "../diag/DiagnosticsChip";
import { DiagnosticsPanel } from "../diag/DiagnosticsPanel";
import { useDiagnostics } from "../diag/useDiagnostics";
import { formatTokens } from "../format";
import { DecisionChip } from "./DecisionChip";
import { Elevator } from "./Elevator";
import { HeartBar } from "./HeartBar";
import { PolicyChip } from "./PolicyChip";
import { ExperimentalChip } from "./ExperimentalChip";
import { PluginChip } from "./PluginChip";
import { BAR_EMPTY, remainingOf } from "./remaining";
import { TokenCounter } from "./TokenCounter";

export function Hud({
  snapshot,
  live,
  onOpenDecision,
  reportOpen = false,
  onDiagOpen,
  policyCount = 0,
  policyOpen = false,
  policyUnreadable = false,
  onPolicyToggle,
}: {
  snapshot: Snapshot;
  live: boolean;
  /** HUD 결정 칩이 가장 오래 기다린 결정을 연다 */
  onOpenDecision?(opener: HTMLElement): void;
  /** 결정 보고서가 열려 있으면 진단 서랍을 닫는다(phase2 §5: 한 번에 하나) */
  reportOpen?: boolean;
  /** 진단 서랍을 열 때 결정 보고서를 닫게 알린다 */
  onDiagOpen?(): void;
  /** 권한 정책 버튼(phase3 §5): 저장된 대상 수, 목록 서랍이 열렸는지, 정책 파일을 읽지 못했는지(B101) */
  policyCount?: number;
  policyOpen?: boolean;
  policyUnreadable?: boolean;
  onPolicyToggle?(opener: HTMLElement): void;
}) {
  const { usage } = snapshot;
  const { five, week, plan, planHint } = remainingOf(snapshot);

  // 진단 칩과 패널(베타 디자인 2·3·7장)
  const [diagOpen, setDiagOpen] = useState(false);
  const diag = useDiagnostics(diagOpen);
  const chip = useRef<HTMLButtonElement>(null);
  const closeDiag = () => {
    setDiagOpen(false);
    chip.current?.focus();
  };
  // 보고서가 열리면 진단 서랍은 애니메이션 없이 바로 닫는다. 포커스는 보고서의 규칙을 따른다(§5)
  useEffect(() => {
    if (reportOpen) setDiagOpen(false);
  }, [reportOpen]);
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
      <HeartBar label="5H" remaining={five} emptyText={BAR_EMPTY.needSetup} />
      <HeartBar label="WEEK" remaining={week} emptyText={BAR_EMPTY.needSetup} />
      <HeartBar label="PLAN" remaining={plan} emptyText={BAR_EMPTY.planNone} hint={planHint} />
      <DecisionChip snapshot={snapshot} onOpen={onOpenDecision} />
      {snapshot.experimental && <ExperimentalChip exp={snapshot.experimental} />}
      <PluginChip snapshot={snapshot} />
      <PolicyChip count={policyCount} open={policyOpen} unreadable={policyUnreadable} onToggle={(el) => onPolicyToggle?.(el)} />
      <DiagnosticsChip
        ref={chip}
        errorsLastHour={diag.data?.errorsLastHour ?? 0}
        open={diagOpen}
        onToggle={() => {
          if (diagOpen) return closeDiag();
          onDiagOpen?.();
          setDiagOpen(true);
        }}
      />
      <span className={`live ${live ? "on" : "off"}`}>{live ? "● LIVE" : "○ 재연결 중"}</span>
      {/* 지금 돌고 있는 서버의 버전(사용자 요청). 옛 서버는 버전을 싣지 않으므로 화면 버전에 "화면"을 붙여 구별한다(FB-7 띠와 짝) */}
      <span className="version" data-testid="version" title={`서버 ${snapshot.serverVersion ?? "알 수 없음"} · 화면 ${__APP_VERSION__}`}>
        {snapshot.serverVersion ? `v${snapshot.serverVersion}` : `화면 v${__APP_VERSION__}`}
      </span>
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
