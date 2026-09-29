// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { barLevel, HeartBar } from "../../web/hud/HeartBar";
import { Hud } from "../../web/hud/Hud";
import { emptySum } from "../../src/shared/tokens";
import { makeSnapshot } from "./fixtures";

afterEach(cleanup);

describe("barLevel", () => {
  it.each([[100, "ok"], [50, "ok"], [49.9, "warn"], [20, "warn"], [19.9, "danger"], [0, "danger"]] as const)("%d → %s", (r, level) => {
    expect(barLevel(r)).toBe(level);
  });
});

describe("HeartBar", () => {
  it("값이 있으면 meter와 레벨 클래스를 그린다", () => {
    render(<HeartBar label="5H" remaining={12.4} emptyText="-- 설정 필요" />);
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("12");
    expect(meter.className).toContain("level-danger");
  });

  it("값이 없으면 대체 문구", () => {
    render(<HeartBar label="PLAN" remaining={null} emptyText="-- 데이터 없음" />);
    expect(screen.getByText("-- 데이터 없음")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });
});

describe("Hud", () => {
  it("예산과 한도가 없으면 대체 문구를 보여준다", () => {
    render(<Hud snapshot={makeSnapshot()} live={false} />);
    expect(screen.getAllByText("-- 설정 필요")).toHaveLength(2);
    expect(screen.getByText("-- 데이터 없음")).toBeTruthy();
    expect(screen.getByText("○ 재연결 중")).toBeTruthy();
  });

  it("예산·한도로 잔여량을 계산하고 토큰·캐시 읽기를 표시한다", () => {
    const snap = makeSnapshot({
      usage: {
        today: { ...emptySum(), cacheRead: 5000, total: 1_240_000 },
        last5h: { ...emptySum(), total: 900 },
        last7d: { ...emptySum(), total: 2500 },
        byModel: [],
        hourly: [],
      },
      budget: { fiveHour: 1000, weekly: 10000 },
      limits: { fiveHourPct: 40, source: "statusline" },
    });
    render(<Hud snapshot={snap} live />);
    const meters = screen.getAllByRole("meter");
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual(["10", "75", "60"]);
    expect(screen.getByLabelText("TODAY 1240000")).toBeTruthy();
    expect(screen.getByText("1.24M")).toBeTruthy();
    expect(screen.getByText("캐시 읽기 5.0k")).toBeTruthy();
    expect(screen.getByText("● LIVE")).toBeTruthy();
  });
});
