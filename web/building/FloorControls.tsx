import type { SessionView } from "../../src/shared/types";
import { FLOOR_TEXT } from "../floors/useFloors";
import { Icon } from "../pixel/Icon";

// 작업 지시는 Phase 4b까지 모양만 보여준다(디자인 phase4a §1.4). 숨김은 Task 7
const OFF = { "aria-disabled": true, title: FLOOR_TEXT.orderTitle } as const;

/** 층 머리 컨트롤(디자인 phase4a §1). 스위치 상태(paused·busy)는 Floor의 useFloorSwitch가 든다 */
export function FloorControls({ session, paused, busy, onToggle, onTerminate, noteId }: { session: SessionView; paused: boolean; busy: boolean; onToggle(): void; onTerminate(): void; noteId: string }) {
  if (session.floorStatus === "ended") {
    return (
      <div className="controls">
        <button type="button" className="pbtn pbtn--danger" data-floor-action="delete" {...OFF}>
          <Icon name="trash" />
          삭제
        </button>
      </div>
    );
  }
  return (
    <div className="controls">
      {/* disabled는 쓰지 않는다(포커스가 body로 떨어짐, B105). 요청 중 다시 누르면 훅이 무시한다 */}
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={!paused}
        aria-label={`${session.name} 영업`}
        aria-busy={busy || undefined}
        aria-describedby={paused ? noteId : undefined}
        onClick={onToggle}
      >
        <span className="track">
          <span className="knob" />
        </span>
        <span className="lbl">{paused ? FLOOR_TEXT.off : FLOOR_TEXT.on}</span>
      </button>
      <button type="button" className="pbtn" {...OFF}>
        <Icon name="send" />
        작업 지시
      </button>
      <button type="button" className="pbtn pbtn--danger" data-floor-action="terminate" aria-haspopup="dialog" aria-label={FLOOR_TEXT.terminateLabel(session.name)} onClick={onTerminate}>
        <Icon name="stop" />
        종료
      </button>
    </div>
  );
}
