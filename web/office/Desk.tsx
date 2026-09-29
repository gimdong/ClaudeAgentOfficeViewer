import type { Member } from "../../src/shared/types";
import { formatTokens, stateLabel } from "../format";
import { NEON, roleOf, shirtColor } from "../pixel/palette";
import { PixelSprite } from "../pixel/PixelSprite";
import { characterRows, spriteRects } from "../pixel/sprites";
import { StatusBubble } from "./StatusBubble";

export function Desk({ member }: { member: Member }) {
  const role = roleOf(member.name);
  const colors = { h: NEON.hair, s: NEON.skin, e: NEON.eye, c: shirtColor(role, member.color), p: NEON.pants, g: NEON.glasses, t: NEON.pink };
  const working = member.state === "working";
  const screenOn = working || member.state === "mail";

  return (
    <div className={`desk state-${member.state}`} data-testid={`desk-${member.name}`} tabIndex={0}>
      <svg className="desk-svg" viewBox="0 0 24 30" shapeRendering="crispEdges" role="img" aria-label={`${member.name}: ${stateLabel(member.state)}`}>
        <g transform="translate(1,0)">
          <StatusBubble state={member.state} unread={member.unread} />
        </g>
        {member.state === "offline" ? (
          <g data-testid="empty-chair">
            <rect x={3} y={13} width={6} height={6} fill={NEON.deskDark} />
            <rect x={4} y={19} width={1} height={2} fill={NEON.deskDark} />
            <rect x={7} y={19} width={1} height={2} fill={NEON.deskDark} />
          </g>
        ) : (
          <g className="char">
            <PixelSprite rects={spriteRects(characterRows(role, "a"), colors)} x={2} y={9} className="frame-a" />
            {working && <PixelSprite rects={spriteRects(characterRows(role, "b"), colors)} x={2} y={9} className="frame-b" />}
          </g>
        )}
        <rect x={12} y={11} width={8} height={6} fill={NEON.monitor} />
        <rect data-testid="screen" x={13} y={12} width={6} height={4} fill={screenOn ? NEON.screenOn : NEON.screenOff} />
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
      <div className="desk-name">{member.name}</div>
      <div className="popover" role="tooltip">
        <div>
          <b>{member.name}</b> · {stateLabel(member.state)}
        </div>
        <div>모델: {member.model ?? "-"}</div>
        <div>토큰: {formatTokens(member.tokens.total)}</div>
        <div>최근 활동: {member.lastActivityAt ? new Date(member.lastActivityAt).toLocaleTimeString("ko-KR") : "-"}</div>
      </div>
    </div>
  );
}
