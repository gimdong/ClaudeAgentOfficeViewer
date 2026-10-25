import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../pixel/Icon";
import { graphemes } from "../report/text";
import { channelWhy, LEAD_MAX, LEAD_TEXT as T, shortTime, type FolderView, type LeadChannel, type ReportView } from "./leadText";

/**
 * 휴업 중 보관된 결재(스펙 12장 l): 서버는 state "held"로 낸다. 무엇을 보관했는지(held: approve·revise)가 오면 그 줄을,
 * 없으면 공통 줄을 쓴다. 보관이 아니면 null
 */
const heldOf = (r: ReportView): "approve" | "revise" | "any" | null => (r.state === "held" ? (r.held ?? "any") : null);
const stampClass = (r: ReportView) => (heldOf(r) ? "held" : r.state === "approved" || r.state === "started" ? "ok" : r.state === "revise" ? "rev" : "wait");
const stampText = (r: ReportView) => (r.state === "held" ? T.stampHeld : r.kind === "handover" && r.state === "pending" ? T.stampHandoverPending : T.stamp[r.state]);
const titleOf = (r: ReportView) => (r.kind === "handover" ? T.handoverTitle(r.member ?? r.from) : r.title?.trim() || T.untitled);
const subOf = (r: ReportView) => (r.kind === "handover" ? T.kindHandover(r.member ?? r.from, shortTime(r.at)) : T.kindReport(shortTime(r.at)));

function Stamp({ r }: { r: ReportView }) {
  return <span className={`rf-stamp ${stampClass(r)}`}>{stampText(r)}</span>;
}

function Row({ r, onOpen }: { r: ReportView; onOpen(id: string, el: HTMLElement): void }) {
  return (
    <li>
      <button type="button" className="rf-row" data-report={r.id} aria-label={`${titleOf(r)}, ${stampText(r)}, ${subOf(r)}`} onClick={(e) => onOpen(r.id, e.currentTarget)}>
        <Stamp r={r} />
        <span className="rf-title">{titleOf(r)}</span>
        <span className="rf-sub">{subOf(r)}</span>
      </button>
    </li>
  );
}

/**
 * 서류철 서랍(디자인 phase6b §3). 목록 → 종이 본문 → 결재. 보고서 글은 React 글자로만 그린다(HTML·마크다운 해석 없음).
 * 보내기는 부르는 쪽이 하고, 결과는 folder의 state 변화로 돌아온다
 */
