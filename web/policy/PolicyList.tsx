import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Snapshot } from "../../src/shared/types";
import { DiagIcon } from "../diag/DiagIcon";
import { Icon } from "../pixel/Icon";
import { LIST_TEXT, TEXT, kindLabel, parseNewTarget, summaryOf, targetKeyOf, targetLabel } from "./text";
import type { Policy } from "./usePolicy";

/** 서버 server/policy/store.ts의 MAX_TARGETS와 같다(테스트로 맞춘다) */
export const MAX_TARGETS = 200;
const ko = (a: string, b: string) => a.localeCompare(b, "ko");
/** data-<attr>가 대상 키인 요소(키에 따옴표·대괄호가 있어도 되게 선택자를 만들지 않는다) */
const byData = (root: HTMLElement, attr: string, key: string) =>
  [...root.querySelectorAll<HTMLElement>(`[data-${attr}]`)].find((e) => e.getAttribute(`data-${attr}`) === key) ?? null;

/** 행 순서(§4.2): lead → agent:*(이름순) → sub:*(이름순) → others. lead·others는 규칙이 없어도 늘 있다(B95) */
function rowKeys(saved: string[]): string[] {
  const agents = saved.filter((k) => k.startsWith("agent:")).sort(ko);
  const subs = saved.filter((k) => k.startsWith("sub:")).sort(ko);
  return ["lead", ...agents, ...subs, "others"];
}

