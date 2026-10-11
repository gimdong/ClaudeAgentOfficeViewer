import { useEffect, useId, useLayoutEffect, useRef, type SyntheticEvent } from "react";
import type { SessionView } from "../../src/shared/types";
import { FLOOR_TEXT } from "./useFloors";

/** 화면에 보이는 폴더는 홈을 ~로 줄인다(디자인 §3.2) */
const tilde = (cwd: string) => cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

/**
 * 종료 확인 창(디자인 phase4a §3). <dialog>.showModal, Esc = 취소, 열릴 때 포커스는 [취소](위험 동작).
 * 단계·요청·타이머는 useFloorTerminate가 든다. 이 창은 그리기만 한다
 */
export function TerminateDialog(p: { session: SessionView; stage: 1 | 2; sending: boolean; error: string | null; forceDisabled: boolean; onConfirm(): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useLayoutEffect(() => {
    cancel.current?.focus();
  }, [p.stage]);
  const onCancel = (e: SyntheticEvent) => {
    e.preventDefault();
    p.onClose();
  };
  const s = p.session;
  const busy = p.sending || p.forceDisabled;
  return (
    <dialog ref={ref} className="dlg td" aria-labelledby={`${id}-title`} onCancel={onCancel}>
      <h2 id={`${id}-title`} className="dlg-title">
        {p.stage === 1 ? FLOOR_TEXT.terminateTitle(s.name) : FLOOR_TEXT.forceTitle(s.name)}
      </h2>
      {p.stage === 1 ? (
        <>
          <dl className="td-kv">
            <dt>{FLOOR_TEXT.keyFolder}</dt>
            <dd className="td-cwd">{tilde(s.cwd)}</dd>
            <dt>{FLOOR_TEXT.keyMembers}</dt>
            <dd>{FLOOR_TEXT.members(s.members.length, s.members.filter((m) => m.state === "working").length)}</dd>
          </dl>
          <p className="td-body">{FLOOR_TEXT.terminateBody}</p>
          {s.isCurrent && <p className="td-warn">{`★ ${FLOOR_TEXT.currentWarn}`}</p>}
        </>
      ) : (
        <p className="td-body">{FLOOR_TEXT.forceBody}</p>
      )}
      {p.error && (
        <p className="dlg-err" role="alert">
          {p.error}
        </p>
      )}
      <div className="dlg-buttons">
        <button ref={cancel} type="button" className="pbtn" onClick={p.onClose}>
          {FLOOR_TEXT.cancel}
        </button>
        {/* disabled는 쓰지 않는다(포커스가 body로 떨어짐). 이중 전송은 훅의 ref가 막는다 */}
        <button type="button" className="pbtn pbtn--deny" aria-disabled={busy || undefined} aria-busy={p.sending || undefined} onClick={() => !busy && p.onConfirm()}>
          {p.sending ? FLOOR_TEXT.sending : p.stage === 1 ? FLOOR_TEXT.terminate : FLOOR_TEXT.force}
        </button>
      </div>
    </dialog>
  );
}
