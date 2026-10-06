import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityBubble } from "./bubble/ActivityBubble";
import { useBubble } from "./bubble/useBubble";
import { Building } from "./building/Building";
import { Hud } from "./hud/Hud";
import { DecisionReport } from "./report/DecisionReport";
import { OpenDecisionContext, useDecisions } from "./report/useDecisions";
import { useDecisionAnnouncer } from "./useDecisionAnnouncer";
import { useSnapshot } from "./useSnapshot";
import { BudgetSettingsContext } from "./budget/BudgetDialog";
import { useBudgetAlarm } from "./budget/useBudgetAlarm";
import { AgentPanel } from "./policy/AgentPanel";
import { PolicyList } from "./policy/PolicyList";
import { OpenPolicyContext, usePolicy } from "./policy/usePolicy";

const AUTH_TITLE = "접속 열쇠 필요 · Claude Office";

/** 접속 열쇠(토큰 쿠키)가 없을 때의 안내(디자인 phase2 §8). HUD와 빌딩 대신 이것만 그린다 */
function AuthScreen() {
  useEffect(() => {
    const before = document.title;
    document.title = AUTH_TITLE;
    return () => {
      document.title = before;
    };
  }, []);
  return (
    <main className="auth" aria-labelledby="auth-title">
      <div className="auth-shutter" aria-hidden="true">
        <span className="auth-sign">열쇠 필요</span>
      </div>
      <h1 id="auth-title" className="auth-title">
        터미널에서 <code>claude-office</code>로 열어 주세요
      </h1>
      <p>이 화면은 접속 열쇠가 있어야 볼 수 있습니다. 터미널에서 claude-office를 실행하면 열쇠가 담긴 주소로 브라우저가 열립니다.</p>
      <p>북마크로 열었는데 이 화면이 보이면, 터미널에서 한 번만 다시 열어 주세요. 그 뒤로는 북마크로 열립니다.</p>
      <pre className="auth-cmd">$ claude-office</pre>
    </main>
  );
}

/**
 * 하나뿐인 role="status"에 넣을 문장(phase2 §9.5). 새 결정 알림(useDecisionAnnouncer)과 보고서의 알림(announce)을
 * 나중에 온 것으로 합친다. n은 넣을 때마다 오른다(같은 문장도 NBSP로 글자가 바뀐다, Ruling P16)
 */
function useLiveRegion(auto: { text: string; n: number }) {
  const [said, setSaid] = useState({ text: "", n: 0 });
  const announce = useCallback((text: string) => setSaid((s) => ({ text, n: s.n + 1 })), []);
  const lastAuto = useRef(0);
  useEffect(() => {
    if (auto.n === lastAuto.current) return;
    lastAuto.current = auto.n;
    announce(auto.text);
  }, [auto.n, auto.text, announce]);
  return { ...said, announce };
}

export function App() {
  const { snapshot, live, unauthorized } = useSnapshot();
  const { text: announceText, n: announceN, announce } = useLiveRegion(useDecisionAnnouncer(snapshot));
  const { target, handlers } = useBubble();
  const d = useDecisions(snapshot);
  const policy = usePolicy(snapshot);
  useBudgetAlarm(snapshot, announce);
  // 서랍은 한 번에 하나(디자인 phase3 §7.1): 새로 연 쪽이 다른 쪽을 포커스 되돌림 없이 닫는다
  const policyOpen = policy.open !== null;
  useEffect(() => {
    if (d.openId !== null) policy.close(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.openId]);
  useEffect(() => {
    if (policyOpen) d.close(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyOpen, policy.open]);
  if (unauthorized) return <AuthScreen />;
  if (!snapshot) return <div className="loading">사무실 불 켜는 중...</div>;
  // aria-live(role=status)는 같은 노드의 "내용이 바뀔 때" 알린다 — key로 다시 마운트하면 새 영역의
  // "등장"이라 일부 스크린 리더(VoiceOver+Safari 등)가 안 읽을 수 있다(Ruling P16 수정).
  // 같은 노드를 유지하고, 문장이 이전과 같아도 텍스트 자체가 바뀌도록 짝/홀에 따라 끝에 한 글자를 더한다.
  // 일반 공백(U+0020)은 HTML에서 접히고 접근성 트리도 정규화해 두 문장이 같은 텍스트로 보일 수 있어,
  // 접히지 않는 줄바꿈 없는 공백(U+00A0, NBSP)을 쓴다. 결정 보고서의 알림도 이 노드 하나로 한다(phase2 §9.5)
  const shown = announceN % 2 === 0 ? announceText : `${announceText}\u00A0`;
  return (
    <BudgetSettingsContext.Provider value={{ defaultTokens: snapshot.defaultBudgetTokens, announce }}>
    <OpenDecisionContext.Provider value={d.open}>
    <OpenPolicyContext.Provider value={policy.openAgent}>
      <div className="app">
        {snapshot.error && (
          <div className="banner" role="alert">
            {snapshot.error}
          </div>
        )}
        <Hud
          snapshot={snapshot}
          live={live}
          onOpenDecision={d.openOldest}
          reportOpen={d.openId !== null || policyOpen}
          onDiagOpen={() => {
            d.close(false);
            policy.close(false);
          }}
          policyCount={Object.keys(snapshot.policy?.targets ?? {}).length}
          policyOpen={policy.open?.view === "list"}
          policyUnreadable={snapshot.policy?.unreadable === true}
          onPolicyToggle={(el) => (policy.open?.view === "list" ? policy.close() : policy.openList(el))}
        />
        <Building sessions={snapshot.sessions} bubble={handlers} />
        <ActivityBubble target={target} sessions={snapshot.sessions} />
        <DecisionReport d={d} sessions={snapshot.sessions} announce={announce} />
        <AgentPanel policy={policy} snapshot={snapshot} announce={announce} />
        <PolicyList policy={policy} snapshot={snapshot} announce={announce} />
        <div className="sr-only" role="status">
          {shown}
        </div>
      </div>
    </OpenPolicyContext.Provider>
    </OpenDecisionContext.Provider>
    </BudgetSettingsContext.Provider>
  );
}