/** 정책 목록 서랍(디자인 phase3 §4). 상태는 App의 usePolicy가 든다(서랍 서로 닫기를 한 곳에서) */
export function PolicyList({ policy, snapshot, announce }: { policy: Policy; snapshot: Snapshot; announce(text: string): void }) {
  const isOpen = policy.open?.view === "list";
  const root = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  /** 지우기 실패(또는 지금만 적용됨, B87·B106) 문구와 그 대상 */
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const [adding, setAdding] = useState<"closed" | "open" | "limit">("closed");
  const [kind, setKind] = useState<"agent" | "sub">("agent");
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  /** 다음 렌더 뒤 포커스할 곳: 행의 [고치기]·[지우기]·[취소]("edit"·"del"·"cancel" + 대상 키), [대상 추가]("add"), 이름 입력("name") */
  const focusNext = useRef<{ to: "edit" | "del" | "cancel"; key: string } | "add" | "name" | null>(null);

  const targets = snapshot.policy?.targets ?? {};
  const savedKeys = Object.keys(targets);
  const keys = rowKeys(savedKeys);
  const members = snapshot.sessions.flatMap((s) => s.members);
  const subTypes = new Set(members.flatMap((m) => (m.role === "lead" ? (m.subTypes ?? []) : [])));
  const onScreen = (k: string) =>
    k.startsWith("agent:") ? members.some((m) => m.role !== "lead" && targetKeyOf(m) === k) : k.startsWith("sub:") ? subTypes.has(k.slice(4)) : true;

  // 열 때: 목록에 돌아온 것이면 그 행의 [고치기], 아니면 제목(§7.2). 닫히면 행 안의 상태를 비운다
  useLayoutEffect(() => {
    if (!isOpen) {
      setConfirm(null);
      setFailed(null);
      setAdding("closed");
      setName("");
      setNameErr(null);
      return;
    }
    const back = policy.listReturn.current;
    policy.listReturn.current = null;
    const el = back && root.current ? byData(root.current, "edit", back) : null;
    (el ?? title.current)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useLayoutEffect(() => {
    const f = focusNext.current;
    if (!f || !root.current) return;
    focusNext.current = null;
    if (f === "name") nameInput.current?.focus();
    else ((f === "add" ? null : byData(root.current, f.to, f.key)) ?? root.current.querySelector<HTMLElement>(".pl-add-btn"))?.focus();
  });

  const cancelConfirm = (key: string) => {
    setConfirm(null);
    focusNext.current = { to: "del", key };
  };
  const closeAdd = () => {
    setAdding("closed");
    setNameErr(null);
    focusNext.current = "add";
  };

  // Esc 순서(§7.2): 말풍선 → 지우기 확인 → 대상 추가 칸 → 서랍
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('.say[role="tooltip"]')) return;
      if (confirm && !deleting) return cancelConfirm(confirm);
      if (adding !== "closed") return closeAdd();
      policy.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!isOpen) return null;

  const edit = (key: string) => {
    policy.listReturn.current = key;
    policy.openAgent(key, undefined, { view: "list" });
  };
  const del = async (key: string) => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    const r = await policy.remove(key);
    deletingRef.current = false;
    setDeleting(false);
    setConfirm(null);
    if (r === "not-persisted") {
      // 메모리에서는 지워졌지만 파일에 남았다: 지웠다고 하지 않는다(B106). 행이 사라지면 목록 아래에 남는다
      setFailed({ key, text: TEXT.notPersisted });
      focusNext.current = { to: "edit", key };
    } else if (r === "saved") {
      setFailed(null);
      announce(`${targetLabel(key)} 권한 정책을 지웠습니다`);
      // 포커스는 다음 행 → 이전 행의 [고치기] → [대상 추가](§4.3). lead·others 행은 지워도 남는다
      const i = keys.indexOf(key);
      const fixed = key === "lead" || key === "others";
      const next = fixed ? key : (keys[i + 1] ?? keys[i - 1]);
      focusNext.current = next ? { to: "edit", key: next } : "add";
    } else {
      setFailed({ key, text: LIST_TEXT.deleteFailed });
      focusNext.current = { to: "del", key };
    }
  };
  const openAdd = () => {
    if (savedKeys.length >= MAX_TARGETS) return setAdding("limit");
    setAdding("open");
    focusNext.current = "name";
  };
  const submitAdd = () => {
    const r = parseNewTarget(kind, name);
    if ("error" in r) {
      setNameErr(r.error);
      focusNext.current = "name";
      return;
    }
    edit(r.key);
  };
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitAdd();
    }
  };
  const unreadable = snapshot.policy?.unreadable === true;
  const namedCount = savedKeys.filter((k) => k !== "lead" && k !== "others").length;

  return createPortal(
    <aside ref={root} id="pl-panel" className="rp ap pl" role="dialog" aria-modal="false" aria-labelledby="pl-title">
      <header className="dp-head">
        <Icon name="lock" accent="#0e0d18" />
        <h2 ref={title} id="pl-title" className="dp-title" tabIndex={-1}>
          {LIST_TEXT.title}
        </h2>
        <button type="button" className="icon-btn pl-close" aria-label="닫기" onClick={() => policy.close()}>
          <Icon name="close" />
        </button>
      </header>
      {unreadable && (
        <div className="pl-unread">
          <DiagIcon name="fail" />
          <p className="h">{LIST_TEXT.unreadHead}</p>
          <p className="b">{LIST_TEXT.unreadBody}</p>
        </div>
      )}
      <p className={`pl-limit${unreadable ? " after-warn" : ""}`}>{LIST_TEXT.limitLine}</p>
      <div className="dp-scroll pl-scroll">
        <ul className="pl-rows">
          {keys.map((k) => {
            const label = targetLabel(k);
            const rules = targets[k];
            const fixed = k === "lead" || k === "others";
            const asking = confirm === k;
            return (
              <li key={k} className={`pl-row${asking ? " confirm" : ""}`}>
                <p className="pl-name">
                  <span className="pl-label">{label}</span>
                  {!fixed && <span className="rp-chip ap-chip">{kindLabel(k)}</span>}
                  {!onScreen(k) && <span className="pl-gone">{LIST_TEXT.notNow}</span>}
                </p>
                <p className="pl-sum">{asking ? (fixed ? LIST_TEXT.confirmFixed : LIST_TEXT.confirmNamed) : summaryOf(rules ?? {})}</p>
                <div className="pl-act">
                  {asking ? (
                    <>
                      {/* disabled는 포커스를 body로 떨어뜨린다(d09c91d §4.3). 이중 전송은 deletingRef가 막는다 */}
                      <button type="button" className="pbtn" data-cancel={k} aria-disabled={deleting || undefined} onClick={() => !deleting && cancelConfirm(k)}>
                        {LIST_TEXT.cancel}
                      </button>
                      <button type="button" className="pbtn pbtn--deny" aria-disabled={deleting || undefined} aria-busy={deleting || undefined} onClick={() => void del(k)}>
                        {deleting ? LIST_TEXT.deleting : LIST_TEXT.del}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="pbtn" data-edit={k} aria-label={`${label} 정책 고치기`} onClick={() => edit(k)}>
                        {LIST_TEXT.edit}
                      </button>
                      {rules && (
                        <button
                          type="button"
                          className="pbtn pbtn--danger"
                          data-del={k}
                          aria-label={`${label} 정책 지우기`}
                          onClick={() => {
                            setFailed(null);
                            setConfirm(k);
                            focusNext.current = { to: "cancel", key: k };
                          }}
                        >
                          <Icon name="trash" />
                          {LIST_TEXT.del}
                        </button>
                      )}
                    </>
                  )}
                </div>
                {failed?.key === k && (
                  <p className="pl-err" role="alert">
                    {failed.text}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {failed && !keys.includes(failed.key) && (
          <p className="pl-err pl-err--list" role="alert">
            {failed.text}
          </p>
        )}
        {namedCount === 0 && <p className="pl-empty">{LIST_TEXT.empty}</p>}
        {adding === "open" ? (
          <div className="pl-add">
            <fieldset className="pl-kind">
              <legend>{LIST_TEXT.kind}</legend>
              {(["agent", "sub"] as const).map((v) => (
                <label key={v} className="pr-opt">
                  <input type="radio" name="pl-kind" value={v} checked={kind === v} onChange={() => setKind(v)} />
                  <span className="pr-mark" aria-hidden="true" />
                  {v === "agent" ? LIST_TEXT.kindAgent : LIST_TEXT.kindSub}
                </label>
              ))}
            </fieldset>
            <label className="pl-namelabel" htmlFor="pl-name">
              {kind === "agent" ? LIST_TEXT.nameAgent : LIST_TEXT.nameSub}
            </label>
            <div className="dlg-input">
              <input
                ref={nameInput}
                id="pl-name"
                type="text"
                autoComplete="off"
                placeholder={kind === "agent" ? LIST_TEXT.phAgent : LIST_TEXT.phSub}
                value={name}
                aria-invalid={nameErr ? true : undefined}
                aria-describedby={nameErr ? "pl-name-err pl-name-help" : "pl-name-help"}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameErr(null);
                }}
                onKeyDown={onNameKey}
              />
            </div>
            <p id="pl-name-help" className="ap-help">{kind === "agent" ? LIST_TEXT.helpAgent : LIST_TEXT.helpSub}</p>
            {nameErr && (
              <p id="pl-name-err" className="pl-name-err">
                {nameErr}
              </p>
            )}
            <div className="pl-add-act">
              <button type="button" className="pbtn" onClick={closeAdd}>
                {LIST_TEXT.cancel}
              </button>
              <button type="button" className="pbtn pbtn--primary" onClick={submitAdd}>
                {LIST_TEXT.open}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="pbtn pl-add-btn" aria-expanded={false} onClick={openAdd}>
              <Icon name="plus" />
              {LIST_TEXT.add}
            </button>
            {adding === "limit" && <p className="pl-limit-note">{TEXT.limit}</p>}
          </>
        )}
      </div>
    </aside>,
    document.body,
  );
}
