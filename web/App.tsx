import { Building } from "./building/Building";
import { Hud } from "./hud/Hud";
import { useDecisionAnnouncer } from "./useDecisionAnnouncer";
import { useSnapshot } from "./useSnapshot";

export function App() {
  const { snapshot, live } = useSnapshot();
  const { text: announce, n: announceN } = useDecisionAnnouncer(snapshot);
  if (!snapshot) return <div className="loading">사무실 불 켜는 중...</div>;
  // aria-live(role=status)는 같은 노드의 "내용이 바뀔 때" 알린다 — key로 다시 마운트하면 새 영역의
  // "등장"이라 일부 스크린 리더(VoiceOver+Safari 등)가 안 읽을 수 있다(Ruling P16 수정).
  // 같은 노드를 유지하고, 문장이 이전과 같아도 텍스트 자체가 바뀌도록 짝/홀에 따라 끝에 한 글자를 더한다.
  // 일반 공백(U+0020)은 HTML에서 접히고 접근성 트리도 정규화해 두 문장이 같은 텍스트로 보일 수 있어,
  // 접히지 않는 줄바꿈 없는 공백(U+00A0, NBSP)을 쓴다.
  const shown = announceN % 2 === 0 ? announce : `${announce} `;
  return (
    <div className="app">
      {snapshot.error && (
        <div className="banner" role="alert">
          {snapshot.error}
        </div>
      )}
      <Hud snapshot={snapshot} live={live} />
      <Building sessions={snapshot.sessions} />
      <div className="sr-only" role="status">
        {shown}
      </div>
    </div>
  );
}
