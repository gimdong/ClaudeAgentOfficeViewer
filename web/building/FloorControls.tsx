import type { SessionView } from "../../src/shared/types";
import { Icon } from "../pixel/Icon";

// Phase 1에서는 모양만 보여준다(디자인 A8). 동작은 Phase 4.
const OFF = { "aria-disabled": true, title: "아직 사용할 수 없습니다" } as const;

export function FloorControls({ session }: { session: SessionView }) {
  if (session.floorStatus === "ended") {
    return (
      <div className="controls">
        <button type="button" className="pbtn pbtn--danger" {...OFF}>
          <Icon name="trash" />
          삭제
        </button>
      </div>
    );
  }
  return (
    <div className="controls">
      <button type="button" className="switch" role="switch" aria-checked={true} aria-label={`${session.name} 영업`} {...OFF}>
        <span className="track">
          <span className="knob" />
        </span>
        <span className="lbl">영업 중</span>
      </button>
      <button type="button" className="pbtn" {...OFF}>
        <Icon name="send" />
        작업 지시
      </button>
      <button type="button" className="pbtn pbtn--danger" {...OFF}>
        <Icon name="stop" />
        종료
      </button>
    </div>
  );
}
