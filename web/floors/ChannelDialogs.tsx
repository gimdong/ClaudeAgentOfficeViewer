import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { FolderView } from "../../src/shared/types";
import type { Snapshot } from "../../src/shared/types";
import { UNAUTHORIZED_EVENT } from "../useSnapshot";

/** Phase 4b 화면 문구(스펙 3·4·6·7장). 설명서·테스트가 이 상수와 대조한다 */
export const CH_TEXT = {
  expButton: "실험 기능",
  expTitle: "실험 기능: 작업 지시와 새 층",
  expBody:
    "작업 지시와 새 층은 Claude Code의 연구 프리뷰 기능(channel)을 씁니다. Claude Code가 바뀌면 동작이 바뀌거나 멈출 수 있습니다. 새 층을 띄울 때마다 Claude Code가 개발용 channel 경고를 띄웁니다. 회사 계정(Team·Enterprise)에서는 관리자가 허용하기 전까지 동작하지 않습니다.",
  expAgree: "위 내용을 이해했고 실험 기능을 켭니다",
  expOn: "켜기",
  expOff: "끄기",
  expUnavailable: "tmux 3.0 이상이 있어야 새 층을 띄울 수 있습니다(macOS·Linux).",
  offTitle: "실험 기능을 켜면 쓸 수 있습니다",
  launchButton: "새 세션 시작",
  launchTitle: "새 층 띄우기",
  fCwd: "폴더",
  fName: "이름(비우면 폴더 이름)",
  fModel: "모델",
  fPrompt: "첫 지시(선택)",
  fMode: "일하는 방식",
  modeSub: "서브에이전트(기본)",
  modeTeam: "agent team(실험)",
  teamGood: ["팀원마다 이 층에 책상이 생기고, 각자 무엇을 하는지·모델·토큰이 따로 보입니다.", "팀원끼리 메시지로 의논하고 일을 나눕니다.", "결정 대기와 권한 정책을 팀원 이름별로 다룰 수 있습니다."],
  teamWarn: [
    "Claude Code의 실험 기능입니다. 버전에 따라 동작이 바뀔 수 있습니다.",
    "팀원마다 따로 생각하기 때문에 토큰을 훨씬 많이 씁니다. 사용 한도에 빨리 닿을 수 있습니다.",
    "팀원의 권한 확인 창은 리드의 터미널(tmux)에 뜹니다. 대시보드에서도 답할 수 있습니다.",
    "팀원끼리 서로 답을 기다리다 함께 멈출 수 있습니다. 이때는 리드에게 \"다시 진행해\"라고 지시해 주세요.",
    "한 팀원이 사용 한도에 걸리면 그 팀원만 멈출 수 있습니다.",
    "리드를 끄면 팀원도 함께 끝납니다.",
  ],
  teamGoodTitle: "agent team으로 하면",
  teamWarnTitle: "알아 둘 점",
  teamHint: "간단한 일이나 처음 써 보는 경우에는 서브에이전트(기본)를 권합니다.",
  modelDefault: "기본",
  launch: "띄우기",
  launching: "띄우는 중…",
  attachTitle: "터미널에서 붙어 확인해 주세요",
  attachBody: "터미널에서 아래 명령으로 붙어 확인 창 두 개(폴더 신뢰, 개발용 channel 경고)를 확인해 주세요. 확인하기 전에는 Claude가 시작하지 않습니다.",
  attachCmd: (tmux: string) => `tmux attach -t ${tmux}`,
  copy: "복사",
  copied: "복사했습니다",
  close: "닫기",
  cancel: "취소",
  instruct: "작업 지시",
  instructTitle: (name: string) => `${name} 층에 작업 지시`,
  instructBusy: "작업 중이라 Claude가 지금 하던 일을 마친 뒤 읽습니다.",
  instructPaused: "휴업 중이라 보관했다가, 재개할 때 확인하고 보냅니다.",
  send: "보내기",
  sending: "보내는 중…",
  notLaunched: "대시보드가 띄운 층에만 지시할 수 있습니다(Claude Code 제약)",
  notConnected: "channel이 아직 연결되지 않았습니다. 터미널에서 확인 창을 확인했는지 봐 주세요.",
  chipLaunched: "대시보드가 띄움",
  chipConnected: "연결됨",
  chipWaiting: "연결 전",
  chipHeld: (n: number) => `보관 ${n}`,
  chipSent: "지시 보냄",
  // B343(qa #668 확정): 보낸 지시를 세션이 받은 흔적(리드 hook)이 없음 — 아는 것(흔적 없음)만 말한다. 30초는 RECEIPT_MS
  chipUnreceived: "받았는지 확인 안 됨",
  unreceived: '보낸 지시를 세션이 받았는지 확인하지 못했습니다(30초 동안 일을 시작한 흔적이 없음). 로그인 방식(회사 중계 주소 등)이나 조직 설정에 따라 작업 지시가 동작하지 않을 수 있습니다. 설명서 6장 "작업 지시가 세션에 닿지 않는 것 같아요"를 봐 주세요.',
  chipDelivered: "전달됨",
  briefTitle: (name: string) => `${name} 층 재개 전 확인`,
  briefHeld: "휴업 중 보관한 지시",
  briefDecisions: (n: number) => `기다리는 결정 ${n}건`,
  briefGoDecision: "결정 보러 가기",
  briefMemory: "보관한 지시는 대시보드가 켜져 있는 동안만 남습니다.",
  edit: "고치기",
  save: "저장",
  remove: "지우기",
  sendResume: "보내고 재개",
  resume: "재개",
  failed: "처리하지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.",
  errors: {
    cwd: "있는 폴더의 전체 경로를 적어 주세요.",
    name: "이름은 글자·숫자·공백·. _ -로 40자까지이고, -로 시작할 수 없습니다.",
    prompt: "첫 지시는 8,000자까지입니다.",
    "prompt-dash": "첫 지시는 -로 시작할 수 없습니다(Claude Code가 옵션으로 읽습니다). 앞에 다른 글자를 두어 주세요.",
    limit: "대시보드가 띄운 층이 너무 많습니다(8개). 쓰지 않는 층을 끈 뒤 다시 해 주세요.",
    tmux: "tmux로 띄우지 못했습니다. tmux가 설치되어 있는지 확인해 주세요.",
    "held-full": "보관함이 가득 찼습니다(20개). 재개해서 보낸 뒤 다시 해 주세요.",
    "not-connected": "channel이 아직 연결되지 않았습니다. 터미널에서 확인 창을 확인했는지 봐 주세요.",
  } as Record<string, string>,
} as const;

