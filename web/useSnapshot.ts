import { useEffect, useState } from "react";
import type { Snapshot } from "../src/shared/types";

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
/** 401(접속 열쇠 없음)일 때 /api/snapshot을 다시 보는 간격(디자인 phase2 §8) */
export const UNAUTHORIZED_POLL_MS = 30_000;
/** 다른 API(결정 답하기 등)가 401을 받으면 이 이벤트로 알린다. 화면 전체가 401 안내로 바뀐다(디자인 phase2 §3 끝) */
export const UNAUTHORIZED_EVENT = "claude-office:unauthorized";

export function useSnapshot(): { snapshot: Snapshot | null; live: boolean; unauthorized: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = INITIAL_BACKOFF_MS;
    let locked = false; // 401 안내 중이면 EventSource를 다시 만들지 않는다

    // 401: 스트림을 닫고 재연결을 멈춘 뒤 30초에 한 번만 /api/snapshot을 다시 본다
    function goUnauthorized(): void {
      if (cancelled || locked) return;
      locked = true;
      setUnauthorized(true);
      setLive(false);
      es?.close();
      clearTimeout(reconnectTimer);
      pollTimer = setTimeout(check, UNAUTHORIZED_POLL_MS);
    }
    window.addEventListener(UNAUTHORIZED_EVENT, goUnauthorized);

    function check(): void {
      fetch("/api/snapshot")
        .then(async (r) => {
          if (cancelled) return;
          if (!r.ok) {
            pollTimer = setTimeout(check, UNAUTHORIZED_POLL_MS);
            return;
          }
          const s = (await r.json()) as Snapshot;
          if (cancelled) return;
          // 다시 열렸다. 바뀌었다는 안내는 하지 않는다(디자인 §8)
          locked = false;
          backoff = INITIAL_BACKOFF_MS;
          setSnapshot(s);
          setUnauthorized(false);
          connect();
        })
        .catch(() => {
          if (!cancelled) pollTimer = setTimeout(check, UNAUTHORIZED_POLL_MS);
        });
    }

    fetch("/api/snapshot")
      .then((r) => {
        if (r.status === 401) {
          goUnauthorized();
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((s: Snapshot | null) => {
        if (!cancelled && s) setSnapshot((cur) => cur ?? s);
      })
      .catch(() => {});

    function connect(): void {
      const source = new EventSource("/api/stream");
      es = source;

      // 서버는 항상 유효한 JSON을 보내지만, 전송 중 잘림이나 프록시 개입 등으로 메시지가 깨질 수
      // 있다. 파싱에 실패해도 훅이 죽지 않고 이전 스냅샷을 유지한 채 다음 메시지를 계속 받는다.
      source.addEventListener("snapshot", (e) => {
        try {
          setSnapshot(JSON.parse((e as MessageEvent).data));
          setLive(true);
          backoff = INITIAL_BACKOFF_MS; // 데이터가 정상적으로 흐르고 있으니 백오프를 초기화한다
        } catch {
          // 깨진 메시지는 무시한다.
        }
      });

      source.onopen = () => {
        backoff = INITIAL_BACKOFF_MS;
        setLive(true);
      };

      source.onerror = () => {
        setLive(false);
        if (cancelled || locked) return;
        if (source.readyState !== EventSource.CLOSED) {
          // readyState가 CONNECTING이면 네트워크 오류일 뿐이고 브라우저가 이미 자동으로
          // 재연결을 시도하는 중이다 — 여기서 새 EventSource를 또 만들면 연결이 중복된다.
          return;
        }
        // CLOSED는 영구 종료다(HTTP 응답이 200이 아니었거나 Content-Type이 달랐던 경우 등).
        // 표준 EventSource는 이 상태에서 다시는 재연결하지 않으므로 직접 backoff를 두고 재시도한다.
        source.close();
        reconnectTimer = setTimeout(() => {
          if (!cancelled && !locked) connect();
        }, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        // 닫힌 이유가 401(열쇠 없음)이면 재연결을 되풀이하지 않는다. 확인은 재연결 타이머와 나란히 한다
        fetch("/api/snapshot")
          .then((r) => {
            if (r.status === 401) goUnauthorized();
          })
          .catch(() => {});
      };
    }
    connect();

    return () => {
      cancelled = true;
      window.removeEventListener(UNAUTHORIZED_EVENT, goUnauthorized);
      clearTimeout(reconnectTimer);
      clearTimeout(pollTimer);
      es?.close();
    };
  }, []);

  return { snapshot, live, unauthorized };
}
