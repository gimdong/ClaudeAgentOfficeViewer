import { barLevel } from "../hud/HeartBar";

/** 층 머리의 작은 바(디자인 5.1 미니 바, A3). 남은 양 %를 보여준다 */
export function MiniBar({ label, remaining, noneText, hint }: { label: string; remaining: number | null; noneText: string; hint?: string }) {
  if (remaining === null) {
    return (
      <span className="mini none">
        {label} <span className="val">{noneText}</span>
      </span>
    );
  }
  // 색과 표시 숫자를 같은 반올림 값으로 정해 경계(49.6 → "50%"인데 노랑)가 어긋나지 않게 한다
  const v = Math.round(remaining);
  const level = barLevel(v);
  return (
    <span
      className={`mini${level === "ok" ? "" : ` ${level}`}`}
      role="meter"
      aria-label={hint ? `${label} 남은 양 (${hint})` : `${label} 남은 양`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
    >
      {label}
      <span className="track">
        <span className="fill" style={{ width: `${v}%` }} />
      </span>
      <span className="val">{v}%</span>
      {hint && <span className="hint">{hint}</span>}
    </span>
  );
}
