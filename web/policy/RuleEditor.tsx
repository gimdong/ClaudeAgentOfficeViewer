import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PolicyGroup, PolicyRules, PolicyValue } from "../../src/shared/types";
import { GROUP_LABEL, GROUP_ORDER, TEMPLATES, TEXT, VALUE_LABEL, targetLabel } from "./text";
import type { SaveResult } from "./usePolicy";

type Choice = PolicyValue | "default";
type Status = "idle" | "saving" | "saved" | "deleted" | Exclude<SaveResult, "saved">;

const same = (a: PolicyRules, b: PolicyRules) => GROUP_ORDER.every((g) => a[g] === b[g]);
const copy = (r: PolicyRules): PolicyRules => Object.fromEntries(GROUP_ORDER.flatMap((g) => (r[g] ? [[g, r[g]]] : [])));

const FAIL: Partial<Record<Status, { text: string; tone: "red" | "yellow" }>> = {
  invalid: { text: TEXT.invalid, tone: "red" },
  limit: { text: TEXT.limit, tone: "red" },
  failed: { text: TEXT.failed, tone: "red" },
  "not-persisted": { text: TEXT.notPersisted, tone: "yellow" },
};

/**
 * 권한 칸(디자인 phase3 §2). 편집 값은 처음(대상이 바뀌면 key로 새로 만든다)과 저장에 성공했을 때만 서버 값으로 채운다 —
 * 3초마다 오는 스냅샷이 고르던 값을 덮지 않는다(Review Focus 1). 바꾼 것이 없을 때 서버 값이 바뀌면 따라간다.
 * 저장하지 않은 변경이 있는 채로 사라지면(닫기, 대상 옮기기, 다른 서랍) live region에 알린다(§2.4)
 */
export function RuleEditor(p: { target: string; saved: PolicyRules; onSave(rules: PolicyRules): Promise<SaveResult>; announce(text: string): void; before?: ReactNode; after?: ReactNode }) {
  const [base, setBase] = useState<PolicyRules>(() => copy(p.saved));
  const [edit, setEdit] = useState<PolicyRules>(() => copy(p.saved));
  const [status, setStatus] = useState<Status>("idle");
  const dirty = !same(edit, base);
  const busy = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const announce = useRef(p.announce);
  announce.current = p.announce;

  // 바꾼 것이 없으면 서버 값을 따라간다(다른 탭에서 바꿨거나 저장 직후 스냅샷). 스냅샷마다 새 객체이므로 내용으로 비교한다.
  // 값을 되돌려 dirty가 풀린 때도 따라간다(B105). 저장에 성공한 직후에는 그 저장이 실린 스냅샷이 올 때까지 기다린다 —
  // 아직 예전 스냅샷이면 방금 저장한 값을 예전 값으로 되돌려 버린다
  const savedKey = JSON.stringify(copy(p.saved));
  const staleKey = useRef<string | null>(null);
  useEffect(() => {
    if (staleKey.current !== null && staleKey.current !== savedKey) staleKey.current = null;
    if (dirty || busy.current || staleKey.current !== null) return;
    const r = JSON.parse(savedKey) as PolicyRules;
    setBase(r);
    setEdit(r);
  }, [savedKey, dirty]);

  useEffect(
    () => () => {
      // 저장 중에 닫으면 버린 것이 아니다(곧 "저장했습니다"가 온다, B105)
      if (dirtyRef.current && !busy.current) announce.current(TEXT.discarded);
    },
    [],
  );

  const change = (next: PolicyRules) => {
    setEdit(copy(next));
    setStatus("idle");
  };
  const pick = (g: PolicyGroup, v: Choice) => {
    const next = { ...edit };
    if (v === "default") delete next[g];
    else next[g] = v;
    change(next);
  };

  const canSave = dirty || status === "not-persisted";
  const save = async () => {
    if (busy.current || !canSave) return;
    busy.current = true;
    const rules = copy(edit);
    setStatus("saving");
    const r = await p.onSave(rules);
    busy.current = false;
    if (r === "saved" || r === "not-persisted") {
      // 메모리에는 적용됐다(B87). 편집 값을 기준으로 삼는다
      if (JSON.stringify(rules) !== savedKey) staleKey.current = savedKey;
      setBase(rules);
      const empty = Object.keys(rules).length === 0;
      if (r === "saved") {
        setStatus(empty ? "deleted" : "saved");
        p.announce(`${targetLabel(p.target)} 권한 정책을 ${empty ? "지웠습니다" : "저장했습니다"}`);
      } else setStatus("not-persisted");
    } else setStatus(r);
  };

  const fail = FAIL[status];
  let line: ReactNode = null;
  if (fail) line = <span className={`ap-state ${fail.tone}`} role="alert">{fail.text}</span>;
  else if (status === "saved" || status === "deleted") line = <span className="ap-state green">{status === "saved" ? TEXT.saved : TEXT.deleted}</span>;
  else if (dirty) line = <span id="ap-unsaved" className="ap-state yellow">{TEXT.unsaved}</span>;

  return (
    <>
      <div className="rp-scroll">
        {p.before}
        <section className="rp-sec" aria-labelledby="ap-tpl-h">
          <h3 id="ap-tpl-h">{TEXT.secTemplates}</h3>
          <div className="ap-tpl">
            {TEMPLATES.map((t) => (
              <button key={t.id} type="button" className="pbtn" aria-describedby="ap-tpl-help" onClick={() => change(t.rules)}>
                {t.label}
              </button>
            ))}
          </div>
          <p id="ap-tpl-help" className="ap-help">{TEXT.templateHelp}</p>
        </section>
        <section className="rp-sec" aria-labelledby="ap-rules-h">
          <h3 id="ap-rules-h">{TEXT.secRules}</h3>
          {GROUP_ORDER.map((g) => {
            const cur: Choice = edit[g] ?? "default";
            const changed = edit[g] !== base[g];
            return (
              <fieldset
                key={g}
                className={`pr-row${changed ? " changed" : ""}${g === "all" ? " pr-row--all" : ""}`}
                role="radiogroup"
                aria-label={GROUP_LABEL[g]}
                {...(g === "all" ? { "aria-describedby": "ap-all-help" } : {})}
              >
                <span className="pr-name" aria-hidden="true">{GROUP_LABEL[g]}</span>
                {(["default", "ask", "deny"] as const).map((v) => (
                  <label key={v} className={`pr-opt pr-opt--${v}`}>
                    <input type="radio" name={`pr-${g}`} value={v} checked={cur === v} onChange={() => pick(g, v)} />
                    <span className="pr-mark" aria-hidden="true" />
                    {VALUE_LABEL[v]}
                  </label>
                ))}
              </fieldset>
            );
          })}
          <p id="ap-all-help" className="ap-help">{TEXT.allHelp}</p>
          <p className="ap-help ap-exempt">{TEXT.exemptHelp}</p>
        </section>
        {p.after}
      </div>
      <div className="ap-foot">
        <div className="ap-line">{line}</div>
        <button
          type="button"
          className="pbtn pbtn--primary ap-save"
          aria-disabled={!canSave || status === "saving" ? true : undefined}
          aria-busy={status === "saving" ? true : undefined}
          aria-describedby={dirty ? "ap-unsaved" : undefined}
          onClick={save}
        >
          {status === "saving" ? TEXT.saving : TEXT.save}
        </button>
      </div>
    </>
  );
}
