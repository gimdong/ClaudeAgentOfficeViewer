import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../pixel/Icon";
import { graphemes } from "../report/text";
import { CMD_TEXT } from "./leadCmdText";
import { channelWhy, LEAD_MAX, LEAD_TEXT as T, type ChatQuestionView, type LeadChannel } from "./leadText";

/**
 * 대화 질문 답 칸(디자인 phase6b §4). ask_user와 "답을 기다립니다"가 같은 모양이고 머리만 다르다.
 * 질문·선택지 글은 모델이 쓴 것이라 글자로만 그리고, 보내는 값은 고른 번호(1부터)와 사용자가 친 글뿐이다(스펙 12장 a)
 */
export function ReplyDialog(p: {
  question: ChatQuestionView;
  channel: LeadChannel;
  sending: boolean;
  error: string | null;
  onSend(answer: { choice?: number; text: string }): void;
  onShowNewer?(): void;
  /** 그 층에 대기 보고서가 있으면 서류철로 가는 버튼(B335 ②) */
  folder?: { pending: number; onOpen(el: HTMLElement): void };
  onClose(): void;
}) {
  const q = p.question;
  const [choice, setChoice] = useState<number | undefined>(undefined);
  const [text, setText] = useState("");
  const quote = useRef<HTMLQuoteElement>(null);
  const base = useId();
  useLayoutEffect(() => {
    quote.current?.focus();
  }, [q.id]);

  const off = channelWhy(p.channel);
  const locked = q.state !== "open";
  const disabled = !!off || locked;
  const n = graphemes(text).length;
  const ready = !disabled && !p.sending && n <= LEAD_MAX && (choice !== undefined || text.trim() !== "");
  const send = () => ready && p.onSend({ ...(choice !== undefined ? { choice } : {}), text });
  const banner =
    q.state === "held" ? { cls: "yellow", text: T.held } : q.state === "answered-terminal" ? { cls: "green", text: T.answeredTerminal } : q.state === "superseded" ? { cls: "yellow", text: T.superseded } : null;
  const awaiting = q.source === "await";

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      p.onClose();
    }
  };
  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return createPortal(
    <aside className={`rp rd${awaiting ? " rd--await" : ""}${off ? " off" : ""}${locked ? " locked" : ""}`} role="dialog" aria-modal="false" aria-labelledby={`${base}-title`} onKeyDown={onKey}>
      <header className="rp-head">
        <div className="rp-headtext">
          <p className="rp-meta">
            <span className={`rp-chip${awaiting ? " rd-chip--await" : ""}`}>{awaiting ? T.chipAwait : T.chipAsk}</span>
          </p>
          <h2 id={`${base}-title`} className="rp-title ap-title">
            {q.owner}
          </h2>
        </div>
        <div className="rp-nav">
          <button type="button" className="icon-btn" aria-label={T.close} onClick={p.onClose}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      {banner && (
        <div className={`rp-banner ${banner.cls}`} role="status">
          <span>{banner.text}</span>
          {q.state === "superseded" && p.onShowNewer && (
            <button type="button" className="pbtn" onClick={p.onShowNewer}>
              {T.showNewer}
            </button>
          )}
        </div>
      )}
      <div className="rp-scroll">
        {p.folder && p.folder.pending > 0 && (
          <button type="button" className="rp-more rd-folder" onClick={(e) => p.folder!.onOpen(e.currentTarget)}>
            {CMD_TEXT.replyFolder(p.folder.pending)}
          </button>
        )}
        {!q.ownerIsLead && <p className="rd-who">{T.memberNote(q.owner)}</p>}
        <blockquote ref={quote} className="rp-quote rd-q" tabIndex={-1} data-testid="rd-question">
          {q.text}
        </blockquote>
        {q.options.length > 0 && (
          <section className="rp-sec" aria-labelledby={`${base}-opts`}>
            <h3 id={`${base}-opts`}>{T.options}</h3>
            <p className="rd-help">{T.optionsHelp}</p>
            <div className="rd-opts">
              {q.options.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  className="pbtn rd-opt"
                  aria-pressed={choice === i + 1}
                  aria-label={T.optionLabel(i + 1, o)}
                  aria-disabled={disabled || undefined}
                  onClick={() => !disabled && setChoice((c) => (c === i + 1 ? undefined : i + 1))}
                >
                  {`${i + 1}. ${o}`}
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="rp-sec rd-free">
          <label htmlFor={`${base}-free`}>
            <span>{T.free}</span>
            <span className={n > LEAD_MAX ? "over" : undefined}>{T.count(n)}</span>
          </label>
          <textarea id={`${base}-free`} value={text} readOnly={disabled} aria-disabled={disabled || undefined} aria-invalid={n > LEAD_MAX || undefined} onChange={(e) => setText(e.target.value)} onKeyDown={onTextKey} />
        </section>
      </div>
      <div className="rf-foot">
        {p.error && (
          <p className="dlg-err rf-err" role="alert">
            {p.error}
          </p>
        )}
        {off && <p className="rd-off">{p.channel === "not-connected" || p.channel === "reconnecting" ? off : T.replyOff}</p>}
        <button type="button" className="pbtn pbtn--primary rf-right" aria-disabled={!ready || undefined} aria-busy={p.sending || undefined} onClick={send}>
          {p.sending ? T.sending : T.send}
        </button>
      </div>
    </aside>,
    document.body,
  );
}
