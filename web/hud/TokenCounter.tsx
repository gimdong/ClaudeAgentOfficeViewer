import { useEffect, useRef, useState } from "react";
import { formatTokens } from "../format";

function useTweenedNumber(target: number, ms = 600): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const v = Math.round(origin + (target - origin) * k);
      from.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

export function TokenCounter({ label, value, hint, sub }: { label: string; value: number; hint?: string; sub?: string }) {
  const shown = useTweenedNumber(value);
  return (
    <div className="counter" aria-label={`${label} ${value}`}>
      <div className="label">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="value">{formatTokens(shown)}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
