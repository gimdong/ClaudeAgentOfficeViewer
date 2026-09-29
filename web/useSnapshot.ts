import { useEffect, useState } from "react";
import type { Snapshot } from "../src/shared/types";

export function useSnapshot(): { snapshot: Snapshot | null; live: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let closed = false;
    fetch("/api/snapshot")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Snapshot | null) => {
        if (!closed && s) setSnapshot((cur) => cur ?? s);
      })
      .catch(() => {});

    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (e) => {
      // 서버는 항상 유효한 JSON을 보내지만, 전송 중 잘림이나 프록시 개입 등으로 메시지가 깨질 수
      // 있다. 파싱에 실패해도 훅이 죽지 않고 이전 스냅샷을 유지한 채 다음 메시지를 계속 받는다.
      try {
        setSnapshot(JSON.parse((e as MessageEvent).data));
        setLive(true);
      } catch {
        // 깨진 메시지는 무시한다.
      }
    });
    es.onerror = () => setLive(false);
    return () => {
      closed = true;
      es.close();
    };
  }, []);

  return { snapshot, live };
}
