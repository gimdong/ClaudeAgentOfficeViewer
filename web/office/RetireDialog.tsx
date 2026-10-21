import { useId, useLayoutEffect, useRef, type SyntheticEvent } from "react";
import { LEAD_TEXT as T } from "./leadText";

/**
 * 퇴사 확인 창(디자인 phase6b §5). 종료 확인 창과 같은 틀: <dialog>.showModal, Esc = 취소, 열릴 때 포커스는 [취소]
 */
export function RetireDialog(p: { member: string; sending: boolean; error: string | null; onConfirm(): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    cancel.current?.focus();
  }, []);
  const onCancel = (e: SyntheticEvent) => {
    e.preventDefault();
    p.onClose();
  };
  return (
    <dialog ref={ref} className="dlg td" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onCancel={onCancel}>
      <h2 id={`${id}-title`} className="dlg-title">
        {T.retireTitle(p.member)}
      </h2>
      <p id={`${id}-body`} className="td-body">
        {T.retireBody(p.member)}
      </p>
      <p className="dlg-help rt-help">{T.retireHelp}</p>
      {p.error && (
        <p className="dlg-err" role="alert">
          {p.error}
        </p>
      )}
      <div className="dlg-buttons">
        <button ref={cancel} type="button" className="pbtn" onClick={p.onClose}>
          {T.cancel}
        </button>
        {/* disabled는 쓰지 않는다(포커스가 body로 떨어짐). 이중 전송은 부르는 쪽이 막는다 */}
        <button type="button" className="pbtn pbtn--deny" aria-disabled={p.sending || undefined} aria-busy={p.sending || undefined} onClick={() => !p.sending && p.onConfirm()}>
          {p.sending ? T.sending : T.retireGo}
        </button>
      </div>
    </dialog>
  );
}
