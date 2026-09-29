import { Hud } from "./hud/Hud";
import { OfficeGrid } from "./office/OfficeGrid";
import { useSnapshot } from "./useSnapshot";

export function App() {
  const { snapshot, live } = useSnapshot();
  if (!snapshot) return <div className="loading">사무실 불 켜는 중...</div>;
  return (
    <div className="app">
      {snapshot.error && (
        <div className="banner" role="alert">
          {snapshot.error}
        </div>
      )}
      <Hud snapshot={snapshot} live={live} />
      <OfficeGrid sessions={snapshot.sessions} />
    </div>
  );
}
