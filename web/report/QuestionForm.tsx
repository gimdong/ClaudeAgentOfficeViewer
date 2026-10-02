import { useId, useState, type KeyboardEvent } from "react";
import type { QuestionView } from "../../src/shared/types";

export const OTHER_MAX = 500;
type Answer = { labels: number[] } | { other: string };
/** 질문 하나의 고른 상태. 선택지는 인덱스로만 다룬다(같은 label이 둘이어도 따로, Ruling B30) */
interface Pick {
  picked: number[];
  other: boolean;
  text: string;
}

const empty = (): Pick => ({ picked: [], other: false, text: "" });
const answered = (p: Pick) => (p.other ? p.text.trim() !== "" : p.picked.length > 0);

/**
 * 질문 답하기(디자인 phase2 §2.2). 질문마다 fieldset + legend, 단일 선택은 라디오·다중 선택은 체크박스,
 * 마지막에 "기타 (직접 입력)". 보내는 값은 질문 순서대로 인덱스 또는 자유 입력이다(문자열 label은 보내지 않는다)
 */
export function QuestionForm({ questions, disabled, onSubmit }: { questions: QuestionView[]; disabled: boolean; onSubmit(answers: Answer[]): void }) {
  const base = useId();
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(empty));
  const ready = picks.length === questions.length && picks.every(answered);
  const blocked = disabled || !ready;

  const set = (qi: number, f: (p: Pick) => Pick) => setPicks((all) => all.map((p, i) => (i === qi ? f(p) : p)));
  const send = () => {
    if (blocked) return;
    onSubmit(picks.map((p) => (p.other ? { other: p.text } : { labels: [...p.picked].sort((a, b) => a - b) })));
  };
  const optId = (qi: number, oi: number | "other") => `${base}-q${qi}-${oi === "other" ? "other" : `o${oi}`}`;

  // 라디오 화살표 이동(브라우저 기본과 같은 동작: 다음·이전으로 옮기며 고른다, 끝에서는 반대쪽 끝으로)
  const onRadioKey = (qi: number, at: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const count = questions[qi].options.length + 1; // + 기타
    const to = (at + step + count) % count;
    set(qi, (p) => (to === count - 1 ? { ...p, other: true, picked: [] } : { ...p, other: false, picked: [to] }));
    document.getElementById(optId(qi, to === count - 1 ? "other" : to))?.focus();
  };

  const onOtherKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  return (
    <div className={`qf${disabled ? " locked" : ""}`}>
      {questions.map((q, qi) => {
        const p = picks[qi] ?? empty();
        const type = q.multiSelect ? "checkbox" : "radio";
        const name = `${base}-q${qi}`;
        return (
          <fieldset key={qi} className="qf-q">
            <legend>
              {q.header && <span className="qf-header">{q.header}</span>}
              <span className="qf-text">{q.question}</span>
            </legend>
            {q.options.map((o, oi) => (
              <label key={oi} className="qf-opt" htmlFor={optId(qi, oi)}>
                <input
                  id={optId(qi, oi)}
                  type={type}
                  name={name}
                  checked={!p.other && p.picked.includes(oi)}
                  onChange={(e) =>
                    set(qi, (cur) =>
                      q.multiSelect
                        ? { ...cur, other: false, picked: e.target.checked ? [...cur.picked.filter((x) => x !== oi), oi] : cur.picked.filter((x) => x !== oi) }
                        : { ...cur, other: false, picked: [oi] },
                    )
                  }
                  onKeyDown={q.multiSelect ? undefined : onRadioKey(qi, oi)}
                />
                <span className="qf-label">{o.label}</span>
                {o.description && <span className="qf-desc">{o.description}</span>}
              </label>
            ))}
            <label className="qf-opt" htmlFor={optId(qi, "other")}>
              <input
                id={optId(qi, "other")}
                type={type}
                name={name}
                checked={p.other}
                onChange={(e) => set(qi, (cur) => ({ ...cur, other: q.multiSelect ? e.target.checked : true, picked: [] }))}
                onKeyDown={q.multiSelect ? undefined : onRadioKey(qi, q.options.length)}
              />
              <span className="qf-label">기타 (직접 입력)</span>
            </label>
            {p.other && (
              <div className="qf-other">
                <label htmlFor={`${name}-text`}>기타 답</label>
                <textarea
                  id={`${name}-text`}
                  rows={2}
                  maxLength={OTHER_MAX}
                  value={p.text}
                  onChange={(e) => {
                    const text = e.target.value.slice(0, OTHER_MAX);
                    set(qi, (cur) => ({ ...cur, text }));
                  }}
                  onKeyDown={onOtherKey}
                />
                <span className="qf-count" aria-hidden="true">{`${[...p.text].length}/${OTHER_MAX}`}</span>
              </div>
            )}
          </fieldset>
        );
      })}
      {!ready && (
        <p id={`${base}-hint`} className="qf-hint">
          모든 질문에 답하면 보낼 수 있습니다
        </p>
      )}
      <button
        type="button"
        className="pbtn pbtn--primary qf-send"
        aria-disabled={blocked || undefined}
        aria-describedby={!ready ? `${base}-hint` : undefined}
        onClick={send}
      >
        이 답 보내기
      </button>
    </div>
  );
}
