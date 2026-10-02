import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DecisionAnswer, DecisionState, DecisionView, Snapshot } from "../../src/shared/types";
import { floorDomId } from "../building/Floor";
import { UNAUTHORIZED_EVENT } from "../useSnapshot";

export type SendState =
  | { state: "idle" | "sending" }
  | { state: "sent"; outcome: string }
  | { state: "failed" }
  | { state: "conflict"; conflictState?: DecisionState };

/** 책상 → 보고서 열기(Building·Floor를 거치지 않고 Desk가 쓴다). 없으면 책상은 아무것도 열지 않는다 */
export const OpenDecisionContext = createContext<((id: string, opener?: HTMLElement | null) => void) | null>(null);

const byCreated = (a: DecisionView, b: DecisionView) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

/**
 * 결정 보고서의 상태(디자인 phase2 §1·§3·§4). 목록은 snapshot.decisions 전체라 화면 구성원과 짝이 없는 결정도 연다.
 * 순번 N은 모든 층의 대기 중 결정 수이고, 오래 기다린 것부터 센다.
 */
export function useDecisions(snapshot: Snapshot | null) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>({ state: "idle" });
  const opener = useRef<HTMLElement | null>(null);
  const lastView = useRef<DecisionView | null>(null);
  const lastAnswer = useRef<DecisionAnswer | null>(null);
  /** 지금 열린 결정. 응답이 늦게 와도 다른 결정에 붙지 않게 send가 확인한다(Task 8 리뷰) */
  const openRef = useRef<string | null>(null);
  openRef.current = openId;

  const all = snapshot?.decisions ?? [];
  const pending = useMemo(() => all.filter((v) => v.state === "pending").sort(byCreated), [all]);
  const current = openId ? (all.find((v) => v.id === openId) ?? null) : null;
  if (current) lastView.current = current;
  // 열어 둔 결정이 목록에서 아예 사라졌다(서버 재시작 등, Ruling B47)
  const vanished = openId !== null && current === null;
  const view = current ?? (openId ? lastView.current : null);
  const index = view ? pending.findIndex((v) => v.id === view.id) : -1;

  const open = useCallback((id: string, el?: HTMLElement | null) => {
    if (el !== undefined) opener.current = el;
    openRef.current = id;
    setOpenId(id);
    setSendState({ state: "idle" });
    lastAnswer.current = null;
  }, []);

  const openOldest = useCallback(
    (el?: HTMLElement | null) => {
      if (pending[0]) open(pending[0].id, el);
    },
    [pending, open],
  );

  /** 닫는다. restoreFocus면 연 요소 → HUD 결정 칩 → 그 층의 접기 버튼 순서로 포커스를 되돌린다(§4) */
  const close = useCallback(
    (restoreFocus = true) => {
      const sessionId = view?.sessionId;
      openRef.current = null;
      setOpenId(null);
      setSendState({ state: "idle" });
      if (!restoreFocus) return;
      const back =
        (opener.current?.isConnected ? opener.current : null) ??
        document.querySelector<HTMLElement>(".q-chip") ??
        (sessionId ? document.getElementById(floorDomId(sessionId))?.querySelector<HTMLElement>(".fold") : null);
      back?.focus();
    },
    [view?.sessionId],
  );

  const prev = useCallback(() => {
    if (index > 0) open(pending[index - 1].id);
  }, [index, pending, open]);
  const next = useCallback(() => {
    const target = index < 0 ? pending[0] : pending[index + 1];
    if (target) open(target.id);
  }, [index, pending, open]);

  const send = useCallback(
    (a: DecisionAnswer) => {
      if (!view) return;
      const id = view.id;
      lastAnswer.current = a;
      setSendState({ state: "sending" });
      // 보내는 동안 다른 결정을 열었으면 그 결정의 상태를 바꾸지 않는다
      const still = () => openRef.current === id;
      fetch(`/api/decisions/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) })
        .then(async (r) => {
          if (r.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
          if (!still()) return;
          if (r.ok) return setSendState({ state: "sent", outcome: a.action });
          if (r.status === 409) {
            const body = (await r.json().catch(() => null)) as { state?: DecisionState } | null;
            if (still()) setSendState({ state: "conflict", conflictState: body?.state });
            return;
          }
          setSendState({ state: "failed" });
        })
        .catch(() => {
          if (still()) setSendState({ state: "failed" });
        });
    },
    [view],
  );

  const retry = useCallback(() => {
    if (lastAnswer.current) send(lastAnswer.current);
  }, [send]);

  // 보고서를 연 채 다른 결정으로 바뀌면 보내기 상태를 지운다
  useEffect(() => {
    setSendState({ state: "idle" });
  }, [openId]);

  return { openId, open, openOldest, close, current, view, vanished, index, total: pending.length, pending, prev, next, send, retry, sendState };
}

export type Decisions = ReturnType<typeof useDecisions>;
