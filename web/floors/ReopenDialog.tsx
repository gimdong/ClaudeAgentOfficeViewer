import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { MAX_LAUNCHED, type SessionView } from "../../src/shared/types";
import { UNAUTHORIZED_EVENT } from "../useSnapshot";
import { CH_TEXT } from "./ChannelDialogs";
import { FLOOR_TEXT } from "./useFloors";

/** "작업 지시 켜기(옮겨 열기)" 문구(docs/design/phase4b/REOPEN.md 문구표 — 글자 기준) */
export const RE_TEXT = {
  button: "작업 지시 켜기",
  label: (name: string) => `${name} 층 작업 지시 켜기`,
  title: "지금 세션을 끄고 같은 대화를 tmux에서 다시 열어, 이 층에 작업을 지시할 수 있게 합니다",
  titlePaused: '멈춘 층은 스위치를 "영업 중"으로 돌린 뒤 옮겨 열 수 있습니다',
  titleMoving: "옮겨 여는 중입니다",
  titleMerged: '이 층은 Claude Code의 백그라운드 작업과 이어져 있어 옮겨 열 수 없습니다. 작업을 지시하려면 대시보드의 "새 세션 시작"으로 새 층을 띄워 주세요.',
  titleAncestor: "이 대시보드를 켠 세션이라 옮겨 열 수 없습니다. 끄면 대시보드도 함께 꺼져 다시 열 수 없습니다. 작업 지시가 필요하면 대시보드를 다른 터미널 창에서 켜 주세요.",
  dlgTitle: (name: string) => `${name} 층을 tmux로 옮겨 열까요?`,
  body: "이 세션을 끄고, 같은 대화를 이어서 tmux에서 다시 엽니다. 다시 연 뒤에는 이 층에 작업을 지시할 수 있습니다. 지금 터미널 창의 Claude Code는 끝나고, 이후에는 tmux attach로 이어 봅니다.",
  workingWarn: "⚠ 지금 작업 중입니다. 끄면 하던 일(실행 중인 명령·파일 쓰기)이 중간에 끊길 수 있습니다. 끝날 때까지 기다리거나, 그래도 옮기려면 진행하세요.",
  modeHint: "원래 세션의 일하는 방식은 알 수 없어 다시 고릅니다.",
  go: "옮겨 열기",
  going: "옮기는 중…",
  close: "닫기",
  waiting: "이 세션이 끝나기를 기다리고 있습니다(최대 15초). 창을 닫아도 계속됩니다.",
  stillRunning:
    "아직 끝나지 않았습니다. 곧 끝날 수 있으니 잠시 뒤 다시 눌러 보세요. 계속 켜져 있으면 터미널에서 직접 끝낸 뒤 아래 명령으로 이어 열 수 있습니다(이때는 작업 지시가 켜지지 않습니다).",
  busy: "이 층은 지금 옮겨 여는 중입니다. 끝난 뒤 다시 해 주세요.",
  launchFailed: "세션은 껐지만 다시 열지 못했습니다. 대화 기록은 그대로 있어 터미널에서 아래 명령으로 이어 열 수 있습니다.",
  resumeCmd: (id: string) => `claude --resume ${id}`,
  // 신호 전 실패(세션은 끄지 않음, B212 I1·B213)
  beforeCwd: "이 층의 폴더를 찾을 수 없어 옮겨 열지 않았습니다. 세션은 끄지 않았습니다.",
  beforeLimit: `대시보드가 띄운 층이 너무 많아(${MAX_LAUNCHED}개) 옮겨 열지 않았습니다. 세션은 끄지 않았습니다. 쓰지 않는 층을 끈 뒤 다시 해 주세요.`,
  attachBody: "터미널에서 아래 명령으로 붙어 개발용 channel 경고를 확인해 주세요. 폴더 신뢰 확인이 함께 뜨면 그것도 확인해 주세요. 확인하기 전에는 Claude가 이어서 시작하지 않습니다.",
  done: (name: string) => `${name} 층을 옮겨 열었습니다. 터미널에서 붙어 확인 창을 확인해 주세요`,
} as const;

