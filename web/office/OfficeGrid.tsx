import type { SessionView } from "../../src/shared/types";
import { OfficeTile } from "./OfficeTile";

export function OfficeGrid({ sessions }: { sessions: SessionView[] }) {
  if (sessions.length === 0) return <div className="empty">실행 중인 Claude Code 세션이 없습니다</div>;
  return (
    <main className="grid">
      {sessions.map((s) => (
        <OfficeTile key={s.id} session={s} />
      ))}
    </main>
  );
}
