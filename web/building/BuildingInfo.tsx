import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { CH_TEXT } from "../floors/ChannelDialogs";
import { formatTokens } from "../format";
import type { Snapshot } from "../../src/shared/types";
import { BAR_EMPTY, planEmptyText } from "../hud/remaining";
import { graphemes } from "../report/text";

export const NAME_MAX = 40;
export const BUILDING_TEXT = {
  title: "빌딩 정보",
  name: "이름",
  sign: (name: string) => `${name}의 회사`,
  signDefault: "User",
  signAria: (name: string) => `빌딩 정보 열기, ${name}의 회사`,
  signHelp: (name: string) => `간판에는 "${name}의 회사"로 보입니다`,
  empty: "이름을 1자 이상 적어 주세요",
  saved: "저장했습니다",
  close: "닫기",
  save: "저장",
  today: "오늘 토큰",
  cacheRead: (n: string) => `캐시 읽기 ${n}`,
  last5h: "최근 5시간",
  last7d: "최근 7일",
  estimated: "추정",
  five: "5H 잔여",
  week: "WEEK 잔여",
  plan: "PLAN 잔여",
  needSetup: BAR_EMPTY.needSetup,
  planNone: BAR_EMPTY.planNone,
  planOff: BAR_EMPTY.planOff,
  planUnsupported: BAR_EMPTY.planUnsupported,
  // 스펙 12장 j(qa #627 F)·B331·B332: statusline 연결 상태별 이유. 상태를 모르는 옛 서버는 off와 같다
  planWhyOff: "PLAN 잔여는 Claude Code가 상태줄에 넘겨 주는 값입니다. 이 설치본은 상태줄 연결이 꺼져 있어 받지 못합니다. 켜려면 설치 스크립트를 --statusline을 붙여 다시 실행하세요.",
  planWhyOn: "PLAN 잔여는 Claude Code가 상태줄에 넘겨 주는 값입니다. Pro·Max 요금제나 지출 한도가 있는 gateway에서만 오고, 이 계정에는 오지 않습니다.",
  // B331(qa 검토 전): Windows
  planWhyUnsupported: "PLAN 잔여는 Claude Code가 상태줄에 넘겨 주는 값입니다. Windows에서는 상태줄 연결을 지원하지 않아 받지 못합니다.",
  floors: "층·팀원",
  floorsValue: (f: number, m: number) => `${f}층 · 팀원 ${m}명`,
  version: "버전",
  versionValue: (server: string | undefined, app: string) => `서버 ${server ? `v${server}` : "알 수 없음"} · 화면 v${app}`,
} as const;

const pct = (v: number | null, none: string) => (v === null ? none : `${Math.round(v)}%`);

/**
 * 빌딩 정보 창(디자인 phase6b §11.2). 이름 고치기 + HUD와 같은 원천의 숫자 보기. 이름은 글자로만 그린다
 */
export function BuildingInfo(p: {
  userName: string;
  usage: { today: number; todayCacheRead: number; last5h: number; last7d: number };
  remaining: { five: number | null; week: number | null; plan: number | null };
  floors: number;
  members: number;
  serverVersion?: string;
  /** statusline 연결 상태(스펙 12장 j) — PLAN 이유 줄을 고른다 */
  statusline?: Snapshot["statusline"];
  appVersion: string;
  onSave(name: string): Promise<boolean>;
  onClose(): void;
}) {
  const T = BUILDING_TEXT;
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [name, setName] = useState(p.userName);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "saved" | "failed">("idle");
  useLayoutEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (state !== "saved") return;
    const t = setTimeout(() => setState("idle"), 3000);
    return () => clearTimeout(t);
  }, [state]);

  const trimmed = name.trim();
  const n = graphemes(trimmed).length;
  const invalid = n === 0 || n > NAME_MAX;
  const canSave = !busy && !invalid && trimmed !== p.userName;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const ok = await p.onSave(trimmed).catch(() => false);
    setBusy(false);
    setState(ok ? "saved" : "failed");
  };
  const onCancel = (e: SyntheticEvent) => {
    e.preventDefault();
    p.onClose();
  };
  const shown = trimmed || p.userName;
  const rows: Array<[string, ReactNode]> = [
    [T.today, <>{formatTokens(p.usage.today)}<small>{T.cacheRead(formatTokens(p.usage.todayCacheRead))}</small></>],
    [T.last5h, <>{formatTokens(p.usage.last5h)}<small>{T.estimated}</small></>],
    [T.last7d, <>{formatTokens(p.usage.last7d)}<small>{T.estimated}</small></>],
    [T.five, pct(p.remaining.five, T.needSetup)],
    [T.week, pct(p.remaining.week, T.needSetup)],
    [T.plan, p.remaining.plan === null ? <>{planEmptyText(p)}<span className="bi-why">{p.statusline === "on" ? T.planWhyOn : p.statusline === "unsupported" ? T.planWhyUnsupported : T.planWhyOff}</span></> : pct(p.remaining.plan, T.planNone)],
    [T.floors, T.floorsValue(p.floors, p.members)],
    [T.version, T.versionValue(p.serverVersion, p.appVersion)],
  ];

  return (
    <dialog ref={ref} className="dlg bi" aria-labelledby={`${id}-title`} onCancel={onCancel}>
      <h2 id={`${id}-title`} className="dlg-title">
        {T.title}
      </h2>
      <div className="dlg-field bi-name">
        <label htmlFor={`${id}-name`}>
          <span>{T.name}</span>
          <span className={`unit${n > NAME_MAX ? " over" : ""}`}>{`(${n}/${NAME_MAX})`}</span>
        </label>
        <div className="dlg-input">
          <input
            ref={input}
            id={`${id}-name`}
            value={name}
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-help`}
            onChange={(e) => (setName(e.target.value), setState("idle"))}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.preventDefault(), void save())}
          />
        </div>
        <p id={`${id}-help`} className="dlg-help">
          {T.signHelp(shown)}
        </p>
        {n === 0 && (
          <p className="dlg-err" role="alert">
            {T.empty}
          </p>
        )}
      </div>
      <dl className="bi-kv" style={{ gridTemplateRows: `repeat(${rows.length}, auto)` }}>
        {rows.map(([k, v]) => (
          <div key={k} className="bi-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {state === "failed" && (
        <p className="dlg-err" role="alert">
          {CH_TEXT.failed}
        </p>
      )}
      <div className="dlg-buttons">
        {state === "saved" && (
          <span className="bi-ok" role="status">
            {T.saved}
          </span>
        )}
        <button type="button" className="pbtn" onClick={p.onClose}>
          {T.close}
        </button>
        <button type="button" className="pbtn pbtn--primary" aria-disabled={!canSave || undefined} aria-busy={busy || undefined} onClick={() => void save()}>
          {T.save}
        </button>
      </div>
    </dialog>
  );
}
