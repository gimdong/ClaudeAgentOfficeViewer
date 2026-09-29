import { useEffect, useState } from "react";
import type { Snapshot } from "../src/shared/types";

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30_000;

export function useSnapshot(): { snapshot: Snapshot | null; live: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = INITIAL_BACKOFF_MS;

    fetch("/api/snapshot")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Snapshot | null) => {
        if (!cancelled && s) setSnapshot((cur) => cur ?? s);
      })
      .catch(() => {});

    function connect(): void {
      es = new EventSource("/api/stream");

      // 서버는 항상 유효한 JSON을 보내지만, 전송 중 잘림이나 프록시 개입 등으로 메시지가 깨질 수
      // 있다. 파싱에 실패해도 훅이 죽지 않고 이전 스냅샷을 유지한 채 다음 메시지를 계속 받는다.
      es.addEventListener("snapshot", (e) => {
        try {
          setSnapshot(JSON.parse((e as MessageEvent).data));
          setLive(true);
          backoff = INITIAL_BACKOFF_MS; // 데이터가 정상적으로 흐르고 있으니 백오프를 초기화한다
        } catch {
          // 깨진 메시지는 무시한다.
        }
      });

      es.onopen = () => {
        backoff = INITIAL_BACKOFF_MS;
        setLive(true);
      };

      es.onerror = () => {
        setLive(false);
        if (cancelled) return;
        if (es.readyState !== EventSource.CLOSED) {
          // readyState가 CONNECTING이면 네트워크 오류일 뿐이고 브라우저가 이미 자동으로
          // 재연결을 시도하는 중이다 — 여기서 새 EventSource를 또 만들면 연결이 중복된다.
          return;
        }
        // CLOSED는 영구 종료다(HTTP 응답이 200이 아니었거나 Content-Type이 달랐던 경우 등).
        // 표준 EventSource는 이 상태에서 다시는 재연결하지 않으므로 직접 backoff를 두고 재시도한다.
        es.close();
        reconnectTimer = setTimeout(() => {
          if (!cancelled) connect();
        }, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    }
    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      es.close();
    };
  }, []);

  return { snapshot, live };
}
