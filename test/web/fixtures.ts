import type { Member, SessionView, Snapshot } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";

export function makeMember(p: Partial<Member> = {}): Member {
  return { name: "developer", role: "developer", state: "idle", unread: 0, tokens: emptySum(), ...p };
}

export function makeSession(p: Partial<SessionView> = {}): SessionView {
  return { id: "s1", name: "alpha", cwd: "/x", alive: true, isCurrent: false, status: "idle", floor: 1, floorStatus: "idle", context: null, members: [makeMember({ name: "team-lead", role: "lead" })], ...p };
}

export function makeSnapshot(p: Partial<Snapshot> = {}): Snapshot {
  return {
    generatedAt: "2026-09-28T00:00:00.000Z",
    usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: new Array(24).fill(0) },
    budget: {},
    limits: null,
    sessions: [],
    decisionCount: 0,
    decisions: [],
    ...p,
  };
}
