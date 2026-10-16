import type { SessionView } from "../../src/shared/types";
import { RE_TEXT } from "../floors/ReopenDialog";
import { FLOOR_TEXT } from "../floors/useFloors";
import { Icon } from "../pixel/Icon";

// 작업 지시는 Phase 4b까지 모양만 보여준다(디자인 phase4a §1.4)
const OFF = { "aria-disabled": true, title: FLOOR_TEXT.orderTitle } as const;

/** 층 머리 컨트롤(디자인 phase4a §1). 스위치 상태(paused·busy)는 Floor의 useFloorSwitch가 든다 */
export function FloorControls({ session, paused, busy, onToggle, onTerminate, onHide, hideBusy = false, noteId, instruct, reopening = false, onReopen }: { session: SessionView; paused: boolean; busy: boolean; onToggle(): void; onTerminate(): void; onHide?(): void; hideBusy?: boolean; noteId: string; instruct?: { enabled: boolean; title?: string; onClick(): void }; /** 옮겨 여는 중(창을 닫았어도, 다른 탭이어도) — 스위치·종료·삭제를 막는다(REOPEN §1.3, B205 ②) */ reopening?: boolean; onReopen?(): void }) {
  const moving = { "aria-disabled": true, title: RE_TEXT.titleMoving } as const;
  if (session.floorStatus === "ended") {
    return (
      <div className="controls">
        {/* 확인 창 없이 숨긴다(되돌릴 수 있고 데이터를 지우지 않음, 스펙 6). 이름에 보이는 글자 "삭제"를 넣는다(§4.1) */}
        <button
          type="button"
          className="pbtn pbtn--danger"
          data-floor-action="delete"
          aria-label={FLOOR_TEXT.hideLabel(session.name)}
          title={FLOOR_TEXT.hideTitle}
          aria-busy={hideBusy || undefined}
          {...(reopening ? moving : {})}
          onClick={() => !hideBusy && !reopening && onHide?.()}
        >
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
        {...(reopening ? moving : {})}
        onClick={() => !reopening && onToggle()}
      >
        <span className="track">
          <span className="knob" />
        </span>
        <span className="lbl">{paused ? FLOOR_TEXT.off : FLOOR_TEXT.on}</span>
      </button>
      {/* 같은 자리에 하나: 대시보드가 띄우지 않은 층(실험 기능 켜짐)은 "작업 지시 켜기"(REOPEN §1), 그 밖은 Phase 4b "작업 지시" */}
      {session.reopen && session.reopen !== "launched" ? (
        <ReopenButton session={session} paused={paused} reopening={reopening || session.reopen === "busy"} onReopen={onReopen} />
      ) : (
        <button type="button" className="pbtn" aria-haspopup="dialog" {...(instruct?.enabled ? { onClick: instruct.onClick } : { "aria-disabled": true, title: instruct?.title ?? OFF.title })}>
          <Icon name="send" />
          작업 지시
        </button>
      )}
      <button type="button" className="pbtn pbtn--danger" data-floor-action="terminate" aria-haspopup="dialog" aria-label={FLOOR_TEXT.terminateLabel(session.name)} {...(reopening ? moving : {})} onClick={() => !reopening && onTerminate()}>
        <Icon name="stop" />
        종료
      </button>
    </div>
  );
}

/** "작업 지시 켜기" 버튼 상태(REOPEN §1.1·§1.3): 옮기는 중 → 멈춘 층(B202) → 합친 층·조상(B205) → 누를 수 있음 */
function ReopenButton({ session, paused, reopening, onReopen }: { session: SessionView; paused: boolean; reopening: boolean; onReopen?(): void }) {
  const block = reopening ? RE_TEXT.titleMoving : paused || session.reopen === "paused" ? RE_TEXT.titlePaused : session.reopen === "merged" ? RE_TEXT.titleMerged : session.reopen === "ancestor" ? RE_TEXT.titleAncestor : null;
  return (
    <button
      type="button"
      className="pbtn"
      data-floor-action="reopen"
      aria-haspopup="dialog"
      aria-label={RE_TEXT.label(session.name)}
      title={block ?? RE_TEXT.title}
      {...(block ? { "aria-disabled": true } : {})}
      aria-busy={reopening || undefined}
      onClick={() => !block && onReopen?.()}
    >
      <Icon name="send" />
      {RE_TEXT.button}
    </button>
  );
}
