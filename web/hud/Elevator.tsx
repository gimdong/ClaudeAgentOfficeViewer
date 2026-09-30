import type { SessionView } from "../../src/shared/types";
import { goToFloor } from "./nav";

/** 층 바로가기(디자인 5.5). 위층부터 */
export function Elevator({ sessions }: { sessions: SessionView[] }) {
  if (sessions.length === 0) return null;
  const floors = [...sessions].sort((a, b) => b.floor - a.floor);
  return (
    <nav className="elevator" aria-label="층 바로가기">
      <span className="lbl">층 바로가기</span>
      {floors.map((s) => {
        const d = s.members.some((m) => m.state === "decision");
        return (
          <button key={s.id} type="button" className="el-btn" onClick={() => goToFloor(s.id)} aria-label={`${s.floor}층 ${s.name}${d ? ", 결정 대기" : ""}`}>
            <span className={`led led--${d ? "decision" : s.floorStatus}`} />
            {s.floor}F
          </button>
        );
      })}
    </nav>
  );
}
