import { createContext, useCallback, useRef, useState } from "react";
import type { PolicyRules, Snapshot } from "../../src/shared/types";
import { UNAUTHORIZED_EVENT } from "../useSnapshot";

export type SaveResult = "saved" | "not-persisted" | "limit" | "invalid" | "failed";
type Back = { view: "agent"; target: string } | { view: "list" };
/** back은 ‹ 로 돌아갈 곳(디자인 §1.2): 리드 패널에서 서브에이전트·그 밖의 모든으로 옮겼거나, 목록의 [고치기]·[대상 추가]로 열었을 때만 있다 */
export type PolicyOpen = { view: "agent"; target: string; back?: Back } | { view: "list" } | null;

/** 책상 → 에이전트 패널 열기(Building·Floor를 거치지 않고 Desk가 쓴다). 없으면 책상은 v1처럼 div다 */
export const OpenPolicyContext = createContext<((target: string, opener?: HTMLElement | null) => void) | null>(null);

async function request(method: "PUT" | "DELETE", target: string, body: object): Promise<SaveResult> {
  try {
    // 쓰기 메서드는 /api 미들웨어가 JSON Content-Type을 요구한다(DELETE도 본문 {})
    const r = await fetch(`/api/policy/targets/${encodeURIComponent(target)}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const j = (await r.json().catch(() => null)) as { saved?: unknown; reason?: unknown } | null;
    if (r.ok) return j?.saved === false ? "not-persisted" : "saved";
    if (r.status === 400) return j?.reason === "limit" ? "limit" : "invalid";
    return "failed";
  } catch {
    return "failed";
  }
}

/**
 * 에이전트 패널·정책 목록 서랍의 상태(디자인 phase3 §1·§7). 화면 데이터는 스냅샷만 쓴다(Ruling B77) —
 * 저장 뒤에 따로 상태를 들지 않는다. 연 요소를 기억해 닫을 때 포커스를 돌려준다
 */
export function usePolicy(_snapshot: Snapshot | null) {
  const [open, setOpen] = useState<PolicyOpen>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** 목록의 [고치기]로 연 대상. ‹로 목록에 돌아오면 그 행의 [고치기]에 포커스를 둔다(§7.2) */
  const listReturn = useRef<string | null>(null);

  const openAgent = useCallback((target: string, el?: HTMLElement | null, back?: Back) => {
    if (el !== undefined) opener.current = el;
    setOpen({ view: "agent", target, ...(back ? { back } : {}) });
  }, []);

  const openList = useCallback((el?: HTMLElement | null) => {
    if (el !== undefined) opener.current = el;
    setOpen({ view: "list" });
  }, []);

  const goBack = useCallback(() => {
    setOpen((o) => (o?.view === "agent" && o.back ? (o.back.view === "list" ? { view: "list" } : { view: "agent", target: o.back.target }) : o));
  }, []);

  /** 닫는다. restoreFocus면 연 요소 → 그 대상의 책상 → HUD "권한 정책" 버튼 순서(디자인 §7.2) */
  const close = useCallback(
    (restoreFocus = true) => {
      const target = open?.view === "agent" ? open.target : null;
      setOpen(null);
      if (!restoreFocus) return;
      const desk = target ? [...document.querySelectorAll<HTMLElement>("[data-policy-key]")].find((e) => e.dataset.policyKey === target) : undefined;
      const back = (opener.current?.isConnected ? opener.current : null) ?? desk ?? document.querySelector<HTMLElement>(".policy-chip");
      back?.focus();
    },
    [open],
  );

  const save = useCallback((target: string, rules: PolicyRules) => request("PUT", target, { rules }), []);
  const remove = useCallback((target: string) => request("DELETE", target, {}), []);

  return { open, openAgent, goBack, openList, close, save, remove, listReturn };
}

export type Policy = ReturnType<typeof usePolicy>;
