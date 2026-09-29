import { describe, expect, it } from "vitest";
import { NEON, roleOf, shirtColor } from "../../web/pixel/palette";
import { characterRows, spriteRects } from "../../web/pixel/sprites";
import { formatTokens, remainingPct, stateLabel } from "../../web/format";

describe("palette", () => {
  it.each([
    ["team-lead", "lead"], ["director", "lead"], ["supervisor", "lead"],
    ["developer", "dev"], ["implementer", "dev"],
    ["reviewer", "reviewer"], ["code-reviewer", "reviewer"],
    ["researcher", "generic"],
  ])("roleOf(%s) = %s", (name, role) => {
    expect(roleOf(name)).toBe(role);
  });

  it("역할 셔츠 색이 우선이고, generic은 config color를 쓴다", () => {
    expect(shirtColor("dev", "blue")).toBe(NEON.green);
    expect(shirtColor("generic", "blue")).toBe(NEON.cyan);
    expect(shirtColor("generic", "unknown")).toBe(NEON.yellow);
    expect(shirtColor("generic")).toBe(NEON.yellow);
  });
});

describe("sprites", () => {
  it("모든 프레임은 8×10이다", () => {
    for (const role of ["lead", "dev", "reviewer", "generic"] as const) {
      for (const frame of ["a", "b"] as const) {
        const rows = characterRows(role, frame);
        expect(rows).toHaveLength(10);
        rows.forEach((r) => expect(r).toHaveLength(8));
      }
    }
  });

  it("리뷰어는 안경(g), 리드는 넥타이(t), 타이핑 프레임은 손(s)이 올라간다", () => {
    expect(characterRows("reviewer", "a").join("")).toContain("g");
    expect(characterRows("lead", "a").join("")).toContain("t");
    expect(characterRows("dev", "a")).not.toEqual(characterRows("dev", "b"));
    expect(characterRows("dev", "b")[7]).toMatch(/^s.*s$/);
  });

  it("spriteRects는 팔레트에 있는 문자만 사각형으로 만든다", () => {
    const rects = spriteRects(["a.b", ".a."], { a: "#111", b: "#222" });
    expect(rects).toEqual([{ x: 0, y: 0, c: "#111" }, { x: 2, y: 0, c: "#222" }, { x: 1, y: 1, c: "#111" }]);
  });
});

describe("format", () => {
  it("formatTokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(1_240_000)).toBe("1.24M");
  });

  it("remainingPct는 0~100", () => {
    expect(remainingPct(250, 1000)).toBe(75);
    expect(remainingPct(2000, 1000)).toBe(0);
  });

  it("stateLabel", () => {
    expect(stateLabel("working")).toBe("작업 중");
    expect(stateLabel("idle")).toBe("대기");
    expect(stateLabel("mail")).toBe("메시지 수신");
    expect(stateLabel("offline")).toBe("종료");
  });

  // director 검토 관점(미리 알림): 0·음수·NaN·큰 수에서 죽지 않는지 확인한다.
  // brief가 준 구현을 그대로 쓰므로, 여기서는 실제 동작을 기록해 report에 남긴다(값이 바뀌면
  // 이 테스트가 그 변화를 드러낸다).
  it("formatTokens 경계값: 0, 음수, 큰 수는 예외 없이 문자열을 만든다", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-50)).toBe("-50");
    expect(formatTokens(1e12)).toBe("1000000.00M");
  });

  it("formatTokens(NaN)은 예외를 던지지 않지만 'NaNM'을 만든다(알려진 한계, report 참고)", () => {
    expect(formatTokens(NaN)).toBe("NaNM");
  });

  it("remainingPct 경계값: 음수 used, budget 초과는 0~100으로 자른다", () => {
    expect(remainingPct(-100, 1000)).toBe(100);
    expect(remainingPct(100, 0)).toBe(0);
  });

  it("remainingPct(0,0)과 NaN 입력은 예외 없이 NaN을 만든다(알려진 한계, report 참고)", () => {
    expect(remainingPct(0, 0)).toBeNaN();
    expect(remainingPct(NaN, 1000)).toBeNaN();
  });
});
