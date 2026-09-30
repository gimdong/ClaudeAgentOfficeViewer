import { Building } from "./building/Building";
import { Hud } from "./hud/Hud";
import { useDecisionAnnouncer } from "./useDecisionAnnouncer";
import { useSnapshot } from "./useSnapshot";

export function App() {
  const { snapshot, live } = useSnapshot();
  const announce = useDecisionAnnouncer(snapshot);
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
      <div className="sr-only" role="status">
        {announce}
      </div>
    </div>
  );
}
