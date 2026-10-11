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
  // 종료 확인 창(§6.4)
  terminateTitle: (name: string) => `${name} 층을 끌까요?`,
  forceTitle: (name: string) => `${name} 층이 아직 끝나지 않았습니다`,
  keyFolder: "폴더",
  keyMembers: "구성원",
  members: (n: number, m: number) => `팀원 ${n}명 · 작업 중 ${m}명`,
  terminateBody: "이 세션을 끕니다. 대화 기록은 남지만, 하던 작업은 끊깁니다.",
  currentWarn: "지금 이 대시보드를 켠 세션입니다. 끄면 이 터미널의 Claude Code도 끝납니다.",
  forceBody: "아직 켜져 있습니다. 강제로 끌까요? 저장되지 않은 작업이 사라질 수 있습니다.",
  cancel: "취소",
  terminate: "끄기",
  force: "강제로 끄기",
  sending: "끄는 중…",
  terminateEnded: "이미 끝난 층입니다.",
  terminateUnverified: "이 세션의 프로세스를 확인하지 못해 끄지 않았습니다. 터미널에서 직접 끝내 주세요.",
  terminateFailed: "끄지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.",
  terminateLabel: (name: string) => `${name} 층 종료`,
  sentTerm: (name: string) => `${name} 층에 끄기 신호를 보냈습니다`,
  sentKill: (name: string) => `${name} 층을 강제로 끄는 신호를 보냈습니다`,
  gone: (name: string) => `${name} 층이 꺼졌습니다`,
  // 숨김(§6.5)
  hideLabel: (name: string) => `${name} 층 삭제(목록에서만 숨김)`,
  hideTitle: "대시보드 목록에서만 숨깁니다. 대화 기록은 지우지 않습니다.",
  hiddenBar: (n: number) => `숨긴 층 ${n}개 · 모두 보이기`,
  reloading: "숨긴 층을 다시 불러오는 중…",
  hideAlive: "아직 켜져 있는 층은 숨길 수 없습니다.",
  hideNotFound: "이미 목록에 없는 층입니다.",
  hideFailed: "처리하지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.",
  hidden: (name: string) => `${name} 층을 목록에서 숨겼습니다`,
  unhidden: "숨긴 층을 모두 다시 보이게 했습니다",
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

/**
 * 층마다 화면이 지금 보이는 멈춤 값(기다리는 값 포함). 같은 화면의 말풍선이 칩·셔터와 어긋나지 않게 Floor가 적고
 * ActivityBubble이 읽는다(B129 M1). Floor가 사라지면 지운다
 */
const shownPaused = new Map<string, boolean>();
export const pausedOf = (s: SessionView): boolean => shownPaused.get(s.id) ?? s.floorStatus === "paused";
export function useShownPaused(sessionId: string, paused: boolean): void {
  useEffect(() => {
    shownPaused.set(sessionId, paused);
  }, [sessionId, paused]);
  useEffect(() => () => void shownPaused.delete(sessionId), [sessionId]);
}

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

/** 첫 창에서 [끄기]가 성공한 뒤 둘째 창을 띄우기까지(사용자 결정, 스펙 5.2) */
export const FORCE_AFTER_MS = 10_000;

/**
 * 종료 확인 창 두 단계(디자인 phase4a §3). 창 단계·요청·실패 문구·10초 타이머·"종료 중" 칩 붙잡기(6초)를 든다.
 * 10초가 됐을 때 최신 스냅샷의 alive를 본다(층이 끝났거나 사라졌으면 둘째 창 없음 — Floor가 사라지면 타이머도 함께 사라진다)
 */
export function useFloorTerminate(session: SessionView, announce?: (text: string) => void, blocked = false) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [holdUntil, setHoldUntil] = useState(0);
  const sendingRef = useRef(false);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const alive = session.alive && session.floorStatus !== "ended";
  const aliveRef = useRef(alive);
  aliveRef.current = alive;
  const sentHere = useRef(false);
  /** 10초가 됐는데 다른 대화상자(예산 설정)가 열려 있어 미룬 둘째 창(B131) */
  const [deferred, setDeferred] = useState(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, tick] = useState(0);
  const nameRef = useRef(session.name);
  nameRef.current = session.name;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);
  // 끝나면 타이머를 버리고, 이 화면에서 끈 층이면 "꺼짐"을 알린다(B124 ⑧). 둘째 창이 떠 있으면 실패 줄 자리에 안내(B124 ⑦)
  useEffect(() => {
    if (alive) return;
    clearTimer();
    setHoldUntil(0);
    if (sentHere.current) {
      sentHere.current = false;
      announceRef.current?.(FLOOR_TEXT.gone(nameRef.current));
    }
    if (stageRef.current === 2) setError(FLOOR_TEXT.terminateEnded);
  }, [alive]);
  // 칩 붙잡기 6초 상한(B127)
  useEffect(() => {
    if (!holdUntil) return;
    const t = setTimeout(() => {
      setHoldUntil(0);
      tick((n) => n + 1);
    }, Math.max(0, holdUntil - Date.now()));
    return () => clearTimeout(t);
  }, [holdUntil]);
  useEffect(() => {
    if (session.terminating) setHoldUntil(0); // 스냅샷이 따라왔다
  }, [session.terminating]);

  // 미룬 둘째 창은 다른 대화상자가 닫히면 그때 연다(두 모달이 겹치지 않게)
  useEffect(() => {
    if (!deferred || blocked) return;
    setDeferred(false);
    if (aliveRef.current) setStage(2);
  }, [deferred, blocked]);

  const terminating = alive && (session.terminating === true || Date.now() < holdUntil);

  const open = () => {
    if (!alive) return;
    setError(null);
    setStage(terminating ? 2 : 1);
  };
  const close = () => {
    setStage(0);
    setError(null);
  };
  const confirm = async () => {
    const force = stageRef.current === 2;
    if (sendingRef.current || !aliveRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    const r = await floorsApi.terminate(session.id, force);
    sendingRef.current = false;
    setSending(false);
    if (!r.ok) {
      if (r.unauthorized) return;
      setError(r.error === "ended" ? FLOOR_TEXT.terminateEnded : r.error === "failed" ? FLOOR_TEXT.terminateFailed : FLOOR_TEXT.terminateUnverified);
      return;
    }
    sentHere.current = true;
    setHoldUntil(Date.now() + HOLD_MS);
    announceRef.current?.(force ? FLOOR_TEXT.sentKill(session.name) : FLOOR_TEXT.sentTerm(session.name));
    // 요청 중에 사용자가 창을 닫았으면 그 뜻을 따라 타이머를 시작하지 않는다(B127 ④)
    const stillOpen = stageRef.current !== 0;
    setStage(0);
    if (!force && stillOpen) {
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!aliveRef.current) return;
        if (blockedRef.current) setDeferred(true);
        else setStage(2);
      }, FORCE_AFTER_MS);
    }
  };

  return { stage, sending, error, terminating, open, close, confirm, forceDisabled: stage === 2 && !alive };
}

