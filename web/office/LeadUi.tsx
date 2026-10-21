import { createContext, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatQuestionView, FolderView, LeadChannel, Member, SessionView, Snapshot } from "../../src/shared/types";
import { CH_TEXT, chApi } from "../floors/ChannelDialogs";
import { Icon } from "../pixel/Icon";
import { CMD_TEXT as C } from "./leadCmdText";
import { channelWhy } from "./leadText";
import { ReplyDialog } from "./ReplyDialog";
import { ReportFolder } from "./ReportFolder";
import { RetireDialog } from "./RetireDialog";

/** 지시 통로 상태(designer SPEC §1.2): 대시보드가 띄우지 않은 층 → not-launched, 연결 없음 → not-connected */
export function channelOf(s: Pick<SessionView, "channel">): LeadChannel {
  return !s.channel ? "not-launched" : s.channel.connected ? "ok" : "not-connected";
}
const failText = (e: string) => (e === "not-connected" ? CH_TEXT.notConnected : CH_TEXT.failed);

/** 열 수 있는 것(서랍은 한 번에 하나, designer SPEC §3·§4·§5) */
export type LeadOpen = { kind: "folder"; floor: string } | { kind: "reply"; floor: string; member: string; qid: string } | { kind: "retire"; floor: string; member: string } | null;
export interface LeadOpener {
  openFolder(floor: string, el?: HTMLElement | null): void;
  openReply(floor: string, member: string, qid: string, el?: HTMLElement | null): void;
  openRetire(floor: string, member: string, el?: HTMLElement | null): void;
}
/** 책상·지시 절 → 서류철·답 칸·퇴사 창. 없으면 책상은 기존처럼 결정 보고서·에이전트 패널만 연다 */
export const OpenLeadContext = createContext<LeadOpener | null>(null);

export function useLead() {
  const [open, setOpen] = useState<LeadOpen>(null);
  const opener = useRef<HTMLElement | null>(null);
  const remember = (el?: HTMLElement | null) => {
    if (el !== undefined) opener.current = el;
  };
  const api: LeadOpener = {
    openFolder: useCallback((floor, el) => (remember(el), setOpen({ kind: "folder", floor })), []),
    openReply: useCallback((floor, member, qid, el) => (remember(el), setOpen({ kind: "reply", floor, member, qid })), []),
    openRetire: useCallback((floor, member, el) => (remember(el), setOpen({ kind: "retire", floor, member })), []),
  };
  const close = useCallback((restoreFocus = true) => {
    setOpen(null);
    if (restoreFocus && opener.current?.isConnected) opener.current.focus();
  }, []);
  return { open, api, close };
}

/**
 * 에이전트 패널 맨 위 "지시" 절(designer SPEC §1). 이 층의 리드·팀원일 때만 그린다(서브에이전트·그 밖의 모든은 없음).
 * 비활성은 aria-disabled + 이유 줄. 휴업은 누르면 보관(서버가 정함)
 */
export function LeadCommands({ session, member, announce, lead }: { session: SessionView; member: Member; announce(text: string): void; lead: LeadOpener }) {
  const channel = channelOf(session);
  const why = channelWhy(channel);
  const paused = session.floorStatus === "paused";
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const whyId = useId();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = async (kind: string, extra: object = {}) => {
    if (why || busy) return;
    setBusy(kind);
    const r = await chApi.lead(session.id, { kind, ...extra });
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: failText(r.error) });
    const text = r.body.state === "held" ? C.held : C.sent;
    setMsg({ ok: true, text });
    announce(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 5000);
  };
  const off = !!why;
  const btn = (key: string, label: string, onClick: (el: HTMLElement) => void, o: { icon?: "send" | "folder" | "door" | "play"; danger?: boolean; disabled?: boolean } = {}) => {
    const disabled = o.disabled || (off && key !== "folder");
    return (
      <button
        key={key}
        type="button"
        className={`pbtn${o.danger ? " pbtn--danger" : ""}`}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled && why ? whyId : undefined}
        aria-busy={busy === key || undefined}
        onClick={(e) => !disabled && onClick(e.currentTarget)}
      >
        {o.icon && <Icon name={o.icon} />}
        {busy === key ? C.sending : label}
      </button>
    );
  };
  const isLead = member.role === "lead";
  const pending = session.folder?.pending ?? 0;
  const buttons = isLead
    ? [btn("report", C.report, () => void send("report"), { icon: "send" }), btn("folder", pending ? C.folderPending(pending) : C.folder, (el) => lead.openFolder(session.id, el), { icon: "folder" })]
    : member.retiring
      ? [btn("retiring", C.retiring, () => {}, { disabled: true })]
      : [
          member.duty === "off"
            ? btn("onduty", C.onduty, () => void send("onduty", { member: member.name }), { icon: "play" })
            : member.duty === "requested"
              ? btn("offRequested", C.offRequested, () => {}, { disabled: true })
              : btn("offduty", C.offduty, () => void send("offduty", { member: member.name }), { icon: "door" }),
          btn("retire", C.retire, (el) => lead.openRetire(session.id, member.name, el), { danger: true }),
        ];
  return (
    <section className="rp-sec ap-cmd" aria-labelledby={`${whyId}-h`}>
      <h3 id={`${whyId}-h`}>{C.title}</h3>
      <div className="ap-cmd-row">{buttons}</div>
      {why ? (
        <p id={whyId} className="ap-cmd-why">
          {why}
        </p>
      ) : (
        paused && <p className="ap-cmd-why">{CH_TEXT.instructPaused}</p>
      )}
      {msg && (msg.ok ? <p className="ap-cmd-ok">{msg.text}</p> : <p className="ap-cmd-why ap-cmd-err" role="alert">{msg.text}</p>)}
      {isLead && session.folder?.overdue && <p className="ap-cmd-late">{C.overdue}</p>}
    </section>
  );
}

