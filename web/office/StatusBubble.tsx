import type { MemberState } from "../../src/shared/types";
import { NEON } from "../pixel/palette";

// decision은 말머리 대신 노란 ?를 그리므로(Task 10) 여기서는 그리지 않는다
const ICON: Record<MemberState, string> = { decision: "", working: "⌨", idle: "z z", mail: "✉", offline: "" };

export function StatusBubble({ state, unread }: { state: MemberState; unread: number }) {
  if (state === "offline" || state === "decision") return null;
  const text = state === "mail" && unread > 0 ? `${ICON.mail}${unread}` : ICON[state];
  return (
    <g className={`bubble bubble-${state}`}>
      <rect x={0} y={0} width={12} height={7} fill={NEON.yellow} />
      <rect x={3} y={7} width={2} height={1} fill={NEON.yellow} />
      <text data-testid="bubble" x={6} y={5.3} fontSize={4.5} textAnchor="middle" fill={NEON.wall} fontFamily="monospace">
        {text}
      </text>
    </g>
  );
}