type Mode = "subagents" | "team";
type Fail = { error: string; resumeId?: string };
/** 서버 응답을 문구로(§2.2). stop = 다시 누를 수 없음 */
function failText(f: Fail): { text: string; stop: boolean; cmd?: string } {
  const cmd = f.resumeId ? RE_TEXT.resumeCmd(f.resumeId) : undefined;
  switch (f.error) {
    case "still-running":
      return { text: RE_TEXT.stillRunning, stop: false, cmd };
    case "limit":
    case "tmux":
      // resumeId가 없으면 신호 전에 멈춘 것(세션은 그대로, B212 I1) — 4b 새 층 실패와 같은 문구
      return cmd ? { text: RE_TEXT.launchFailed, stop: true, cmd } : { text: f.error === "limit" ? RE_TEXT.beforeLimit : CH_TEXT.failed, stop: true };
    case "cwd":
      return { text: RE_TEXT.beforeCwd, stop: true };
    case "ancestor":
      return { text: RE_TEXT.titleAncestor, stop: true };
    case "busy":
      return { text: RE_TEXT.busy, stop: true };
    case "ended":
      return { text: FLOOR_TEXT.terminateEnded, stop: true };
    case "not-found":
      return { text: FLOOR_TEXT.hideNotFound, stop: true };
    case "pid-reused":
    case "unverified":
    case "self":
      return { text: FLOOR_TEXT.terminateUnverified, stop: false };
    case "merged":
      return { text: RE_TEXT.titleMerged, stop: true };
    case "paused":
      return { text: RE_TEXT.titlePaused, stop: true };
    case "off":
      return { text: CH_TEXT.offTitle, stop: true };
    default:
      return { text: CH_TEXT.failed, stop: false };
  }
}

