import { forwardRef } from "react";
import { DiagIcon } from "../diag/DiagIcon";
import { Icon } from "../pixel/Icon";
import { chipLabel, LIST_TEXT } from "../policy/text";

/** HUD "권한 정책" 버튼(디자인 phase3 §5). 정책 파일을 읽지 못했으면 삼각형 하나와 빨간 테두리(B101) */
export const PolicyChip = forwardRef<HTMLButtonElement, { count: number; open: boolean; unreadable: boolean; onToggle(opener: HTMLElement): void }>(
  function PolicyChip({ count, open, unreadable, onToggle }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={`diag-chip policy-chip${unreadable ? " unreadable" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="pl-panel"
        aria-label={chipLabel(count, unreadable)}
        onClick={(e) => onToggle(e.currentTarget)}
      >
        <Icon name="lock" accent="#0e0d18" />
        {LIST_TEXT.title}
        {count > 0 && <span className="pc-count" aria-hidden="true">{count}</span>}
        {unreadable && <DiagIcon name="warn" className="pc-warn" />}
      </button>
    );
  },
);