const hideError = (e: FloorError) => (e === "alive" ? FLOOR_TEXT.hideAlive : e === "not-found" ? FLOOR_TEXT.hideNotFound : FLOOR_TEXT.hideFailed);

/** 끝난 층의 "삭제"(디자인 §4.1). 확인 창 없이 hide. 성공하면 onHidden으로 빌딩에 알린다(빌딩이 바로 빼고 6초 들고 있음) */
export function useFloorHide(session: SessionView, onHidden?: (id: string, hidden: number) => void, announce?: (text: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), ERR_MS);
    return () => clearTimeout(t);
  }, [error]);
  const hide = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const r = await floorsApi.hide(session.id);
    busyRef.current = false;
    setBusy(false);
    if (r.ok) {
      announce?.(FLOOR_TEXT.hidden(session.name));
      onHidden?.(session.id, r.body.hidden);
    } else if (!r.unauthorized) setError(hideError(r.error));
  };
  return { busy, error, hide };
}

/**
 * 빌딩의 숨긴 층(디자인 §4.2·§4.3). 숨긴 id·숨긴 수·"다시 불러오는 중"을 최대 6초 들고 스냅샷이 따라오면 놓는다.
 * 숨긴 세션이 alive로 오면 즉시 다시 보인다(살아 있는 세션은 숨기지 않는다, 스펙 6장)
 */
export function useHiddenFloors(sessions: SessionView[], hiddenFloors: number, announce?: (text: string) => void) {
  const [held, setHeld] = useState<Map<string, number>>(new Map());
  const [heldCount, setHeldCount] = useState<{ n: number; until: number } | null>(null);
  const [reloadingUntil, setReloadingUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const now = Date.now();

  // 놓기: 스냅샷이 뺐거나, 살아났거나, 6초가 지났다
  useEffect(() => {
    if (held.size === 0) return;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    let changed = false;
    const next = new Map(held);
    for (const [id, until] of held) {
      const s = byId.get(id);
      if (!s || s.alive || Date.now() >= until) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setHeld(next);
  }, [sessions, held]);
  useEffect(() => {
    if (heldCount && hiddenFloors === heldCount.n) setHeldCount(null);
  }, [hiddenFloors, heldCount]);
  useEffect(() => {
    if (reloadingUntil && hiddenFloors === 0) setReloadingUntil(0);
  }, [hiddenFloors, reloadingUntil]);
  // 6초 상한(B127): 시간이 되면 다시 그려 스냅샷을 따른다
  const nextEnd = Math.min(...[...held.values(), heldCount?.until ?? Infinity, reloadingUntil || Infinity]);
  useEffect(() => {
    if (!Number.isFinite(nextEnd)) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, nextEnd - Date.now()) + 1);
    return () => clearTimeout(t);
  }, [nextEnd]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), ERR_MS);
    return () => clearTimeout(t);
  }, [error]);

  const visible = sessions.filter((s) => {
    const until = held.get(s.id);
    return until === undefined || s.alive || now >= until;
  });
  const count = heldCount && now < heldCount.until ? heldCount.n : hiddenFloors;
  const reloading = reloadingUntil > now;

  const onHidden = (id: string, n: number) => {
    setHeld((m) => new Map(m).set(id, Date.now() + HOLD_MS));
    setHeldCount({ n, until: Date.now() + HOLD_MS });
  };
  const unhideAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await floorsApi.unhideAll();
    setBusy(false);
    if (r.ok) {
      setHeld(new Map());
      setHeldCount(null);
      setReloadingUntil(Date.now() + HOLD_MS);
      announce?.(FLOOR_TEXT.unhidden);
    } else if (!r.unauthorized) setError(FLOOR_TEXT.hideFailed);
  };
  return { visible, count, reloading, busy, error, onHidden, unhideAll };
}

