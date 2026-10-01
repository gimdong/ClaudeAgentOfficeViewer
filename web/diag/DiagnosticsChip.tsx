import { forwardRef } from "react";
import { DiagIcon } from "./DiagIcon";

/** HUD "진단" 칩(디자인 2장). 항상 보이고, 최근 1시간에 error가 있으면 빨간 점(깜빡이지 않음) */
export const DiagnosticsChip = forwardRef<HTMLButtonElement, { errorsLastHour: number; open: boolean; onToggle(): void }>(
  function DiagnosticsChip({ errorsLastHour, open, onToggle }, ref) {
    const n = errorsLastHour;
    return (
      <button
        ref={ref}
        type="button"
        className="diag-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="diag-panel"
        aria-label={n > 0 ? `진단 열기, 최근 1시간 오류 ${n}건` : "진단 열기"}
        onClick={onToggle}
      >
        <DiagIcon name="diag" />
        진단
        {n > 0 && <span className="diag-dot" aria-hidden="true" />}
      </button>
    );
  },
);
