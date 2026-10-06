// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Icon } from "../../web/pixel/Icon";
import { NEON } from "../../web/pixel/palette";
import { BODY_UP, characterRows, ICONS, QMARK, QRING } from "../../web/pixel/sprites";

afterEach(cleanup);

describe("손들기 스프라이트 (디자인 4.2)", () => {
  it("BODY_UP은 명세의 맵 그대로다", () => {
    expect(BODY_UP).toEqual(["..hhhh.s", ".hhhhhhs", ".hsssssc", ".sessesc", ".ssssssc", "..ssss.c", ".ccccccc", "ccccccc.", "cc.cc.c.", ".pp..pp."]);
  });

  it("역할별 덮어쓰기: reviewer 안경, lead 넥타이", () => {
    expect(characterRows("reviewer", "up")[3]).toBe(".geggegc");
    const lead = characterRows("lead", "up");
    expect(lead[6]).toBe(".ccttccc");
    expect(lead[7]).toBe("cccttcc.");
    expect(characterRows("dev", "up")).toEqual(BODY_UP);
  });

  it("v1 프레임은 바뀌지 않는다", () => {
    expect(characterRows("lead", "a")[7]).toBe("cccttccc");
    expect(characterRows("lead", "b")[7]).toBe("sccttccs");
  });
});

describe("? 와 링 (디자인 4.3)", () => {
  it("QMARK는 6×8, QRING은 10×10", () => {
    expect(QMARK).toHaveLength(8);
    expect(QMARK.every((r) => r.length === 6)).toBe(true);
    expect(QMARK[0]).toBe(".yyyy.");
    expect(QRING).toHaveLength(10);
    expect(QRING.every((r) => r.length === 10)).toBe(true);
    expect(QRING[9]).toBe(".y.y.y.y.y");
  });
});

describe("아이콘 (디자인 4.5)", () => {
  it("21개 모두 7×7이고 x, a, . 만 쓴다(경광등 siren만 받침 b를 더 쓴다, phase2 §0)", () => {
    expect(Object.keys(ICONS)).toHaveLength(21);
    for (const [name, rows] of Object.entries(ICONS)) {
      expect(rows).toHaveLength(7);
      for (const r of rows) expect(r).toMatch(name === "siren" ? /^[xab.]{7}$/ : /^[xa.]{7}$/);
    }
    expect(ICONS.ask[0]).toBe(".aaaa..");
  });

  it("Icon은 aria-hidden SVG이고 x는 ink, a는 accent 색이다", () => {
    const { container } = render(<Icon name="bash" ink={NEON.cyan} accent={NEON.green} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const fills = new Set([...svg.querySelectorAll("rect")].map((r) => r.getAttribute("fill")));
    expect(fills).toEqual(new Set([NEON.cyan, NEON.green]));
  });

  it("accent가 없으면 ink 한 가지 색", () => {
    const { container } = render(<Icon name="ask" ink="#123456" />);
    expect(new Set([...container.querySelectorAll("rect")].map((r) => r.getAttribute("fill")))).toEqual(new Set(["#123456"]));
  });
});

describe("팔레트 (디자인 3장)", () => {
  it("v2 추가 색", () => {
    expect(NEON.yellowDeep).toBe("#ffd84a");
    expect(NEON.pinkDeep).toBe("#c23c7a");
  });
});
