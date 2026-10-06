import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DecisionView, SessionView } from "../../src/shared/types";
import { Icon } from "../pixel/Icon";
import { NEON, roleOf, shirtColor } from "../pixel/palette";
import { PixelSprite } from "../pixel/PixelSprite";
import { characterRows, spriteRects } from "../pixel/sprites";
import {
  EXPIRED, KIND_CHIP, SEND_FAILED, VANISHED, budgetLabel, cutGraphemes, graphemes, conflictLine, outcomeLine, remaining, remainingSeconds, resultLine, summaryOf, titleOf, usageLabel, whyLine,
} from "./text";
import { QuestionForm } from "./QuestionForm";
import { targetKeyOf, targetLabel } from "../policy/text";
import { OpenPolicyContext } from "../policy/usePolicy";
import type { Decisions } from "./useDecisions";

/** 답한 뒤 다음 결정으로 넘어가거나 닫기까지(디자인 phase2 §3) */
export const ADVANCE_MS = 3000;
/** 자동으로 다음 결정이 열린 직후 답 입력을 무시하는 시간. Enter를 누르고 있어 다음 결정이 거부되는 것을 막는다 */
export const ADVANCE_GUARD_MS = 500;
const HOLD_S = 590;
const REASON_MAX = 200;

type Tone = "cyan" | "green" | "yellow" | "red";
interface Banner { tone: Tone; text: string; locked: boolean }

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function Avatar({ name, color }: { name: string; color?: string }) {
  const role = roleOf(name);
  // 셔츠 색은 책상과 같다(구성원 color, Desk의 shirtColor)
  const colors = { h: NEON.hair, s: NEON.skin, e: NEON.eye, c: shirtColor(role, color), p: NEON.pants, g: NEON.glasses, t: NEON.pink };
  return (
    <span className="rp-avatar" aria-hidden="true">
      <svg viewBox="0 0 8 7" shapeRendering="crispEdges">
        <PixelSprite rects={spriteRects(characterRows(role, "up").slice(0, 7), colors)} />
      </svg>
    </span>
  );
}

/** 요약 코드 상자(Phase 1 8.1): 최대 7.5em, 넘치면 전체 보기 / 접기 */
function CodeBox({ text }: { text: string }) {
  const box = useRef<HTMLPreElement>(null);
  const [over, setOver] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !full) setOver(el.scrollHeight > el.clientHeight + 1);
  }, [text, full]);
  return (
    <>
      <pre ref={box} className={`rp-code${full ? " full" : ""}`}>{text}</pre>
      {over && (
        <button type="button" className="rp-more" onClick={() => setFull((f) => !f)}>
          {full ? "접기" : "전체 보기"}
        </button>
      )}
    </>
  );
}