async function postReopen(id: string, mode: Mode): Promise<{ ok: true; tmux: string } | ({ ok: false } & Fail) | { ok: false; unauthorized: true; error: string }> {
  try {
    const r = await fetch(`/api/floors/${encodeURIComponent(id)}/reopen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode === "team" ? { mode } : {}) });
    if (r.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      return { ok: false, unauthorized: true, error: "failed" };
    }
    const j = (await r.json().catch(() => null)) as { tmux?: string; error?: string; resumeId?: string } | null;
    if (r.ok && typeof j?.tmux === "string") return { ok: true, tmux: j.tmux };
    if (r.status === 404) return { ok: false, error: "not-found" };
    return { ok: false, error: typeof j?.error === "string" ? j.error : "failed", ...(typeof j?.resumeId === "string" ? { resumeId: j.resumeId } : {}) };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/**
 * 옮겨 열기 상태는 층 밖(모듈)에 둔다 — SIGTERM 뒤 Claude Code가 세션 기록을 지우면 층이 목록에서 잠깐 사라지는데(B142),
 * 그래도 요청은 이어지고 끝나면 창이 저절로 다시 열려야 한다(§2.1, B206 ①·B207 F1). 그림은 Building의 ReopenHost가 맡는다
 */
interface Entry { session: SessionView; open: boolean; mode: Mode; sending: boolean; fail?: Fail; tmux?: string }
let entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const put = (id: string, e: Entry | undefined) => {
  entries = new Map(entries);
  if (e) entries.set(id, e);
  else entries.delete(id);
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const current = () => entries;
let announceFn: ((t: string) => void) | undefined;

/** 층 버튼이 부른다. 그 순간의 층 모양(이름·폴더·구성원)을 들고 창을 연다 */
export function openReopen(session: SessionView): void {
  const cur = entries.get(session.id);
  put(session.id, cur?.sending ? { ...cur, open: true } : { session, open: true, mode: "subagents", sending: false });
}
/** 이 층을 옮겨 여는 중인지(창을 닫았어도) — 층 머리 버튼을 막는다(§1.3) */
export function useReopening(id: string): boolean {
  return !!useSyncExternalStore(subscribe, current).get(id)?.sending;
}
/** 테스트용: 모듈 상태를 비운다 */
export function resetReopen(): void {
  entries = new Map();
  for (const l of listeners) l();
}

const tilde = (cwd: string) => cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
const focusFloorButton = (id: string) => document.getElementById(`floor-${id}`)?.querySelector<HTMLElement>('[data-floor-action="reopen"], [data-floor-action="terminate"]')?.focus();

async function confirmReopen(id: string): Promise<void> {
  const e = entries.get(id);
  if (!e || e.sending) return;
  put(id, { ...e, sending: true, fail: undefined });
  const r = await postReopen(id, e.mode);
  const now = entries.get(id) ?? e;
  if ("unauthorized" in r) return put(id, undefined);
  // 창을 닫았어도 끝나면 다시 연다(성공: 붙는 단계, 실패: 실패 줄 + 명령 상자)
  const result = r.ok ? { tmux: r.tmux, fail: undefined } : { fail: { error: r.error, ...(r.resumeId ? { resumeId: r.resumeId } : {}) } };
  if (r.ok) announceFn?.(RE_TEXT.done(now.session.name));
  // 이 창을 닫았고 다른 창이 열려 있으면 그 창이 닫힐 때까지 미룬다(4a 둘째 창 규칙과 같다, B212 M2). 결과는 버리지 않는다
  if (!now.open && document.querySelector("dialog[open]")) {
    put(id, { ...now, ...result, sending: false, open: false });
    const t = setInterval(() => {
      const e2 = entries.get(id);
      if (!e2 || e2.open) return clearInterval(t);
      if (document.querySelector("dialog[open]")) return;
      clearInterval(t);
      put(id, { ...e2, open: true });
    }, 200);
    return;
  }
  put(id, { ...now, ...result, sending: false, open: true });
}
function closeReopen(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  // 요청 중이면 창만 닫는다(서버는 이어 간다). 그 밖에는 상태를 버린다
  put(id, e.sending ? { ...e, open: false } : undefined);
  queueMicrotask(() => focusFloorButton(id));
}

function Cmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <code data-testid="reopen-cmd">{cmd}</code>
      <button type="button" className="pbtn" onClick={() => void navigator.clipboard?.writeText(cmd).then(() => setCopied(true), () => {})}>
        {copied ? CH_TEXT.copied : CH_TEXT.copy}
      </button>
    </div>
  );
}

function ReopenDialog({ id, e }: { id: string; e: Entry }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  const done = !!e.tmux;
  // 모달을 먼저 연 뒤 포커스: 확인 단계는 [취소](위험 동작, 4a §3), 붙는 단계는 [복사](4b)
  useLayoutEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    (done ? d?.querySelector<HTMLElement>(".cmd button") : d?.querySelector<HTMLElement>("[data-cancel]"))?.focus();
  }, [done]);
  const onCancel = (ev: SyntheticEvent) => {
    ev.preventDefault();
    closeReopen(id);
  };
  const s = e.session;
  if (done) {
    return (
      <dialog ref={ref} className="dlg ch-dlg" aria-labelledby={`${tid}-t`} onCancel={onCancel}>
        <h2 id={`${tid}-t`} className="dlg-title">
          {CH_TEXT.attachTitle}
        </h2>
        <p className="ch-body">{RE_TEXT.attachBody}</p>
        <Cmd cmd={CH_TEXT.attachCmd(e.tmux!)} />
        <div className="dlg-buttons">
          <button type="button" className="pbtn" data-cancel onClick={() => closeReopen(id)}>
            {CH_TEXT.close}
          </button>
        </div>
      </dialog>
    );
  }
  const f = e.fail ? failText(e.fail) : null;
  const stop = !!f?.stop;
  const working = s.floorStatus === "working" || s.members.some((m) => m.state === "working");
  const setMode = (mode: Mode) => put(id, { ...e, mode });
  return (
    <dialog ref={ref} className="dlg td" aria-labelledby={`${tid}-t`} onCancel={onCancel}>
      <h2 id={`${tid}-t`} className="dlg-title">
        {RE_TEXT.dlgTitle(s.name)}
      </h2>
      <dl className="td-kv">
        <dt>{FLOOR_TEXT.keyFolder}</dt>
        <dd className="td-cwd">{tilde(s.cwd)}</dd>
        <dt>{FLOOR_TEXT.keyMembers}</dt>
        <dd>{FLOOR_TEXT.members(s.members.length, s.members.filter((m) => m.state === "working").length)}</dd>
      </dl>
      <p className="td-body">{RE_TEXT.body}</p>
      {working && <p className="td-warn">{RE_TEXT.workingWarn}</p>}
      {/* ★ 현재 세션 경고는 조상이 아닐 때만(조상이면 버튼이 막혀 이 창이 열리지 않는다, B205) */}
      {s.isCurrent && s.reopen !== "ancestor" && <p className="td-warn">{`★ ${FLOOR_TEXT.currentWarn}`}</p>}
      <fieldset className="ch-field ch-mode">
        <legend>{CH_TEXT.fMode}</legend>
        {(["subagents", "team"] as const).map((m) => (
          <label key={m}>
            <input type="radio" name={`${tid}-mode`} value={m} checked={e.mode === m} onChange={() => setMode(m)} /> {m === "team" ? CH_TEXT.modeTeam : CH_TEXT.modeSub}
          </label>
        ))}
      </fieldset>
      {e.mode === "team" && (
        <div className="ch-team" data-testid="team-note">
          <p className="ch-sub">{CH_TEXT.teamGoodTitle}</p>
          <ul>{CH_TEXT.teamGood.map((t) => <li key={t}>{t}</li>)}</ul>
          <p className="ch-sub">{CH_TEXT.teamWarnTitle}</p>
          <ul>{CH_TEXT.teamWarn.map((t) => <li key={t}>{t}</li>)}</ul>
          <p className="ch-note">{CH_TEXT.teamHint}</p>
        </div>
      )}
      <p className="ch-note">{RE_TEXT.modeHint}</p>
      {e.sending && <p className="ch-note" data-testid="reopen-wait">{RE_TEXT.waiting}</p>}
      {f && (
        <>
          <p className="dlg-err" role="alert">
            {f.text}
          </p>
          {f.cmd && <Cmd cmd={f.cmd} />}
        </>
      )}
      <div className="dlg-buttons">
        <button type="button" className="pbtn" data-cancel onClick={() => closeReopen(id)}>
          {e.sending || stop ? RE_TEXT.close : FLOOR_TEXT.cancel}
        </button>
        {/* disabled는 쓰지 않는다(포커스가 body로 떨어짐). 이중 전송은 sending이 막는다 */}
        <button type="button" className="pbtn pbtn--deny" aria-disabled={e.sending || stop || undefined} aria-busy={e.sending || undefined} onClick={() => !e.sending && !stop && void confirmReopen(id)}>
          {e.sending ? RE_TEXT.going : RE_TEXT.go}
        </button>
      </div>
    </dialog>
  );
}

/** 열린 옮겨 열기 창들(보통 하나). Building이 한 번 그린다 — 층이 잠깐 사라져도 창과 요청이 이어진다 */
export function ReopenHost({ announce }: { announce?: (t: string) => void }) {
  // 렌더 중에 모듈 값을 바꾸지 않는다(B212 M3)
  useEffect(() => {
    announceFn = announce;
    return () => {
      if (announceFn === announce) announceFn = undefined;
    };
  }, [announce]);
  const all = useSyncExternalStore(subscribe, current);
  return (
    <>
      {[...all].filter(([, e]) => e.open).map(([id, e]) => (
        <ReopenDialog key={id} id={id} e={e} />
      ))}
    </>
  );
}