type R<T> = { ok: true; body: T } | { ok: false; error: string };
async function req<T>(method: string, path: string, body?: object): Promise<R<T>> {
  try {
    const r = await fetch(path, method === "GET" ? undefined : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    if (r.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
    if (r.ok && j) return { ok: true, body: j };
    return { ok: false, error: typeof j?.error === "string" ? j.error : "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}
const at = (id: string, p: string) => `/api/floors/${encodeURIComponent(id)}/${p}`;
export interface Held { id: string; text: string; at: string }
export const chApi = {
  setExperimental: (on: boolean) => req<{ saved: boolean }>("PUT", "/api/experimental", { channels: on }),
  launch: (b: { cwd: string; name?: string; model?: string; prompt?: string; mode?: string }) => req<{ sessionId: string; tmux: string }>("POST", "/api/floors/launch", b),
  instruct: (id: string, text: string) => req<{ id: string; state: "sent" | "held" }>("POST", at(id, "instruct"), { text }),
  held: (id: string) => req<{ held: Held[] }>("GET", at(id, "held")),
  editHeld: (id: string, hid: string, text: string) => req<object>("PUT", at(id, `held/${encodeURIComponent(hid)}`), { text }),
  dropHeld: (id: string, hid: string) => req<object>("DELETE", at(id, `held/${encodeURIComponent(hid)}`)),
  // Phase 6b 팀리더 지시·서류철
  lead: (id: string, body: object) => req<{ requestId: string; id: string; state: "sent" | "held" }>("POST", at(id, "lead"), body),
  reports: (id: string) => req<FolderView>("GET", at(id, "reports")),
  // Phase 6b Task 10 지붕 간판 이름
  setUserName: (userName: string) => req<{ userName: string; saved: boolean }>("PUT", "/api/building", { userName }),
};
const errText = (e: string) => CH_TEXT.errors[e] ?? CH_TEXT.failed;

/** 공통 대화상자: showModal, Esc = 닫기, 열릴 때 첫 입력(없으면 [취소])에 포커스, 닫으면 연 요소로(호출한 쪽) */
function Dlg(p: { title: string; onClose(): void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    (d?.querySelector<HTMLElement>("input, textarea, select") ?? d?.querySelector<HTMLElement>("[data-cancel]"))?.focus();
  }, []);
  const onCancel = (e: SyntheticEvent) => {
    e.preventDefault();
    p.onClose();
  };
  return (
    <dialog ref={ref} className={`dlg ch-dlg ${p.className ?? ""}`} aria-labelledby={`${id}-t`} onCancel={onCancel}>
      <h2 id={`${id}-t`} className="dlg-title">
        {p.title}
      </h2>
      {p.children}
    </dialog>
  );
}
const Err = ({ e }: { e: string | null }) =>
  e ? (
    <p className="dlg-err" role="alert">
      {e}
    </p>
  ) : null;

export function ExperimentalDialog({ exp, onClose, announce }: { exp: NonNullable<Snapshot["experimental"]>; onClose(): void; announce?(t: string): void }) {
  const [agree, setAgree] = useState(exp.channels);
  const [err, setErr] = useState<string | null>(null);
  const set = async (on: boolean) => {
    const r = await chApi.setExperimental(on);
    if (!r.ok) return setErr(errText(r.error));
    announce?.(on ? "실험 기능을 켰습니다" : "실험 기능을 껐습니다");
    onClose();
  };
  return (
    <Dlg title={CH_TEXT.expTitle} onClose={onClose}>
      <p className="ch-body">{CH_TEXT.expBody}</p>
      {!exp.available && <p className="ch-note">{CH_TEXT.expUnavailable}</p>}
      {exp.available && !exp.channels && (
        <label className="ch-check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> {CH_TEXT.expAgree}
        </label>
      )}
      <Err e={err} />
      <div className="dlg-buttons">
        <button type="button" className="pbtn" data-cancel onClick={onClose}>
          {CH_TEXT.cancel}
        </button>
        {exp.channels ? (
          <button type="button" className="pbtn" onClick={() => void set(false)}>
            {CH_TEXT.expOff}
          </button>
        ) : (
          <button type="button" className="pbtn pbtn--primary" aria-disabled={!exp.available || !agree || undefined} onClick={() => exp.available && agree && void set(true)}>
            {CH_TEXT.expOn}
          </button>
        )}
      </div>
    </Dlg>
  );
}

export function LaunchDialog({ onClose, announce }: { onClose(): void; announce?(t: string): void }) {
  const [f, setF] = useState({ cwd: "", name: "", model: "", prompt: "", mode: "subagents" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await chApi.launch({ cwd: f.cwd.trim(), ...(f.name.trim() ? { name: f.name.trim() } : {}), ...(f.model ? { model: f.model } : {}), ...(f.prompt.trim() ? { prompt: f.prompt } : {}), ...(f.mode === "team" ? { mode: "team" } : {}) });
    setBusy(false);
    if (!r.ok) return setErr(errText(r.error));
    setDone(r.body.tmux);
    announce?.("새 층을 띄웠습니다. 터미널에서 붙어 확인 창을 확인해 주세요");
  };
  if (done) {
    const cmd = CH_TEXT.attachCmd(done);
    return (
      <Dlg title={CH_TEXT.attachTitle} onClose={onClose}>
        <p className="ch-body">{CH_TEXT.attachBody}</p>
        <div className="cmd">
          <code data-testid="attach-cmd">{cmd}</code>
          <button type="button" className="pbtn" onClick={() => void navigator.clipboard?.writeText(cmd).then(() => setCopied(true), () => {})}>
            {copied ? CH_TEXT.copied : CH_TEXT.copy}
          </button>
        </div>
        <div className="dlg-buttons">
          <button type="button" className="pbtn" data-cancel onClick={onClose}>
            {CH_TEXT.close}
          </button>
        </div>
      </Dlg>
    );
  }
  const field = (k: keyof typeof f) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  return (
    <Dlg title={CH_TEXT.launchTitle} onClose={onClose}>
      <label className="ch-field">
        {CH_TEXT.fCwd}
        <input type="text" placeholder="~/Code/my-project" {...field("cwd")} />
      </label>
      <label className="ch-field">
        {CH_TEXT.fName}
        <input type="text" maxLength={40} {...field("name")} />
      </label>
      <label className="ch-field">
        {CH_TEXT.fModel}
        <select {...field("model")}>
          <option value="">{CH_TEXT.modelDefault}</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
      </label>
      <fieldset className="ch-field ch-mode">
        <legend>{CH_TEXT.fMode}</legend>
        {(["subagents", "team"] as const).map((m) => (
          <label key={m}>
            <input type="radio" name="mode" value={m} checked={f.mode === m} onChange={() => setF({ ...f, mode: m })} /> {m === "team" ? CH_TEXT.modeTeam : CH_TEXT.modeSub}
          </label>
        ))}
      </fieldset>
      {f.mode === "team" && (
        <div className="ch-team" data-testid="team-note">
          <p className="ch-sub">{CH_TEXT.teamGoodTitle}</p>
          <ul>{CH_TEXT.teamGood.map((t) => <li key={t}>{t}</li>)}</ul>
          <p className="ch-sub">{CH_TEXT.teamWarnTitle}</p>
          <ul>{CH_TEXT.teamWarn.map((t) => <li key={t}>{t}</li>)}</ul>
          <p className="ch-note">{CH_TEXT.teamHint}</p>
        </div>
      )}
      <label className="ch-field">
        {CH_TEXT.fPrompt}
        <textarea rows={4} maxLength={8000} {...field("prompt")} />
      </label>
      <Err e={err} />
      <div className="dlg-buttons">
        <button type="button" className="pbtn" data-cancel onClick={onClose}>
          {CH_TEXT.cancel}
        </button>
        <button type="button" className="pbtn pbtn--primary" aria-busy={busy || undefined} onClick={() => void go()}>
          {busy ? CH_TEXT.launching : CH_TEXT.launch}
        </button>
      </div>
    </Dlg>
  );
}

export function InstructDialog({ id, name, paused, working, onClose, announce }: { id: string; name: string; paused: boolean; working: boolean; onClose(): void; announce?(t: string): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setErr(null);
    const r = await chApi.instruct(id, text);
    setBusy(false);
    if (!r.ok) return setErr(errText(r.error));
    announce?.(r.body.state === "held" ? `${name} 층 지시를 보관했습니다` : `${name} 층에 지시를 보냈습니다`);
    onClose();
  };
  return (
    <Dlg title={CH_TEXT.instructTitle(name)} onClose={onClose}>
      {paused ? <p className="ch-note">{CH_TEXT.instructPaused}</p> : working && <p className="ch-note">{CH_TEXT.instructBusy}</p>}
      <textarea className="ch-text" rows={5} maxLength={8000} aria-label={CH_TEXT.instruct} value={text} onChange={(e) => setText(e.target.value)} />
      <Err e={err} />
      <div className="dlg-buttons">
        <button type="button" className="pbtn" data-cancel onClick={onClose}>
          {CH_TEXT.cancel}
        </button>
        <button type="button" className="pbtn pbtn--primary" aria-busy={busy || undefined} onClick={() => void go()}>
          {busy ? CH_TEXT.sending : CH_TEXT.send}
        </button>
      </div>
    </Dlg>
  );
}

/** 재개 브리핑(스펙 7장): 보관 지시를 고치거나 지운 뒤 [보내고 재개]. [취소]는 휴업 유지 */
export function BriefingDialog(p: { id: string; name: string; decisions: number; onGoDecision(): void; onResume(sendHeld: boolean): Promise<boolean>; onClose(): void }) {
  const [items, setItems] = useState<Held[] | null>(null);
  const [editing, setEditing] = useState<{ hid: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const r = await chApi.held(p.id);
    if (r.ok) setItems(r.body.held);
    else setErr(errText(r.error));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    const r = await chApi.editHeld(p.id, editing.hid, editing.text);
    if (!r.ok) return setErr(errText(r.error));
    setEditing(null);
    await load();
  };
  const drop = async (hid: string) => {
    const r = await chApi.dropHeld(p.id, hid);
    if (!r.ok) return setErr(errText(r.error));
    await load();
  };
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await p.onResume((items?.length ?? 0) > 0);
    setBusy(false);
    if (ok) p.onClose();
    else setErr(CH_TEXT.failed);
  };
  const n = items?.length ?? 0;
  return (
    <Dlg title={CH_TEXT.briefTitle(p.name)} onClose={p.onClose} className="brief">
      <h3 className="ch-sub">{CH_TEXT.briefHeld}</h3>
      <ol className="brief-list">
        {(items ?? []).map((h) => (
          <li key={h.id} data-testid="held-item">
            {editing?.hid === h.id ? (
              <>
                <textarea className="ch-text" rows={3} maxLength={8000} aria-label={CH_TEXT.edit} value={editing.text} onChange={(e) => setEditing({ hid: h.id, text: e.target.value })} />
                <button type="button" className="pbtn" onClick={() => void saveEdit()}>
                  {CH_TEXT.save}
                </button>
              </>
            ) : (
              <>
                <span className="held-text">{h.text}</span>
                <button type="button" className="pbtn" onClick={() => setEditing({ hid: h.id, text: h.text })}>
                  {CH_TEXT.edit}
                </button>
                <button type="button" className="pbtn pbtn--danger" onClick={() => void drop(h.id)}>
                  {CH_TEXT.remove}
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      {p.decisions > 0 && (
        <p className="brief-dec">
          {CH_TEXT.briefDecisions(p.decisions)}{" "}
          <button type="button" className="rp-more" onClick={p.onGoDecision}>
            {CH_TEXT.briefGoDecision}
          </button>
        </p>
      )}
      <p className="ch-note">{CH_TEXT.briefMemory}</p>
      <Err e={err} />
      <div className="dlg-buttons">
        <button type="button" className="pbtn" data-cancel onClick={p.onClose}>
          {CH_TEXT.cancel}
        </button>
        <button type="button" className="pbtn pbtn--primary" aria-busy={busy || undefined} onClick={() => void resume()}>
          {n > 0 ? CH_TEXT.sendResume : CH_TEXT.resume}
        </button>
      </div>
    </Dlg>
  );
}
