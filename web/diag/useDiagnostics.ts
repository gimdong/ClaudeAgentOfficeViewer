import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagnosticsSummary } from "../../src/shared/types";

const POLL_MS = 60_000;

/**
 * GET /api/diagnostics. 칩의 빨간 점 때문에 패널이 닫혀 있어도 60초마다 가져오고, 패널을 열 때 다시 가져온다.
 * 가져오기에 실패해도 data는 마지막 값을 유지한다(칩의 점은 그대로). error는 마지막 시도의 결과다.
 */
export function useDiagnostics(open: boolean): {
  data: DiagnosticsSummary | null;
  error: string | null;
  checkedAt: number | null;
  busy: boolean;
  reload(): void;
} {
  const [data, setData] = useState<DiagnosticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const seq = useRef(0); // 요청 순번. 늦게 온 옛 응답이 새 값을 덮지 않게 마지막 요청만 반영한다

  const reload = useCallback(() => {
    const n = ++seq.current;
    const latest = () => alive.current && n === seq.current;
    setBusy(true);
    fetch("/api/diagnostics")
      .then((r) => (r.ok ? (r.json() as Promise<DiagnosticsSummary>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!latest()) return;
        setData(d);
        setError(null);
        setCheckedAt(Date.now());
      })
      .catch(() => {
        if (latest()) setError("진단 정보를 가져오지 못했습니다. 서버가 켜져 있는지 확인해 주세요.");
      })
      .finally(() => {
        if (latest()) setBusy(false);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    reload(); // 칩의 점을 위해 처음 한 번
    const t = setInterval(reload, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [reload]);

  // 패널을 열 때마다 새로 가져온다(닫을 때는 가져오지 않는다)
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  return { data, error, checkedAt, busy, reload };
}