export function ReportFolder(p: {
  floorName: string;
  folder: FolderView;
  channel: LeadChannel;
  sending: boolean;
  error: string | null;
  onApprove(id: string): void;
  onRevise(id: string, text: string): void;
  onRehire(id: string): void;
  onClose(): void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [revise, setRevise] = useState(false);
  const [text, setText] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  const reviseBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<string | null>(null);
  const why = useId();
  const all = [...p.folder.reports, ...p.folder.archived];
  const open = openId ? all.find((r) => r.id === openId) : undefined;
  const pending = all.filter((r) => r.state === "pending").length;
  // 보고서가 있는 서류철에서 not-launched면 다시 켠 뒤 끊긴 것(B335 ④)
  const off = p.channel === "not-launched" ? T.notLaunchedRestart : channelWhy(p.channel);

  useLayoutEffect(() => {
    title.current?.focus();
  }, [openId]);
  // 결재가 끝나면(상태가 대기에서 바뀜) 수정 사항 칸을 닫는다
  useEffect(() => {
    if (open && open.state !== "pending") {
      setRevise(false);
      setText("");
    }
  }, [open?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => {
    const id = opener.current;
    setOpenId(null);
    setRevise(false);
    setText("");
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.rf-row[data-report="${id}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (revise) {
      setRevise(false);
      reviseBtn.current?.focus();
    } else p.onClose();
  };
  const n = graphemes(text).length;
  const canSend = !off && !p.sending && text.trim() !== "" && n <= LEAD_MAX;

  const foot = (r: ReportView) => {
    if (r.kind === "handover") {
      if (r.state === "started") return <p className="rf-done">{T.rehiredAt(shortTime(r.decidedAt ?? r.at))}</p>;
      return (
        <>
          <p className="rf-help" id={off ? why : undefined}>
            {off ?? T.rehireHelp}
          </p>
          <button type="button" className="pbtn pbtn--primary rf-right" aria-disabled={!!off || p.sending || undefined} aria-describedby={off ? why : undefined} onClick={() => !off && !p.sending && p.onRehire(r.id)}>
            <Icon name="plus" />
            {p.sending ? T.sending : T.rehire}
          </button>
        </>
      );
    }
    if (r.state === "approved") return <p className="rf-done">{T.approvedAt(shortTime(r.decidedAt ?? r.at))}</p>;
    if (r.state === "revise") return <p className="rf-done">{T.revisedAt(shortTime(r.decidedAt ?? r.at))}</p>;
    if (revise)
      return (
        <>
          <div className="rf-revise">
            <label htmlFor={`${why}-t`}>
              <span>{T.reviseLabel}</span>
              <span className={n > LEAD_MAX ? "over" : undefined}>{T.count(n)}</span>
            </label>
            <textarea id={`${why}-t`} value={text} autoFocus aria-invalid={n > LEAD_MAX || undefined} onChange={(e) => setText(e.target.value)} />
          </div>
          <button type="button" className="pbtn" onClick={() => (setRevise(false), setText(""), requestAnimationFrame(() => reviseBtn.current?.focus()))}>
            {T.cancel}
          </button>
          <button type="button" className="pbtn pbtn--deny rf-right" aria-disabled={!canSend || undefined} aria-busy={p.sending || undefined} onClick={() => canSend && p.onRevise(r.id, text)}>
            {p.sending ? T.sending : T.reviseSend}
          </button>
        </>
      );
    const held = heldOf(r);
    return (
      <>
        {off && (
          <p className="rf-help" id={why}>
            {off}
          </p>
        )}
        {held && !off && <p className="rf-help rf-held">{held === "any" ? T.heldLineAny : T.heldLine[held]}</p>}
        <button ref={reviseBtn} type="button" className="pbtn" aria-disabled={!!off || undefined} aria-describedby={off ? why : undefined} onClick={() => !off && setRevise(true)}>
          {T.reviseOpen}
        </button>
        <button type="button" className="pbtn pbtn--primary rf-right" aria-disabled={!!off || p.sending || undefined} aria-busy={p.sending || undefined} aria-describedby={off ? why : undefined} onClick={() => !off && !p.sending && p.onApprove(r.id)}>
          {p.sending ? T.sending : T.approve}
        </button>
      </>
    );
  };

  const onOpen = (id: string) => {
    opener.current = id;
    setOpenId(id);
  };

  return createPortal(
    <aside className="rp rf" role="dialog" aria-modal="false" aria-labelledby="rf-title" onKeyDown={onKey}>
      <header className="rp-head">
        <div className="rp-headtext">
          <p className="rp-meta ap-meta">
            <span className="rp-chip rf-chip">{T.folderChip}</span>
          </p>
          <h2 ref={title} id="rf-title" className="rp-title ap-title" tabIndex={-1}>
            {p.floorName}
          </h2>
          <p className="ap-scope">{T.folderSub(pending, all.length)}</p>
        </div>
        <div className="rp-nav">
          {open && (
            <button type="button" className="icon-btn" aria-label={T.back} onClick={back}>
              <Icon name="prev" />
            </button>
          )}
          <button type="button" className="icon-btn" aria-label={T.close} onClick={p.onClose}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      {open ? (
        <>
          <div className="rp-scroll">
            <p className="rp-meta">
              <Stamp r={open} />
            </p>
            <h3 className="rf-heading">{titleOf(open)}</h3>
            <p className="rf-meta">{`${open.from} · ${shortTime(open.at)}`}</p>
            <div className={`rf-paper${T.seal[open.state] ? " sealed" : ""}`} tabIndex={0} data-testid="rf-paper">
              {T.seal[open.state] && (
                <span className={`rf-seal ${stampClass(open)}`} aria-hidden="true">
                  {T.seal[open.state]}
                </span>
              )}
              {open.body}
            </div>
          </div>
          <div className="rf-foot">
            {p.error && (
              <p className="dlg-err rf-err" role="alert">
                {p.error}
              </p>
            )}
            {foot(open)}
          </div>
        </>
      ) : (
        <div className="rp-scroll">
          {all.length === 0 ? (
            <p className="rp-empty rf-empty">{T.empty}</p>
          ) : (
            <ul className="rf-list">
              {p.folder.reports.map((r) => (
                <Row key={r.id} r={r} onOpen={onOpen} />
              ))}
            </ul>
          )}
          {p.folder.archived.length > 0 && (
            <details className="rf-archive">
              <summary>{T.archive(p.folder.archived.length)}</summary>
              <p className="rf-archive-note">{T.archiveNote}</p>
              <ul className="rf-list">
                {p.folder.archived.map((r) => (
                  <Row key={r.id} r={r} onOpen={onOpen} />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </aside>,
    document.body,
  );
}
