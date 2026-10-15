import type { SubagentDesk } from "../../src/shared/types";
import { formatTokens, modelLabel } from "../format";
import { NEON } from "../pixel/palette";
import { PixelSprite } from "../pixel/PixelSprite";
import { characterRows, spriteRects } from "../pixel/sprites";

/** 임시 책상 문구(docs/design/subagent-desks/SPEC.md 문구표, B174) */
export const SUB_TEXT = {
  tag: "임시",
  noName: "서브에이전트",
  noType: "종류 모름",
  done: "끝남",
  what: "서브에이전트(리드가 잠깐 부른 도우미)",
  task: (d: string) => `맡긴 일: ${d}`,
  more: (n: number) => `서브에이전트 ${n}명 더`,
};

/** 최대 4개, 넘치면 +N(§7) */
export const SUB_MAX = 4;
const MUTED = "#9d97c7"; // --muted: 역할색과 겹치지 않는 셔츠(§4)

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function Sub({ s, paused }: { s: SubagentDesk; paused: boolean }) {
  const type = s.type || SUB_TEXT.noType;
  const task = oneLine(s.description);
  const model = s.model ? modelLabel(s.model) : "";
  const tokens = model || s.tokens > 0 ? formatTokens(s.tokens) : "";
  const working = s.working && !paused;
  const done = !s.working;
  const meta2 = [model, tokens].filter(Boolean).join(" · ");
  const tip = [SUB_TEXT.what, task && SUB_TEXT.task(task), [type, model, tokens && `토큰 ${tokens}`, done && SUB_TEXT.done].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
  const label = done
    ? ["임시 책상", `서브에이전트 ${type}`, task && SUB_TEXT.task(task), SUB_TEXT.done]
    : ["임시 책상", `서브에이전트 ${type}`, "일하는 중", task && SUB_TEXT.task(task), model, tokens && `토큰 ${tokens}`];
  const colors = { h: NEON.hair, s: NEON.skin, e: NEON.eye, c: MUTED, p: NEON.pants, g: NEON.glasses, t: NEON.pink };
  return (
    // 누를 수 없는 책상: 포커스를 받지 않고 말풍선도 띄우지 않는다(§6). 한 일은 리드 말풍선에 합쳐 보인다
    <div className={`desk desk--sub state-${working ? "working" : "idle"}${done ? " desk--sub-done" : ""}`} role="img" aria-label={label.filter(Boolean).join(", ")} title={tip}>
      <span className="sub-tag" aria-hidden="true">
        {SUB_TEXT.tag}
      </span>
      <svg className="desk-svg" viewBox="0 0 24 30" shapeRendering="crispEdges" aria-hidden="true">
        {working ? (
          <g className="char">
            <PixelSprite rects={spriteRects(characterRows("generic", "a"), colors)} x={2} y={9} className="frame-a" />
            <PixelSprite rects={spriteRects(characterRows("generic", "b"), colors)} x={2} y={9} className="frame-b" />
          </g>
        ) : (
          // 끝남·휴업 층은 빈 의자(지금 퇴근 모양)
          <g data-testid="empty-chair">
            <rect x={3} y={13} width={6} height={6} fill={NEON.deskDark} />
            <rect x={4} y={19} width={1} height={2} fill={NEON.deskDark} />
            <rect x={7} y={19} width={1} height={2} fill={NEON.deskDark} />
          </g>
        )}
        <rect x={12} y={11} width={8} height={6} fill={NEON.monitor} />
        <rect data-testid="screen" x={13} y={12} width={6} height={4} fill={working ? NEON.screenOn : NEON.screenOff} />
        {working && (
          <g className="code">
            <rect x={14} y={13} width={3} height={1} fill={NEON.monitor} />
            <rect x={14} y={14} width={4} height={1} fill={NEON.monitor} />
          </g>
        )}
        <rect x={15} y={17} width={2} height={2} fill={NEON.monitor} />
        <rect x={0} y={19} width={24} height={2} fill={NEON.desk} />
        <rect x={1} y={21} width={2} height={8} fill={NEON.deskDark} />
        <rect x={21} y={21} width={2} height={8} fill={NEON.deskDark} />
      </svg>
      <span className="nametag">{task || s.type || SUB_TEXT.noName}</span>
      <span className="desk-meta">
        <span>{done ? `${type} · ${SUB_TEXT.done}` : type}</span>
        {meta2 && <span>{meta2}</span>}
      </span>
    </div>
  );
}

/** 리드 책상 오른쪽 임시 책상 묶음(§1). 순서는 서버가 정한다(일하는 중 먼저, 먼저 시작한 것부터 — B175) */
export function SubDesks({ list, paused }: { list: readonly SubagentDesk[]; paused: boolean }) {
  if (list.length === 0) return null;
  const rest = list.length - SUB_MAX;
  return (
    <div className="sub-desks">
      {list.slice(0, SUB_MAX).map((s) => (
        <Sub key={s.id} s={s} paused={paused} />
      ))}
      {rest > 0 && (
        <span className="chip sub-more" role="img" aria-label={SUB_TEXT.more(rest)} title={SUB_TEXT.more(rest)}>
          +{rest}
        </span>
      )}
    </div>
  );
}
