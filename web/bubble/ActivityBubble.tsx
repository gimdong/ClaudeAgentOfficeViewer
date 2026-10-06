import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Member, SessionView } from "../../src/shared/types";
import { activityLine, metaLine } from "../office/activityText";
import { Icon } from "../pixel/Icon";
import { NEON } from "../pixel/palette";
import { placeBubble, type Placement } from "./place";
import type { BubbleTarget } from "./useBubble";

function findMember(sessions: SessionView[], key: string): Member | undefined {
  const i = key.indexOf(":");
  const sessionId = key.slice(0, i);
  const name = key.slice(i + 1);
  return sessions.find((s) => s.id === sessionId)?.members.find((m) => m.name === name);
}

/** 모든 책상이 함께 쓰는 fixed 말풍선 하나(디자인 7.1). 등장 애니메이션은 없다 */
export function ActivityBubble({ target, sessions }: { target: BubbleTarget | null; sessions: SessionView[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const member = target ? findMember(sessions, target.key) : undefined;
  const line = member ? activityLine(member) : undefined;
  const meta = member ? metaLine(member, now) : "";

  // "{경과}초째"가 흐르도록 보이는 동안 1초마다 다시 그린다
  useEffect(() => {
    if (!target) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);

  useEffect(() => {
    if (!target || !member) return;
    target.el.setAttribute("aria-describedby", "say");
    return () => target.el.removeAttribute("aria-describedby");
  }, [target, member]);

  // 내용이 바뀌면(SSE) 위치를 다시 계산한다(디자인 7.5)
  useLayoutEffect(() => {
    if (!target || !ref.current) return;
    const r = target.el.getBoundingClientRect();
    const hudBottom = document.querySelector(".hud")?.getBoundingClientRect().bottom ?? 0;
    setPlace(placeBubble({ deskLeft: r.left, deskTop: r.top, w: ref.current.offsetWidth, h: ref.current.offsetHeight, viewportW: window.innerWidth, hudBottom }));
  }, [target, line?.text, meta]);

  if (!target || !member || !line) return null;
  return (
    <div
      ref={ref}
      id="say"
      role="tooltip"
      className={`say${line.decision ? " q" : ""}${place?.below ? " below" : ""}`}
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: 0 }}
    >
      <div className="line">
        {line.blocked ? (
          <Icon name="lock" ink={NEON.pink} accent="#0e0d18" />
        ) : (
          <Icon name={line.icon} ink={line.decision ? NEON.yellow : NEON.cyan} accent={line.decision ? NEON.yellow : NEON.green} />
        )}
        <span className="text">{line.text}</span>
      </div>
      <div className="meta">{meta}</div>
      <span className="tail" style={{ left: place?.tailX ?? 12 }} />
    </div>
  );
}
