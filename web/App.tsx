import { Building } from "./building/Building";
import { Hud } from "./hud/Hud";
import { useDecisionAnnouncer } from "./useDecisionAnnouncer";
import { useSnapshot } from "./useSnapshot";

export function App() {
  const { snapshot, live } = useSnapshot();
  const { text: announce, n: announceN } = useDecisionAnnouncer(snapshot);
  if (!snapshot) return <div className="loading">사무실 불 켜는 중...</div>;
  return (
    <div className="app">
      {snapshot.error && (
        <div className="banner" role="alert">
          {snapshot.error}
        </div>
      )}
      <Hud snapshot={snapshot} live={live} />
      <Building sessions={snapshot.sessions} />
      {/* 같은 문장이 다시 와도 스크린 리더가 다시 읽도록 새 결정마다 key를 바꿔 다시 마운트한다(Ruling P16) */}
      <div className="sr-only" role="status" key={announceN}>
        {announce}
      </div>
    </div>
  );
}
