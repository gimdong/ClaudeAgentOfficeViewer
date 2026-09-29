import type { SessionView } from "../../src/shared/types";
import { HeartBar } from "../hud/HeartBar";
import { NEON } from "../pixel/palette";
import { Desk } from "./Desk";

function Backdrop() {
  return (
    <svg className="office-bg" viewBox="0 0 80 12" shapeRendering="crispEdges" aria-hidden="true">
      <rect x={4} y={1} width={14} height={9} fill={NEON.desk} />
      <rect x={5} y={2} width={12} height={7} fill="#0b0a1a" />
      <rect x={10} y={2} width={1} height={7} fill={NEON.desk} />
      <rect x={7} y={3} width={1} height={1} fill={NEON.yellow} />
      <rect x={14} y={6} width={1} height={1} fill={NEON.yellow} />
      <rect x={60} y={1} width={6} height={6} fill={NEON.desk} />
      <rect x={61} y={2} width={4} height={4} fill={NEON.yellow} />
      <rect x={63} y={3} width={1} height={2} fill={NEON.wall} />
      <rect x={72} y={4} width={3} height={2} fill={NEON.green} />
      <rect x={71} y={6} width={5} height={5} fill={NEON.pink} />
    </svg>
  );
}

export function OfficeTile({ session }: { session: SessionView }) {
  const ctx = session.context;
  return (
    <section className={`office${session.alive ? "" : " off"}`} data-testid="office" aria-label={`${session.name} 사무실`}>
      <div className="office-head">
        <span className="office-name" title={session.cwd}>
          {session.isCurrent && <span className="star">★</span>}
          {session.name}
        </span>
        {session.stale && <span className="stale">⚠ 갱신 지연</span>}
      </div>
      <Backdrop />
      <div className="desks">
        {session.members.map((m) => (
          <Desk key={m.name} member={m} />
        ))}
      </div>
      <div className="ctx">
        {ctx ? (
          <HeartBar label="CTX" remaining={100 - ctx.pct} emptyText="" hint={ctx.estimated ? "추정" : undefined} />
        ) : (
          <div className="heartbar-empty">CTX --</div>
        )}
      </div>
    </section>
  );
}
