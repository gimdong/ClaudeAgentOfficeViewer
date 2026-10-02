import { createContext, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import type { SessionView } from "../../src/shared/types";
import { usageLabel } from "../report/text";
import { UNAUTHORIZED_EVENT } from "../useSnapshot";

/** App이 넣어 주는 값(Building·Floor를 거치지 않는다): 새 층 기본값과 하나뿐인 status 알림 */
export const BudgetSettingsContext = createContext<{ defaultTokens?: number; announce?(text: string): void }>({});

const MIN = 1_000;
const MAX = 1_000_000_000;
const INVALID = "1,000에서 1,000,000,000 사이의 정수를 입력해 주세요";
/** 알림 권한은 이 브라우저에서 처음 저장할 때 한 번만 묻는다(§6.2) */
const ASKED_KEY = "claude-office:notification-asked";

/** 쉼표와 공백을 지우고 읽는다. 빈 값은 null(예산 없음), 형식이 틀리면 undefined */
export function parseBudget(text: string): number | null | undefined {
  const t = text.replace(/[,\s]/g, "");
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= MIN && n <= MAX ? n : undefined;
}

const show = (n: number | undefined) => (n === undefined ? "" : n.toLocaleString("en-US"));

function noticeLine(): string {
  const N = (globalThis as { Notification?: { permission?: NotificationPermission } }).Notification;
  if (!N) return "이 브라우저는 알림을 지원하지 않아 층 경광등만 켜집니다.";
  if (N.permission === "granted") return "예산에 닿으면 브라우저 알림과 층 경광등으로 알려 드립니다.";
  if (N.permission === "denied") return "브라우저 알림이 꺼져 있어 층 경광등만 켜집니다.";
  return "처음 저장할 때 브라우저가 알림을 허용할지 묻습니다. 거절해도 층 경광등은 켜집니다.";
}

/** 처음 저장할 때만(이 브라우저에서 한 번) 알림 권한을 묻는다. 저장은 결과를 기다리지 않는다. 클릭 안에서 불러야 브라우저가 창을 띄운다 */
function askNotificationOnce(): void {
  const N = (globalThis as { Notification?: { permission?: NotificationPermission; requestPermission?(): Promise<unknown> } }).Notification;
  let asked = false;
  try {
    asked = localStorage.getItem(ASKED_KEY) === "1";
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    /* 저장소가 막혀 있으면 이번만 묻는다 */
  }
  if (asked || !N?.requestPermission || N.permission !== "default") return;
  void N.requestPermission().catch(() => {});
}

async function put(body: object): Promise<boolean> {
  const r = await fetch("/api/budget", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return r.ok;
}

/** 층 예산 설정 창(디자인 phase2 §6.2). <dialog>.showModal(). 닫히면 onClose(부른 쪽이 설정 버튼으로 포커스를 되돌린다) */
export function BudgetDialog({ session, defaultTokens, announce, onClose }: { session: SessionView; defaultTokens?: number; announce?(text: string): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const own = useRef<HTMLInputElement>(null);
  const id = useId();
  const startOwn = show(session.budget?.budgetTokens);
  const startDef = show(defaultTokens);
  const [ownText, setOwnText] = useState(startOwn);
  const [defText, setDefText] = useState(startDef);
  const [invalid, setInvalid] = useState<{ own: boolean; def: boolean }>({ own: false, def: false });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    own.current?.focus();
  }, []);

  const close = () => {
    ref.current?.close?.();
    onClose();
  };
  // Esc(브라우저의 cancel)도 같은 닫기로 처리한다
  const onCancel = (e: SyntheticEvent) => {
    e.preventDefault();
    close();
  };

  const save = () => {
    if (saving) return;
    const o = parseBudget(ownText);
    const d = parseBudget(defText);
    setInvalid({ own: o === undefined, def: d === undefined });
    if (o === undefined || d === undefined) return;
    // 바뀐 칸만 보낸다
    const sends: object[] = [];
    if (o !== (parseBudget(startOwn) ?? null)) sends.push({ sessionId: session.id, budgetTokens: o });
    if (d !== (parseBudget(startDef) ?? null)) sends.push({ budgetTokens: d });
    if (sends.length === 0) return close();
    if (sends.some((b) => (b as { budgetTokens: number | null }).budgetTokens !== null)) askNotificationOnce();
    setSaving(true);
    setFailed(false);
    (async () => {
      for (const b of sends) if (!(await put(b))) throw new Error("save failed");
    })()
      .then(() => {
        announce?.("예산을 저장했습니다");
        close();
      })
      .catch(() => {
        setSaving(false);
        setFailed(true);
      });
  };

  const err = (key: "own" | "def") => (invalid[key] ? `${id}-${key}-err` : "");
  return (
    <dialog ref={ref} className="dlg budget-dlg" aria-labelledby={`${id}-title`} onCancel={onCancel}>
      <h2 id={`${id}-title`} className="dlg-title">{`${session.name} 예산`}</h2>
      <div className="dlg-field">
        <label htmlFor={`${id}-own`}>이 층의 예산</label>
        <span className="dlg-input">
          <input
            ref={own}
            id={`${id}-own`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={ownText}
            onChange={(e) => setOwnText(e.target.value)}
            aria-invalid={invalid.own || undefined}
            aria-describedby={`${id}-own-help ${err("own")}`.trim()}
          />
          <span className="unit">토큰</span>
        </span>
        {invalid.own && (
          <p id={`${id}-own-err`} className="dlg-err">
            {INVALID}
          </p>
        )}
        <p id={`${id}-own-help`} className="dlg-help">
          {session.budget && (
            <>
              {`지금까지 쓴 양 ${usageLabel(session.budget.usedTokens)}`}
              <br />
            </>
          )}
          비워 두면 예산 없음. 1,000 ~ 1,000,000,000
        </p>
      </div>
      <div className="dlg-field">
        <label htmlFor={`${id}-def`}>새 층의 기본값</label>
        <span className="dlg-input">
          <input
            id={`${id}-def`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={defText}
            onChange={(e) => setDefText(e.target.value)}
            aria-invalid={invalid.def || undefined}
            aria-describedby={`${id}-def-help ${err("def")}`.trim()}
          />
          <span className="unit">토큰</span>
        </span>
        {invalid.def && (
          <p id={`${id}-def-err`} className="dlg-err">
            {INVALID}
          </p>
        )}
        <p id={`${id}-def-help`} className="dlg-help">
          앞으로 새로 생기는 층에 적용됩니다. 지금 있는 층은 바뀌지 않습니다.
        </p>
      </div>
      <p className="dlg-help">{noticeLine()}</p>
      {failed && (
        <p className="dlg-err" role="alert">
          저장하지 못했습니다. 다시 시도해 주세요.
        </p>
      )}
      <div className="dlg-buttons">
        <button type="button" className="pbtn" onClick={close}>
          취소
        </button>
        <button type="button" className="pbtn pbtn--primary" onClick={save} disabled={saving}>
          {saving ? "저장하는 중…" : "저장"}
        </button>
      </div>
    </dialog>
  );
}
