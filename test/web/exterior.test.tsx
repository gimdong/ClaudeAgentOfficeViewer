// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Building } from "../../web/building/Building";
import { Floor } from "../../web/building/Floor";
import { Elevator } from "../../web/hud/Elevator";
import { IDLE_WALK_MS } from "../../web/office/pantryPlan";
import { makeMember, makeSession } from "./fixtures";

// Phase 7 Task 7(계약 docs/design/phase7/SPEC.md §2·§7): 건물 바깥 — 하늘·옥상·빈 층·세션 층·카페·로비·거리, 장식은 aria-hidden,
// 행인 ≤ 2·차 ≤ 2, 화면 밖 줄은 .floor--offscreen으로 애니메이션 멈춤
const CSS = readFileSync(join(__dirname, "../../web/styles.css"), "utf8");

/** 가짜 IntersectionObserver: 테스트가 줄마다 보임·안 보임을 정한다 */
const observed = new Map<Element, (entries: Array<{ target: Element; isIntersecting: boolean }>) => void>();
class FakeIO {
  constructor(private cb: (e: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
  observe(el: Element) {
    observed.set(el, this.cb);
  }
  unobserve(el: Element) {
    observed.delete(el);
  }
  disconnect() {}
}
const setVisible = (el: Element, v: boolean) => act(() => observed.get(el)!([{ target: el, isIntersecting: v }]));

beforeEach(() => {
  observed.clear();
  vi.stubGlobal("IntersectionObserver", FakeIO);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sessions = [makeSession({ id: "s1", name: "old", floor: 1 }), makeSession({ id: "s2", name: "new", floor: 2, members: [makeMember({ name: "a" })] })];
const rows = () => [...document.querySelectorAll(".tower > section")];

describe("건물 바깥(Task 7)", () => {
  it("세로 순서: 옥상 → 빈 층 → 세션 층(위가 최신) → 카페 → 로비, 그 아래 거리. 하늘·스카이라인은 탑 뒤", () => {
    render(<Building sessions={sessions} />);
    expect(rows().map((r) => r.getAttribute("data-row") ?? r.getAttribute("aria-label") ?? r.getAttribute("data-testid"))).toEqual(["roof", "빈 층", "floor", "floor", "cafe", "lobby"]);
    // 카페·로비는 영역(landmark)이 아니다 — 접근 이름 없음(reviewer m1). 옥상은 간판 버튼이 있어 "옥상" 영역(P7b-3)
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual(["옥상", "빈 층", null, null, null, null]);
    expect(rows().map((r) => r.querySelector(".shaft")?.getAttribute("data-lift"))).toEqual(["roof", "vacant", "2", "1", "cafe", "lobby"]);
    const main = screen.getByRole("main");
    const kids = [...main.children].map((c) => c.className.split(" ")[0]);
    expect(kids.indexOf("street")).toBeGreaterThan(kids.indexOf("tower"));
    expect(kids.indexOf("sky")).toBeLessThan(kids.indexOf("tower"));
    expect(document.querySelector(".tower > .elevator-layer")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("카페·로비는 층 번호가 아니라 낱말(테마 words), 관리실 판", () => {
    render(<Building sessions={sessions} />);
    const cafe = screen.getByTestId("cafe-floor"), lobby = screen.getByTestId("lobby-floor");
    expect(cafe.querySelector(".fl-no")?.textContent).toBe("카페");
    expect(lobby.querySelector(".fl-no")?.textContent).toBe("로비");
    expect(lobby.querySelector(".booth-label")?.textContent).toBe("관리실");
    expect(cafe.querySelectorAll(".cafe-seat")).toHaveLength(2);
    // designer-office 판정(06b8b2d): 방 안 "카페" 판(M6), 360에서 숨는 칸(opt) = 손님 테이블(M7)·바리케이드(I1), 난간 반복 타일(M5)
    expect(cafe.querySelector(".cafe-tag")?.textContent).toBe("카페");
    expect(cafe.querySelector(".table.guest")!.classList.contains("opt")).toBe(true);
    expect(document.querySelector(".construction .push")!.classList.contains("opt")).toBe(true);
    expect((document.querySelector(".parapet") as HTMLElement).style.getPropertyValue("--rail")).toContain("roof-railing-");
  });

  it("HUD 엘리베이터 버튼은 세션 층뿐(카페·로비·옥상 없음)", () => {
    render(<Elevator sessions={sessions} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["2F", "1F"]);
  });

  it("장식(하늘·거리·옥상 소품·공사 중·카페·로비 그림·엑스트라)은 aria-hidden이고 tab으로 닿지 않는다", () => {
    render(<Building sessions={sessions} />);
    const deco = [".sky", ".skyline", ".street", ".roof-props", ".construction", ".cafe-scene", ".lobby-scene"].map((q) => document.querySelector(q));
    for (const [i, el] of deco.entries()) {
      expect(el, String(i)).not.toBeNull();
      expect(el!.closest('[aria-hidden="true"]'), String(i)).not.toBeNull();
      expect(el!.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);
    }
    expect(document.querySelectorAll(".extra").length).toBeGreaterThanOrEqual(3); // 바리스타·손님·경비
  });

  it("행인 ≤ 2, 차 ≤ 2", () => {
    render(<Building sessions={sessions} />);
    expect(document.querySelectorAll(".street .walker").length).toBeLessThanOrEqual(2);
    expect(document.querySelectorAll(".street .car").length).toBeLessThanOrEqual(2);
    expect(document.querySelectorAll(".street .walker").length).toBeGreaterThan(0);
  });

  it("offscreen floors pause animation — 층 30·팀원 30: 안 보이는 줄·길에 .floor--offscreen, 다시 보이면 뗌", () => {
    const many = Array.from({ length: 30 }, (_, i) => makeSession({ id: `f${i}`, name: `f${i}`, floor: i + 1, members: Array.from({ length: 30 }, (_, j) => makeMember({ name: `m${j}`, state: j % 2 ? "working" : "idle" })) }));
    render(<Building sessions={many} />);
    const floors = screen.getAllByTestId("floor");
    expect(floors).toHaveLength(30);
    const street = document.querySelector(".street")!;
    for (const el of [floors[29], screen.getByTestId("cafe-floor"), street]) {
      expect(observed.has(el)).toBe(true);
      setVisible(el, false);
      expect(el.classList.contains("floor--offscreen")).toBe(true);
    }
    setVisible(floors[29], true);
    expect(floors[29].classList.contains("floor--offscreen")).toBe(false);
    // CSS: 안 보이는 줄 안의 애니메이션은 모두 멈춤
    expect(CSS).toMatch(/\.floor--offscreen \*[^{]*\{[^}]*animation-play-state:\s*paused/);
  });

  it("움직임 줄이기면 장식 애니메이션 없음(전역 규칙) — 행인·차는 제자리 정지", () => {
    const reduced = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/animation:\s*none\s*!important/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.street \.walker, \.street \.car \{[^}]*transform:\s*translateX\(var\(--x0/);
  });

  it("화면 밖 층의 탕비실 걷기는 걷지 않고 바로 목적지(7a에서 넘어옴)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-27T00:00:00.000Z"));
    const idle = makeMember({ name: "dev", state: "idle", lastActivityAt: new Date(Date.now()).toISOString() });
    render(<Floor session={makeSession({ members: [makeMember({ name: "team-lead", role: "lead", state: "working" }), idle] })} />);
    setVisible(screen.getByTestId("floor"), false);
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    expect(document.querySelectorAll(".walk-layer .character")).toHaveLength(0);
    expect([...document.querySelectorAll(".pantry-scene .character")].map((c) => c.getAttribute("data-action"))).toEqual(["coffee"]);
    vi.useRealTimers();
  });
});