/** 열린 서류철·답 칸·퇴사 창(App이 그린다). 데이터는 스냅샷(질문·층)과 서류철 API */
export function LeadDrawers({ lead, snapshot, announce }: { lead: ReturnType<typeof useLead>; snapshot: Snapshot; announce(text: string): void }) {
  const o = lead.open;
  const session = o ? snapshot.sessions.find((s) => s.id === o.floor) : undefined;
  const [folder, setFolder] = useState<FolderView | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 지나간 질문(같은 책상에 새 질문)·터미널에서 먼저 답함을 알리려고 연 질문을 기억한다(§4.3)
  const [seen, setSeen] = useState<ChatQuestionView | null>(null);
  const folderFloor = o?.kind === "folder" ? o.floor : null;
  const counts = session?.folder;
  useEffect(() => {
    if (!folderFloor) return setFolder(null);
    let live = true;
    void chApi.reports(folderFloor).then((r) => live && setFolder(r.ok ? r.body : { reports: [], archived: [] }));
    return () => {
      live = false;
    };
  }, [folderFloor, counts?.pending, counts?.total]);
  useEffect(() => {
    setError(null);
    setSending(false);
    setSeen(null);
  }, [o?.kind, o?.floor, o && "qid" in o ? o.qid : undefined]);
  const asked = o?.kind === "reply" ? session?.members.find((m) => m.name === o.member)?.awaitingReply : undefined;
  const qid = o?.kind === "reply" ? o.qid : undefined;
  useEffect(() => {
    if (asked && asked.id === qid) setSeen(asked);
  }, [asked, qid]);
  if (!o || !session) return null;
  const channel = channelOf(session);

  const act = async (body: object, ok: string, after?: () => void) => {
    setSending(true);
    setError(null);
    const r = await chApi.lead(session.id, body);
    setSending(false);
    if (!r.ok) return setError(failText(r.error));
    announce(r.body.state === "held" && (body as { kind?: string }).kind === "reply" ? C.announce.replyHeld : ok);
    after?.();
  };

  if (o.kind === "folder") {
    if (!folder) return null;
    const refetch = () => void chApi.reports(session.id).then((r) => r.ok && setFolder(r.body));
    return (
      <ReportFolder
        floorName={session.name}
        folder={folder}
        channel={channel}
        sending={sending}
        error={error}
        onApprove={(id) => void act({ kind: "approve", reportId: id }, C.announce.approve, refetch)}
        onRevise={(id, text) => void act({ kind: "revise", reportId: id, text }, C.announce.revise, refetch)}
        onRehire={(id) => {
          const h = folder.reports.concat(folder.archived).find((r) => r.id === id);
          if (h?.member) void act({ kind: "rehire", member: h.member, handoverId: id }, C.sent, refetch);
        }}
        onClose={() => lead.close()}
      />
    );
  }
  if (o.kind === "retire") {
    return <RetireDialog member={o.member} sending={sending} error={error} onConfirm={() => void act({ kind: "retire", member: o.member }, C.announce.retire, () => lead.close())} onClose={() => lead.close()} />;
  }
  // 답 칸: 지금 그 책상의 질문. 같은 id면 그것, 다른 id면 지나간 것, 없으면 터미널에서 답함(§4.3)
  const current = asked;
  const base = current?.id === o.qid ? current : seen?.id === o.qid ? seen : null;
  if (!base) return null;
  const question: ChatQuestionView = current?.id === o.qid ? current : { ...base, state: current ? "superseded" : "answered-terminal" };
  const member = !question.ownerIsLead && question.owner !== "team-lead" ? question.owner : undefined;
  return (
    <ReplyDialog
      question={question}
      channel={channel}
      sending={sending}
      error={error}
      onSend={(a) => void act({ kind: "reply", questionId: question.id, ...(member ? { member } : {}), ...(a.choice !== undefined ? { choice: a.choice } : {}), ...(a.text.trim() ? { text: a.text } : {}) }, C.announce.reply, () => lead.close())}
      onShowNewer={current && current.id !== o.qid ? () => lead.api.openReply(o.floor, o.member, current.id) : undefined}
      onClose={() => lead.close()}
    />
  );
}
