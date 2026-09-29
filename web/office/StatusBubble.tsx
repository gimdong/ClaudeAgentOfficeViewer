import type { MemberState } from "../../src/shared/types";
import { NEON } from "../pixel/palette";

const ICON: Record<MemberState, string> = { working: "⌨", idle: "z z", mail: "✉", offline: "" };

export function StatusBubble({ state, unread }: { state: MemberState; unread: number }) {
  if (state === "offline") return null;
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
