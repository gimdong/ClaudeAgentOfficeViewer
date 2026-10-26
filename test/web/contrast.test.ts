import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 7 Task 1(계약 docs/design/phase7/SPEC.md §4.1·§6): 공통 UI 토큰 두 벌(light·dark)의 대비와 두 겹 포커스 링.
// ratio()는 office 목업 contrast.cjs(7334726)의 WCAG 2.x 휘도 계산을 옮긴 것
const CSS = readFileSync(join(__dirname, "../../web/styles.css"), "utf8");

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** selector 규칙 블록들(같은 선택자가 여럿이면 차례로 합침) 안의 --이름: #hex 값 */
function block(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = CSS.indexOf(`${selector} {`); i >= 0; i = CSS.indexOf(`${selector} {`, i + 1)) {
    const body = CSS.slice(i, CSS.indexOf("}", i));
    for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2].toLowerCase();
  }
  return out;
}
const dark = { ...block(":root"), ...block(':root[data-ui="dark"]') };
const light = { ...dark, ...block(':root[data-ui="light"]') };
const SETS = { light, dark } as const;

/** 포커스 링이 놓일 장면 색(계약 §4.2 office 낮·밤 + 목업 벽지 변형·공사 층). 낮 장면은 light 벌, 밤 장면은 dark 벌과 함께 쓴다 */
const SCENE = {
  light: { wall: "#f7f4ee", wallV1: "#eef6f0", wallV2: "#f2effa", wallV3: "#fbf0e6", floor: "#ddd4c4", teamZone: "#cfe3d6", facade: "#efe9dd", concrete: "#d9d6d0" },
  dark: { wall: "#1d1b33", wallV1: "#1a2430", wallV2: "#221d36", wallV3: "#2a1f24", floor: "#2a2446", teamZone: "#22354a", facade: "#2e2852", concrete: "#2a2838" },
};

describe("공통 UI 두 벌(계약 §4.1)", () => {
  it("light 벌의 값은 계약대로(--wall 흰색, --green #0b7a52, --yellow #ffd84a, --yellow-ink #1f2233), dark는 --yellow #fff7a8·--yellow-ink #12111f", () => {
    expect([light["--wall"], light["--green"], light["--yellow"], light["--yellow-ink"]]).toEqual(["#ffffff", "#0b7a52", "#ffd84a", "#1f2233"]);
    expect([dark["--yellow"], dark["--yellow-ink"]]).toEqual(["#fff7a8", "#12111f"]);
  });

  for (const [name, v] of Object.entries(SETS)) {
    it(`${name}: 글자/판 4.5:1 이상 — --ink·--muted·--pink·--cyan / --panel, --yellow-ink / --yellow, --wall / --green`, () => {
      const pairs: Array<[string, string, number]> = [
        ["--ink", "--panel", 4.5],
        ["--muted", "--panel", 4.5],
        ["--pink", "--panel", 4.5],
        ["--cyan", "--panel", 4.5],
        ["--violet", "--panel", 4.5],
        ["--red", "--panel", 4.5],
        ["--yellow-ink", "--yellow", 4.5],
        ["--wall", "--green", name === "light" ? 5.36 : 4.5],
      ];
      // 서류철 종이(.rf-paper): 글자는 --yellow-ink(P7a-2 — --wall은 light에서 흰색)
      pairs.push(["--yellow-ink", "--paper", 4.5]);
      for (const [fg, bg, min] of pairs) {
        expect(v[fg], fg).toMatch(/^#[0-9a-f]{6}$/);
        expect(ratio(v[fg], v[bg]), `${fg}/${bg}`).toBeGreaterThanOrEqual(min - 0.005);
      }
    });

    it(`${name}: 포커스 링 두 겹(--focus 안쪽, --ink 바깥) 중 하나가 장면 색 모두에 3:1 이상`, () => {
      for (const [k, bg] of Object.entries(SCENE[name as keyof typeof SCENE])) {
        expect(Math.max(ratio(v["--focus"], bg), ratio(v["--ink"], bg)), k).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe("두 겹 포커스 링·노랑 위 글자(계약 §4.1·§6)", () => {
  /** 선택자 → 선언 */
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

  it("포커스 링은 어디서나(입력칸 :focus 포함) outline: 2px solid var(--focus) + box-shadow: 0 0 0 6px var(--ink)", () => {
    const focus = rules.filter((r) => r.sel.includes(":focus") && /outline\s*:/.test(r.body));
    expect(focus.filter((r) => /:focus(?!-visible)/.test(r.sel)).length).toBeGreaterThanOrEqual(4); // 입력칸 네 곳
    expect(focus.length).toBeGreaterThan(0);
    for (const r of focus) {
      expect(r.body, r.sel).toMatch(/outline:\s*2px solid var\(--focus\)/);
      expect(r.body, r.sel).toMatch(/box-shadow:\s*0 0 0 6px var\(--ink\)/);
    }
  });

  it("노랑 바탕(.q-chip·결재 칩·결정 이름표·셔터 팻말 등)의 글자색은 var(--yellow-ink)", () => {
    const yellow = rules.filter((r) => /background:\s*var\(--yellow\)/.test(r.body) && /(^|[;\s])color:/.test(r.body));
    expect(yellow.map((r) => r.sel)).toEqual(expect.arrayContaining([".q-chip", ".desk-folder"]));
    // 서류철 종이도 밝은 바탕이라 같은 글자색(P7a-2)
    expect(rules.find((r) => r.sel === ".rf-paper")!.body).toMatch(/(^|[;\s])color:\s*var\(--yellow-ink\)/);
    for (const r of yellow) expect(r.body, r.sel).toMatch(/(^|[;\s])color:\s*var\(--yellow-ink\)/);
  });
});
