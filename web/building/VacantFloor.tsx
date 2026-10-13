import { useContext, useRef, useState } from "react";
import type { Snapshot } from "../../src/shared/types";
import { BudgetSettingsContext } from "../budget/BudgetDialog";
import { CH_TEXT, LaunchDialog } from "../floors/ChannelDialogs";
import { Icon } from "../pixel/Icon";

/** 맨 위 빈 층(디자인 5.2). Phase 4b: 실험 기능이 켜져 있으면 새 층을 띄운다 */
export function VacantFloor({ experimental }: { experimental?: Snapshot["experimental"] }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const { announce } = useContext(BudgetSettingsContext);
  const on = !!experimental?.channels;
  return (
    <section className="floor floor--empty" aria-label="빈 층" data-testid="vacant-floor">
      <div className="shaft">
        <span className="fl-no" aria-hidden="true">
          +
        </span>
        <span className="led led--empty" />
      </div>
      <div className="floor-body">
        <div className="room">
          <div className="vacant">
            <span className="sign">빈 층</span>
            <p>폴더와 첫 지시를 정하면 이 층에서 새 세션을 엽니다</p>
            <button ref={btn} type="button" className="pbtn pbtn--primary" aria-haspopup="dialog" {...(on ? { onClick: () => setOpen(true) } : { "aria-disabled": true, title: experimental ? CH_TEXT.offTitle : "아직 사용할 수 없습니다" })}>
              <Icon name="plus" />
              {CH_TEXT.launchButton}
            </button>
          </div>
        </div>
      </div>
      {open && (
        <LaunchDialog
          announce={announce}
          onClose={() => {
            setOpen(false);
            btn.current?.focus();
          }}
        />
      )}
    </section>
  );
}