function Rows({ rows }: { rows: Array<[string, string | undefined]> }) {
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  if (shown.length === 0) return null;
  return (
    <dl className="rp-kv">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 하려는 일(§1.4, §2) */
function What({ v }: { v: DecisionView }) {
  if (v.kind === "question") return <Rows rows={[["질문", `${v.questions?.length ?? 0}개`]]} />;
  if (v.kind === "plan") {
    const empty = v.answerable ? "계획 본문이 없습니다. 터미널에서 확인해 주세요" : "계획 본문은 터미널에서 볼 수 있습니다";
    return (
      <div className="rp-plan" role="region" aria-label="계획 미리보기" tabIndex={0}>
        {v.plan ? <span className="rp-plan-text">{v.plan}</span> : empty}
        {v.planTruncated && <span className="rp-plan-cut">… 계획이 길어 앞부분만 보여 줍니다. 전체는 터미널에서 볼 수 있습니다</span>}
      </div>
    );
  }
  if (v.kind === "team") {
    return (
      <>
        <blockquote className="rp-quote">{v.detail.description}</blockquote>
        <Rows rows={[["받은 시각", hhmm(v.createdAt)]]} />
      </>
    );
  }
  const summary = summaryOf(v);
  return (
    <>
      {summary ? <CodeBox text={summary} /> : <p className="rp-empty">입력 요약이 없습니다</p>}
      <Rows
        rows={[
          ["설명", v.detail.description],
          ...(v.kind === "budget" && v.budget
            ? ([["예산", budgetLabel(v.budget.budgetTokens)], ["지금까지 쓴 양", usageLabel(v.budget.usedTokens)]] as Array<[string, string]>)
            : []),
        ]}
      />
    </>
  );
}

/**
 * 결정 보고서 서랍(디자인 phase2 §1–§5). 비모달이고 포커스를 가두지 않는다.
 * 알림은 App의 하나뿐인 role="status"(announce)로만 한다. 배너에는 role을 주지 않고, 보내기 실패만 role="alert"(Ruling B47).
 */
export function DecisionReport({ d, sessions, announce }: { d: Decisions; sessions: SessionView[]; announce(text: string): void }) {
  const v = d.view;
  const openPolicy = useContext(OpenPolicyContext);
  const [now, setNow] = useState(() => Date.now());
  const [reason, setReason] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const prevSec = useRef<{ id: string; secs: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  /** ‹ ›로 넘길 때는 포커스를 누른 버튼에 둔다(§4). 그 밖의 열기·넘어가기는 거부 버튼이나 제목으로 */
  const navFocus = useRef<"keep" | "title" | null>(null);
  const guardUntil = useRef(0);
  /** 답 보내기는 모두 여기를 거친다(자동 넘김 직후 0.5초는 무시) */
  const send = (a: Parameters<Decisions["send"]>[0]) => {
    if (Date.now() < guardUntil.current) return;
    d.send(a);
  };

  const pending = v?.state === "pending" && !d.vanished;
  const timed = !!v && v.answerable && pending;
  const secs = v && timed ? remainingSeconds(v.deadline, now) : null;

  // 매초 남은 시간(답할 수 있는 결정만, §1.3)
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timed, v?.id]);

  // 60초와 10초가 남는 순간에만 알린다(§9.5)
  useEffect(() => {
    // 같은 결정 안에서만 비교한다(결정이 바뀌면 그 결정의 첫 값부터)
    const p = prevSec.current;
    prevSec.current = v && secs !== null ? { id: v.id, secs } : null;
    if (!p || !v || p.id !== v.id || secs === null) return;
    if (p.secs > 60 && secs <= 60 && secs > 0) announce("1분 남았습니다");
    else if (p.secs > 10 && secs <= 10 && secs > 0) announce("10초 남았습니다");
  }, [secs, v?.id, announce]);

  // 결정이 바뀌면 입력을 비우고 포커스 규칙(§4)을 다시 적용한다. 자동 넘김은 타이머 안의 업데이트라
  // useEffect면 커밋 뒤로 미뤄지고, 그 틈에 Esc를 누르면 포커스가 body로 떨어진다(#180, diag 621f1c9와 같은 원인)
  useLayoutEffect(() => {
    if (!v) return;
    setReason("");
    const mode = navFocus.current;
    navFocus.current = null;
    if (mode === "keep") return;
    if (mode !== "title" && deny.current) deny.current.focus();
    else title.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.openId]);

  const s = d.sendState;
  let banner: Banner | null = null;
  if (v) {
    if (s.state === "sending") banner = { tone: "cyan", text: "보내는 중…", locked: false };
    else if (s.state === "failed") banner = { tone: "red", text: SEND_FAILED, locked: false };
    else if (s.state === "sent") banner = { tone: "green", text: outcomeLine(v.kind, s.outcome), locked: true };
    else if (s.state === "conflict") banner = { tone: "yellow", text: conflictLine(s.conflictState), locked: true };
    else if (d.vanished) banner = { tone: "yellow", text: VANISHED, locked: true };
    else if (v.state !== "pending") banner = { tone: v.state === "answered-dashboard" ? "green" : "yellow", text: resultLine(v), locked: true };
    else if (secs === 0) banner = { tone: "yellow", text: EXPIRED, locked: true };
  }
  const lockedText = banner?.locked ? banner.text : null;

  // 잠금 배너가 뜨면 한 번 알리고, 3초 뒤 다음 결정으로 넘어가거나 닫는다. 입력란에 포커스가 있으면 멈춘다(§3, Ruling B46)
  useEffect(() => {
    if (!lockedText || !v) return;
    announce(lockedText);
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (a && root.current?.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
      const nextV = d.pending.find((x) => x.id !== v.id);
      if (nextV) {
        guardUntil.current = Date.now() + ADVANCE_GUARD_MS;
        d.open(nextV.id);
        const sess = sessions.find((x) => x.id === nextV.sessionId);
        announce(`다음 결정: ${sess ? `${sess.name} ${nextV.agent}` : nextV.agent}, ${KIND_CHIP[nextV.kind]}`);
      } else d.close();
    }, ADVANCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedText, d.openId]);

  // Esc로 닫는다. 말풍선이 떠 있으면 말풍선이 먼저(Phase 1 규칙)
  useEffect(() => {
    if (!d.openId) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('.say[role="tooltip"]')) return;
      d.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [d.openId, d.close]);

  if (!d.openId || !v) return null;

  const session = sessions.find((x) => x.id === v.sessionId);
  // "권한" 버튼(phase3 §6.4): 그 결정의 에이전트 대상. 서브에이전트의 요청은 agent가 "team-lead"라 리드 패널이 된다
  const agentMember = session?.members.find((m) => m.name === v.agent);
  const policyKey = agentMember ? targetKeyOf(agentMember) : v.agent === "team-lead" ? "lead" : targetKeyOf({ name: v.agent, role: v.agent });
  const openPermissions = () => {
    // 보고서 닫기와 패널 열기를 한 핸들러에서 함께 바꾼다 — React가 한 번에 그려 서랍 서로 닫기 effect는 최종 상태만 본다(B108).
    // 연 요소는 그 에이전트의 책상(닫을 때 data-policy-key로 찾는다)
    d.close(false);
    openPolicy?.(policyKey, null);
  };
  const who = session ? `${session.floor}F ${session.name} · ${v.agent}` : v.agent;
  const busy = s.state === "sending" || !!banner?.locked;
  const answerable = v.answerable && pending;
  const act = (fn: () => void) => () => {
    if (!busy) fn();
  };
  const sendDeny = () => send({ action: "deny", ...(reason.trim() ? { reason: reason.trim() } : {}) });
  const onReasonKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy) sendDeny();
    }
  };
  const lockedProps = (extra?: string) => ({ "aria-disabled": busy || undefined, className: `pbtn${extra ? ` ${extra}` : ""}` });

  let answer: ReactNode = null;
  if (v.kind === "permission" || (v.kind === "plan" && v.answerable)) {
    const plan = v.kind === "plan";
    answer = answerable ? (
      <div className={`rp-answer${busy ? " locked" : ""}`}>
        <div className="rp-reason">
          <label htmlFor="rp-reason-input">{plan ? "고칠 점 (선택, Claude에게 전달됩니다)" : "거부 이유 (선택, Claude에게 전달됩니다)"}</label>
          {/* maxLength(UTF-16)는 이모지를 둘로 세므로 쓰지 않고, 서버와 같은 글자 단위로 자른다 */}
          <input id="rp-reason-input" type="text" value={reason} onChange={(e) => setReason(cutGraphemes(e.target.value, REASON_MAX))} onKeyDown={onReasonKey} />
          <span className="rp-count" aria-hidden="true">{`${graphemes(reason).length}/${REASON_MAX}`}</span>
        </div>
        <div className="rp-buttons">
          <button type="button" {...lockedProps("pbtn--primary")} onClick={act(() => send({ action: "allow" }))}>
            {plan ? "승인" : "허용"}
          </button>
          <button ref={deny} type="button" {...lockedProps("pbtn--deny")} onClick={act(sendDeny)}>
            거부
          </button>
        </div>
      </div>
    ) : null;
  } else if (v.kind === "budget") {
    answer = answerable ? (
      <div className={`rp-answer${busy ? " locked" : ""}`}>
        <p className="rp-note">
          계속을 누르면 이 도구 실행도 함께 허용됩니다
          <br />
          예산만큼 더 쓰면 다시 묻습니다
        </p>
        <div className="rp-buttons">
          <button type="button" {...lockedProps("pbtn--primary")} onClick={act(() => send({ action: "continue" }))}>
            계속
          </button>
          <button ref={deny} type="button" {...lockedProps("pbtn--deny")} onClick={act(() => send({ action: "stop" }))}>
            중단
          </button>
        </div>
      </div>
    ) : null;
  } else if (v.kind === "question") {
    // key로 결정마다 고른 상태를 새로 시작한다. 답은 인덱스로만 보낸다(Ruling B30)
    answer = answerable
      ? <QuestionForm key={v.id} questions={v.questions ?? []} disabled={busy} onSubmit={(answers) => send({ action: "answer", answers })} />
      : null;
  }
  if (!v.answerable) {
    answer = (
      <>
        <p className="rp-terminal">{v.kind === "team" ? "터미널(리드 세션)에서 답해 주세요" : "터미널에서 답해 주세요"}</p>
        {v.kind === "team" && <p className="rp-sub">리드가 이 팀원에게 메시지를 보내거나 30분이 지나면 손을 내립니다</p>}
      </>
    );
  }

  const urgent = secs !== null && secs <= 60;
  // 끝에 닿아 버튼이 비활성이 되면 제목으로 옮긴다(§4)
  const goPrev = () => {
    navFocus.current = d.index - 1 > 0 ? "keep" : "title";
    d.prev();
  };
  const goNext = () => {
    navFocus.current = d.index + 1 < d.total - 1 ? "keep" : "title";
    d.next();
  };
  return (
    <aside ref={root} id="decision-report" className="rp" role="dialog" aria-modal="false" aria-labelledby="rp-title" aria-describedby="rp-what">
      {timed && secs !== null && (
        <div className={`rp-timebar${urgent ? " urgent" : ""}`} aria-hidden="true">
          <span style={{ width: `${Math.min(100, (secs / HOLD_S) * 100)}%` }} />
        </div>
      )}
      <header className="rp-head">
        <Avatar name={v.agent} color={session?.members.find((m) => m.name === v.agent)?.color} />
        <div className="rp-headtext">
          <p className="rp-who">{who}</p>
          <h2 ref={title} id="rp-title" className="rp-title" tabIndex={-1}>
            {titleOf(v)}
          </h2>
          <p className="rp-meta">
            <span className="rp-chip">{KIND_CHIP[v.kind]}</span>
            {d.index >= 0 && <span className="rp-pos">{`${d.index + 1} / ${d.total}`}</span>}
            {timed && secs !== null && secs > 0 && (
              <span className={`rp-left${urgent ? " urgent" : ""}`} role="timer" aria-live="off">{`${remaining(v.deadline, now)} 남음 · 지나면 터미널에서 묻습니다`}</span>
            )}
            {openPolicy && (
              <button type="button" className="rp-perm" aria-label={`${targetLabel(policyKey)} 권한 정하기`} onClick={openPermissions}>
                <Icon name="lock" accent="#0e0d18" />
                권한
              </button>
            )}
          </p>
        </div>
        <div className="rp-nav">
          <button type="button" className="icon-btn" aria-label="이전 결정" disabled={d.index <= 0} onClick={goPrev}>
            <Icon name="prev" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="다음 결정"
            disabled={d.index >= 0 ? d.index >= d.total - 1 : d.total === 0}
            onClick={goNext}
          >
            <Icon name="next" />
          </button>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={() => d.close()}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      {banner && (
        <div className={`rp-banner ${banner.tone}`} {...(s.state === "failed" ? { role: "alert" } : {})}>
          <span>{banner.text}</span>
          {s.state === "failed" && (
            <button type="button" className="pbtn" onClick={d.retry}>
              다시 시도
            </button>
          )}
          {banner.locked && (
            <button type="button" className="pbtn" onClick={() => d.close()}>
              닫기
            </button>
          )}
        </div>
      )}
      <div className="rp-scroll">
        <section className="rp-sec" id="rp-what" aria-labelledby="rp-what-h">
          <h3 id="rp-what-h">하려는 일</h3>
          {/* 팀원 요청은 도구 호출이 아니므로 도구 줄을 그리지 않는다(명세 §1.4) */}
          {v.kind !== "team" && <p className="rp-tool">{`도구 ${v.toolName}`}</p>}
          <What v={v} />
        </section>
        <section className="rp-sec" aria-labelledby="rp-why-h">
          <h3 id="rp-why-h">이유</h3>
          <p className="rp-why">{whyLine(v)}</p>
        </section>
        {answer && (
          <section className="rp-sec" aria-labelledby="rp-ans-h">
            <h3 id="rp-ans-h">답하기</h3>
            {answer}
          </section>
        )}
      </div>
    </aside>
  );
}
