// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("주간 사용률이 더 높으면 PLAN은 주간 기준으로 표시한다", () => {
    const snap = makeSnapshot({ limits: { fiveHourPct: 10, weeklyPct: 95, source: "statusline" } });
    render(<Hud snapshot={snap} live />);
    // budget이 없으므로 5H·WEEK HeartBar는 meter가 없고 PLAN만 meter를 그린다.
    // "WEEK"/"5H" 문자열은 TokenCounter 라벨과도 겹치므로, PLAN heartbar 컨테이너(meter의 부모)로
    // 범위를 좁혀서 그 안의 hint만 확인한다.
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("5"); // 100 - 95
    expect(within(meter.parentElement!).getByText("WEEK")).toBeTruthy(); // PLAN 옆 hint가 더 많이 쓴 WEEK를 가리킨다
  });

  it("두 창의 사용률이 같으면 PLAN은 5H를 우선 표시한다", () => {
    const snap = makeSnapshot({ limits: { fiveHourPct: 50, weeklyPct: 50, source: "statusline" } });
    render(<Hud snapshot={snap} live />);
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("50");
    expect(within(meter.parentElement!).getByText("5H")).toBeTruthy();
  });
});
