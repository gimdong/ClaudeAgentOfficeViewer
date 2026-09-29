// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Desk } from "../../web/office/Desk";
import { OfficeGrid } from "../../web/office/OfficeGrid";
import { OfficeTile } from "../../web/office/OfficeTile";
import { NEON } from "../../web/pixel/palette";
import { makeMember, makeSession } from "./fixtures";

afterEach(cleanup);

describe("Desk", () => {
  it("working: ⌨ 말풍선, 켜진 모니터, 타이핑 프레임", () => {
    render(<Desk member={makeMember({ state: "working" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.className).toContain("state-working");
    expect(within(desk).getByTestId("bubble").textContent).toBe("⌨");
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOn);
    expect(desk.querySelector(".frame-b")).not.toBeNull();
  });

  it("idle: z z 말풍선, 꺼진 모니터, 타이핑 프레임 없음", () => {
    render(<Desk member={makeMember({ state: "idle" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).getByTestId("bubble").textContent).toBe("z z");
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOff);
    expect(desk.querySelector(".frame-b")).toBeNull();
  });

  it("mail: ✉와 안 읽은 개수", () => {
    render(<Desk member={makeMember({ state: "mail", unread: 2 })} />);
    expect(within(screen.getByTestId("desk-developer")).getByTestId("bubble").textContent).toBe("✉2");
  });

  it("offline: 빈 의자, 말풍선 없음", () => {
    render(<Desk member={makeMember({ state: "offline" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(within(desk).getByTestId("empty-chair")).toBeTruthy();
  });

  it("popover에 모델·토큰을 보여준다", () => {
    render(<Desk member={makeMember({ model: "sonnet", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 12345 } })} />);
    const pop = screen.getByRole("tooltip");
    expect(pop.textContent).toContain("모델: sonnet");
    expect(pop.textContent).toContain("토큰: 12.3k");
  });
});

describe("OfficeTile", () => {
  it("현재 세션 별표, CTX 잔여 바, 추정 표시", () => {
    render(<OfficeTile session={makeSession({ isCurrent: true, context: { used: 60000, window: 200000, pct: 30, estimated: true } })} />);
    const tile = screen.getByTestId("office");
    expect(tile.textContent).toContain("★");
    expect(within(tile).getByRole("meter").getAttribute("aria-valuenow")).toBe("70");
    expect(tile.textContent).toContain("추정");
  });

  it("종료된 세션은 off 클래스, stale이면 경고, context가 없으면 --", () => {
    render(<OfficeTile session={makeSession({ alive: false, stale: true, context: null })} />);
    const tile = screen.getByTestId("office");
    expect(tile.className).toContain("off");
    expect(tile.textContent).toContain("갱신 지연");
    expect(tile.textContent).toContain("CTX --");
  });

  it("팀원 수만큼 책상을 그린다", () => {
    render(<OfficeTile session={makeSession({ members: [makeMember({ name: "team-lead" }), makeMember({ name: "developer" }), makeMember({ name: "reviewer" })] })} />);
    expect(screen.getAllByTestId(/^desk-/)).toHaveLength(3);
  });
});

describe("OfficeGrid", () => {
  it("세션이 없으면 안내 문구", () => {
    render(<OfficeGrid sessions={[]} />);
    expect(screen.getByText("실행 중인 Claude Code 세션이 없습니다")).toBeTruthy();
  });

  it("세션 순서대로 타일을 그린다", () => {
    render(<OfficeGrid sessions={[makeSession({ id: "a", name: "first" }), makeSession({ id: "b", name: "second" })]} />);
    expect(screen.getAllByTestId("office").map((t) => t.getAttribute("aria-label"))).toEqual(["first 사무실", "second 사무실"]);
  });
});
