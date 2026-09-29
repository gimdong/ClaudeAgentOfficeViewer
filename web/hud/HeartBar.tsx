export type Level = "ok" | "warn" | "danger";

export function barLevel(remaining: number): Level {
  if (remaining >= 50) return "ok";
  if (remaining >= 20) return "warn";
  return "danger";
}

export function HeartBar({ label, remaining, emptyText, hint }: { label: string; remaining: number | null; emptyText: string; hint?: string }) {
  return (
    <div className="heartbar">
      <div className="heartbar-label">
        {label} ♥{hint && <span className="hint">{hint}</span>}
      </div>
      {remaining === null ? (
        <div className="heartbar-empty">{emptyText}</div>
      ) : (
        <div
          className={`heartbar-track level-${barLevel(remaining)}`}
          role="meter"
          aria-label={`${label} 잔여`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(remaining)}
        >
          <div className="heartbar-fill" style={{ width: `${remaining}%` }} />
          <span className="heartbar-value">{Math.round(remaining)}%</span>
        </div>
      )}
    </div>
  );
}
