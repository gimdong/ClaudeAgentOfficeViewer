import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Member, Snapshot } from "../../src/shared/types";
import { Icon } from "../pixel/Icon";
import { NEON, roleOf, shirtColor } from "../pixel/palette";
import { PixelSprite } from "../pixel/PixelSprite";
import { characterRows, spriteRects } from "../pixel/sprites";
import { RuleEditor } from "./RuleEditor";
import { TEXT, countsLine, kindLabel, targetKeyOf, targetLabel } from "./text";
import type { Policy } from "./usePolicy";

/** 책상에서 연 리드·팀원은 그 캐릭터(손을 들지 않은 모습), 그 밖은 team 아이콘(디자인 §1.2) */
function Avatar({ member }: { member?: Member }) {
  if (!member) {
    return (
      <span className="rp-avatar ap-avatar--icon" aria-hidden="true">
        <Icon name="team" />
      </span>
    );
  }
  const role = roleOf(member.name);
  const colors = { h: NEON.hair, s: NEON.skin, e: NEON.eye, c: shirtColor(role, member.color), p: NEON.pants, g: NEON.glasses, t: NEON.pink };
  return (
    <span className="rp-avatar" aria-hidden="true">
      <svg viewBox="0 0 8 7" shapeRendering="crispEdges">
        <PixelSprite rects={spriteRects(characterRows(role, "a").slice(0, 7), colors)} />
      </svg>
    </span>
  );
}

const scopeOf = (key: string) => (key === "lead" ? TEXT.scopeLead : key === "others" ? TEXT.scopeOthers : TEXT.scopeNamed);

/** 에이전트 패널(디자인 phase3 §1–§3). 정책 목록(view: "list")은 Task 8이 그린다 */
export function AgentPanel({ policy, snapshot, announce }: { policy: Policy; snapshot: Snapshot; announce(text: string): void }) {
  const open = policy.open;
  const target = open?.view === "agent" ? open.target : null;
  const title = useRef<HTMLHeadingElement>(null);

  // 열 때와 대상이 바뀔 때 포커스는 제목(§7.2)
  useLayoutEffect(() => {
    if (target) title.current?.focus({ preventScroll: true });
  }, [target]);

  // Esc로 닫는다. 말풍선이 떠 있으면 말풍선이 먼저(Phase 1 규칙)
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('.say[role="tooltip"]')) return;
      policy.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, policy.close]);

  if (!target || open?.view !== "agent") return null;

  const members = snapshot.sessions.flatMap((s) => s.members);
  const leads = members.filter((m) => m.role === "lead");
  const subTypes = [...new Set(leads.flatMap((m) => m.subTypes ?? []))].sort();
  const member = target === "lead" ? leads[0] : target.startsWith("agent:") ? members.find((m) => m.role !== "lead" && targetKeyOf(m) === target) : undefined;
  const targets = snapshot.policy?.targets ?? {};
  const own = targets[target];
  const named = target.startsWith("agent:") || target.startsWith("sub:");
  const followsOthers = named && !own && !!targets.others;
  const notOnScreen = target.startsWith("agent:") ? !member : target.startsWith("sub:") ? !subTypes.includes(target.slice(4)) : false;
  const counts = snapshot.policy?.counts[target] ?? { denied: 0, asked: 0 };
  const label = targetLabel(target);
  const back = open.back;
  const backLabel = !back ? null : back.view === "list" ? "정책 목록으로 돌아가기" : back.target === "lead" ? "리드 권한으로 돌아가기" : `${targetLabel(back.target)} 권한으로 돌아가기`;
  const goTo = (next: string) => policy.openAgent(next, undefined, { view: "agent", target });

  const before = (target !== "others" || notOnScreen) && (
    <section className="rp-sec ap-notes">
      {notOnScreen && <p className="ap-note">{TEXT.notOnScreen}</p>}
      {target !== "others" && (
        <>
          <p className={`ap-counts${counts.denied || counts.asked ? "" : " zero"}`}>{counts.denied || counts.asked ? countsLine(counts.denied, counts.asked) : TEXT.countsZero}</p>
          <p className="ap-sub">{TEXT.countsNote}</p>
        </>
      )}
      {followsOthers && (
        <>
          <p className="ap-note">{TEXT.followsOthers}</p>
          <button type="button" className="rp-more" onClick={() => goTo("others")}>
            {TEXT.othersLink}
          </button>
          <p className="ap-help">{TEXT.othersWarn}</p>
        </>
      )}
    </section>
  );

  const after = target === "lead" && (
    <section className="rp-sec" aria-labelledby="ap-subs-h">
      <h3 id="ap-subs-h">{TEXT.secSubs}</h3>
      <p className="ap-help">{TEXT.subsHelp}</p>
      {subTypes.length === 0 && <p className="ap-help">{TEXT.subsNone}</p>}
      <div className="ap-subs">
        {[...subTypes.map((t) => `sub:${t}`), "others"].map((k) => (
          <button key={k} type="button" className="pbtn ap-subbtn" title={targetLabel(k)} aria-label={`${targetLabel(k)} 권한 정하기`} onClick={() => goTo(k)}>
            {targets[k] && <Icon name="lock" accent="#0e0d18" />}
            <span>{k === "others" ? targetLabel(k) : k.slice(4)}</span>
          </button>
        ))}
      </div>
    </section>
  );

  return createPortal(
    <aside id="agent-panel" className="rp ap" role="dialog" aria-modal="false" aria-labelledby="ap-title">
      <header className="rp-head">
        <Avatar member={member} />
        <div className="rp-headtext">
          <p className="rp-meta ap-meta">
            <span className="rp-chip ap-chip">{kindLabel(target)}</span>
          </p>
          <h2 ref={title} id="ap-title" className="rp-title ap-title" tabIndex={-1}>
            {label}
          </h2>
          <p className="ap-scope">{scopeOf(target)}</p>
        </div>
        <div className="rp-nav">
          {backLabel && (
            <button type="button" className="icon-btn" aria-label={backLabel} onClick={policy.goBack}>
              <Icon name="prev" />
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="닫기" onClick={() => policy.close()}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      <RuleEditor key={target} target={target} saved={own ?? {}} onSave={(rules) => policy.save(target, rules)} announce={announce} before={before} after={after} />
    </aside>,
    document.body,
  );
}
