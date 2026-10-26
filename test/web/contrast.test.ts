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
  it("P7a-9 표면 토큰 값(§4.1a): --page·--field·--line·--pick 두 벌", () => {
    expect([dark["--page"], dark["--field"], dark["--line"], dark["--pick"]]).toEqual(["#12111f", "#0b0a17", "#6a63a0", "#1c1a2c"]);
    expect([light["--page"], light["--field"], light["--line"], light["--pick"]]).toEqual(["#eef0f5", "#f4f1ea", "#6b7085", "#eeecf5"]);
  });

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
      // P7a-9 표면 토큰(계약 §4.1a): 입력칸·글 상자 --field, 페이지 --page, 테두리 --line
      pairs.push(["--ink", "--field", 4.5], ["--muted", "--field", 4.5], ["--ink", "--page", 4.5], ["--line", "--panel", 3], ["--line", "--field", 3], ["--line", "--page", 3], ["--yellow", "--line", 3]);
      pairs.push(["--wall", "--pink", 4.5]); // 급한 "!" 풍선·예산 칩·배너 글자
      pairs.push(["--ink", "--pick", 4.5], ["--green", "--pick", 4.5]); // 고른 항목 바탕(.qf-opt·.rf-row·.rd-opt), 서류철 줄 도장 글자
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

type Rule = { sel: string; body: string };
/** 장면 토큰(두 벌 공통 어두운 값)을 바탕·글자색으로 쓰는 규칙. 초록·분홍·하늘 판 위 글자 --wall은 공통 UI(light 흰색, §4.1)라 허용 */
function sceneTokenRules(rs: Rule[]): Rule[] {
  const SCENE_TOKENS = /(?<![\w-])(?:background(?:-color)?|color)\s*:[^;]*var\(--(?:slab|bg|wall|desk|desk-dark|floor|shaft|shell)\)/;
  const allowed = /^\.(pbtn--primary|chip--budget|desk-await|banner|urgent \.qmark)$/;
  return rs.filter((r) => !r.sel.startsWith(":root") && !r.sel.startsWith("@") && SCENE_TOKENS.test(allowed.test(r.sel) ? r.body.replace(/(^|;)\s*color:\s*var\(--wall\)/g, "") : r.body));
}
/** 바탕에 고정 hex(폴백 포함)를 쓰는 규칙. 키프레임 단계와 글 없는 꺼진 층 방은 뺀다 */
function hexBackgroundRules(rs: Rule[]): Rule[] {
  const allowed = new Set([".floor--ended .room"]);
  return rs.filter((r) => !r.sel.startsWith(":root") && !r.sel.startsWith("@") && !/^\d|^(from|to)$/.test(r.sel) && !allowed.has(r.sel) && /background(?:-color)?\s*:[^;]*#[0-9a-fA-F]{3,6}\b/.test(r.body));
}

describe("두 겹 포커스 링·노랑 위 글자(계약 §4.1·§6)", () => {
  /** 선택자 → 선언 */
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: m[2] }));

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
    expect(yellow.map((r) => r.sel)).toEqual(expect.arrayContaining([".q-chip", ".desk-folder", ".qmark"])); // .qmark = "!" 풍선(P7a-10 M2)
    // 서류철 종이도 밝은 바탕이라 같은 글자색(P7a-2)
    expect(rules.find((r) => r.sel === ".rf-paper")!.body).toMatch(/(^|[;\s])color:\s*var\(--yellow-ink\)/);
    for (const r of yellow) expect(r.body, r.sel).toMatch(/(^|[;\s])color:\s*var\(--yellow-ink\)/);
  });

  it("P7a-9: 장면 토큰(--slab·--bg·--wall·--desk·--desk-dark·--floor·--shaft·--shell)을 바탕·글자색으로 쓰는 규칙이 없다 — UI는 --page·--field·--panel, 장면은 --th-*", () => {
    expect(sceneTokenRules(rules).map((r) => r.sel)).toEqual([]);
  });

  it("P7a-10 I2·C1: 장면 위 글(이름표·모델 줄·상태 줄·통로 층 번호·빈 층 글)은 --th-label-bg 판 위, 퇴근 이름표는 점선 --th-label-muted", () => {
    const body = (sel: string) => rules.filter((r) => r.sel === sel).map((r) => r.body).join(";");
    for (const sel of [".nametag", ".desk-meta", ".desk-status", ".fl-no", ".vacant .sign", ".vacant p"]) expect(body(sel), sel).toMatch(/background:\s*var\(--th-label-bg\)/);
    expect(body(".nametag")).toMatch(/(^|[;\s])color:\s*var\(--th-label-ink\)/);
    expect(body(".desk--offduty .nametag")).toMatch(/border-style:\s*dashed/);
    expect(body(".desk--offduty .nametag")).toMatch(/border-color:\s*var\(--th-label-muted\)/);
    expect(body(".desk--offduty .nametag")).toMatch(/(^|[;\s])color:\s*var\(--th-label-ink\)/);
  });

  it("바탕에 고정 hex를 쓰지 않는다(두 벌 토큰만) — 하트바·미니 트랙·고른 항목 등. 허용: 꺼진 층 방(글 없음, 장면)", () => {
    expect(hexBackgroundRules(rules).map((r) => r.sel)).toEqual([]);
  });

  it("두 검사 자체: 틀린 규칙을 넣으면 잡고, 허용 목록·테두리색·토큰은 지나간다", () => {
    const parse = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
    const css = parse(`.a { background: var(--slab); } .b { color: var(--floor); } .c { background: linear-gradient(var(--th-x, var(--desk)) 0 4px); }
      .ok1 { border-color: var(--desk); background: var(--field); } .pbtn--primary { color: var(--wall); } .ok2 { background: var(--th-wall); }
      .d { background: #2c2a40; } .e { background-color: var(--pick, #1c1a2c); } .floor--ended .room { background: #1a1730; } 50% { background: #000; }`);
    expect(sceneTokenRules(css).map((r) => r.sel)).toEqual([".a", ".b", ".c"]);
    expect(hexBackgroundRules(css).map((r) => r.sel)).toEqual([".d", ".e"]);
  });
});
