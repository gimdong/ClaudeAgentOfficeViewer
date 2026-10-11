import { useEffect, useRef, useState } from "react";
import type { SessionView } from "../../src/shared/types";
import { UNAUTHORIZED_EVENT } from "../useSnapshot";

export type FloorError = "ended" | "alive" | "self" | "pid-reused" | "unverified" | "not-found" | "failed"; // not-found: hide의 404
/** unauthorized: 401(앱이 열쇠 안내 화면으로 간다 — 그 자리에 실패 문구를 두지 않는다) */
export type FloorResult<T> = { ok: true; body: T } | { ok: false; error: FloorError; unauthorized?: true };

/** 디자인 phase4a §6 문구표(qa 검토를 마친 판) */
export const FLOOR_TEXT = {
  on: "영업 중",
  off: "멈춤",
  terminating: "종료 중",
  orderTitle: "아직 사용할 수 없습니다",
  switchEnded: "이미 끝난 층이라 멈추거나 다시 켤 수 없습니다.",
  switchFailed: "바꾸지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.",
  pauseNote: "멈춤: Claude가 다음에 도구를 쓰려 할 때부터 막습니다. 지금 쓰고 있는 답과, 터미널에서 직접 말을 걸었을 때의 대답은 이어집니다. 사용자에게 묻기와 팀원끼리 연락은 막지 않습니다.",
  paused: (name: string) => `${name} 층을 멈췄습니다`,
  resumed: (name: string) => `${name} 층을 다시 영업 중으로 돌렸습니다`,
  blocked: (n: number) => `· 막힌 호출 ${n.toLocaleString("en-US")}`,
} as const;

const KNOWN: ReadonlySet<string> = new Set(["ended", "alive", "self", "pid-reused", "unverified"]);

/** 쓰기 메서드는 /api 미들웨어가 JSON Content-Type을 요구하므로 본문 없는 요청도 {}를 보낸다(Phase 3 B99) */
async function call<T>(method: "POST" | "DELETE", path: string, body: object = {}): Promise<FloorResult<T>> {
  try {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      return { ok: false, error: "failed", unauthorized: true };
    }
    const j = (await r.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (r.ok && j) return { ok: true, body: j };
    if (r.status === 404) return { ok: false, error: "not-found" };
    if ((r.status === 400 || r.status === 409) && typeof j?.error === "string" && KNOWN.has(j.error)) return { ok: false, error: j.error as FloorError };
    return { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

const at = (id: string, action: string) => `/api/floors/${encodeURIComponent(id)}/${action}`;
export const floorsApi = {
  pause: (id: string) => call<{ paused: boolean }>("POST", at(id, "pause")),
  resume: (id: string) => call<{ paused: boolean }>("POST", at(id, "resume")),
  terminate: (id: string, force: boolean) => call<{ signal: string }>("POST", at(id, "terminate"), force ? { force: true } : {}),
  hide: (id: string) => call<{ hidden: number }>("POST", at(id, "hide")),
  unhideAll: () => call<{ hidden: number }>("DELETE", "/api/floors/hidden"),
};

/** 화면이 응답 값을 스냅샷이 따라올 때까지 들고 있는 최대 시간(디자인 §1.2, B117·B127) */
export const HOLD_MS = 6_000;
const ERR_MS = 10_000;

/**
 * 층의 영업/멈춤 스위치(디자인 phase4a §1). 200 응답의 값을 "기다리는 값"으로 들고, 스냅샷이 같아지거나 6초가 지나면 놓는다 —
 * 스냅샷 주기(3초)만큼 스위치·칩·셔터가 거꾸로 튀지 않게. 실패는 누르기 전 상태로 되돌리고 그 층에 한 줄(role=alert, 10초)
 */
export function useFloorSwitch(session: SessionView, announce?: (text: string) => void) {
  const snapPaused = session.floorStatus === "paused";
  const [hold, setHold] = useState<{ paused: boolean; until: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [, tick] = useState(0);

  // 스냅샷이 따라오면 놓는다
  useEffect(() => {
    if (hold && hold.paused === snapPaused) setHold(null);
  }, [hold, snapPaused]);
  // 6초 상한: 시간이 지나면 다시 그려 스냅샷을 따른다
  useEffect(() => {
    if (!hold) return;
    const t = setTimeout(() => {
      setHold(null);
      tick((n) => n + 1);
    }, Math.max(0, hold.until - Date.now()));
    return () => clearTimeout(t);
  }, [hold]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), ERR_MS);
    return () => clearTimeout(t);
  }, [error]);

  const paused = hold && Date.now() < hold.until ? hold.paused : snapPaused;

  const toggle = async () => {
    if (busyRef.current || session.floorStatus === "ended") return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const want = !paused;
    const r = await (want ? floorsApi.pause(session.id) : floorsApi.resume(session.id));
    busyRef.current = false;
    setBusy(false);
    if (r.ok) {
      setHold({ paused: r.body.paused, until: Date.now() + HOLD_MS });
      announce?.(r.body.paused ? FLOOR_TEXT.paused(session.name) : FLOOR_TEXT.resumed(session.name));
      return;
    }
    // 401은 앱 전체가 열쇠 안내 화면으로 간다(UNAUTHORIZED_EVENT). 그 밖은 이 층에 한 줄
    if (r.unauthorized) return;
    if (r.error === "ended") setError(FLOOR_TEXT.switchEnded);
    else setError(FLOOR_TEXT.switchFailed);
  };

  return { paused, busy, error, toggle };
}
