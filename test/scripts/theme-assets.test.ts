import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Phase 7 Task 2 빌드 검사(계약 docs/design/phase7/SPEC.md §4·§6·§7·§10): 테마 tokens.css는 --th-*만, 테마 글 판 쌍 AA,
// 변형별 그림 합계 64KB 이하, 생성기를 다시 돌린 결과가 커밋된 자산과 같은 바이트
const ROOT = join(__dirname, "../..");
const THEMES = join(ROOT, "web/themes");
const themes = readdirSync(THEMES).filter((d) => existsSync(join(THEMES, d, "theme.json")));

const COMMON = ["ink", "wall", "panel", "muted", "green", "pink", "yellow", "yellow-ink", "cyan", "red", "violet", "focus"];
/** tokens.css에 나온 공통 UI 토큰 이름(선언만) */
const commonIn = (css: string) => [...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]).filter((n) => COMMON.includes(n.slice(2)));
/** --th-로 시작하지 않는 사용자 정의 속성(P7a-5: 테마는 --th-* 이름공간만) */
const nonTh = (css: string) => [...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]).filter((n) => !n.startsWith("--th-"));

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
/** 변형 → --th-* 값 */
function variantTokens(css: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const m of css.matchAll(/\[data-variant="([a-z]+)"\]\s*\{([^}]*)\}/g)) out[m[1]] = Object.fromEntries([...m[2].matchAll(/(--th-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((x) => [x[1], x[2]]));
  return out;
}
/** 테마가 통과해야 할 글 판 쌍(계약 §6) 중 4.5:1 미만 */
const PAIRS = [["--th-label-ink", "--th-label-bg"], ["--th-label-muted", "--th-label-bg"], ["--th-label-accent", "--th-label-bg"], ["--th-paper-ink", "--th-paper"]];
const failingPairs = (t: Record<string, string>) => PAIRS.filter(([fg, bg]) => !t[fg] || !t[bg] || ratio(t[fg], t[bg]) < 4.5).map((p) => p.join("/"));

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
/** 변형 하나가 쓰는 PNG 합계: 다른 변형 이름(-<v>.png)이 붙은 파일은 뺀다 */
function variantBytes(dir: string, variant: string, variants: string[]): number {
  const others = variants.filter((v) => v !== variant);
  return walk(dir).filter((f) => f.endsWith(".png") && !others.some((v) => f.endsWith(`-${v}.png`))).reduce((n, f) => n + statSync(f).size, 0);
}

describe("검사 함수 자체(틀린 입력을 잡는다)", () => {
  it("공통 UI 토큰 이름·AA 미만 쌍을 찾는다", () => {
    expect(commonIn(":root[data-theme=x][data-variant=day] { --th-bg: #fff; --ink: #000; --yellow-ink: #111; }")).toEqual(["--ink", "--yellow-ink"]);
    expect(nonTh(":root { --th-bg: #fff; --sc-cable: #000; --th-sc-x: #111; }")).toEqual(["--sc-cable"]);
    // 낮은 대비 한 쌍 + 빠진 토큰(--th-paper) 한 쌍
    expect(failingPairs({ "--th-label-ink": "#777777", "--th-label-bg": "#888888", "--th-label-muted": "#000000", "--th-label-accent": "#000000", "--th-paper-ink": "#000000" })).toEqual(["--th-label-ink/--th-label-bg", "--th-paper-ink/--th-paper"]);
  });
});

describe.each(themes)("테마 %s", (id) => {
  const dir = join(THEMES, id);
  const manifest = JSON.parse(readFileSync(join(dir, "theme.json"), "utf8")) as { id: string; variants: Record<string, unknown> };
  const css = readFileSync(join(dir, "tokens.css"), "utf8");
  const variants = Object.keys(manifest.variants);

  it("폴더 이름 = id, tokens.css는 공통 UI 토큰을 쓰지 않고 선택자는 [data-theme] + [data-variant]", () => {
    expect(manifest.id).toBe(id);
    expect(commonIn(css)).toEqual([]);
    expect(nonTh(css)).toEqual([]);
    for (const v of variants) expect(css, v).toContain(`:root[data-theme="${id}"][data-variant="${v}"]`);
  });

  it("변형마다 글 판 쌍(이름표·보조·강조·종이) 4.5:1 이상", () => {
    const t = variantTokens(css);
    for (const v of variants) expect(failingPairs(t[v] ?? {}), v).toEqual([]);
  });

  it("변형마다 그림(PNG) 합계 64KB 이하", () => {
    for (const v of variants) expect(variantBytes(dir, v, variants), v).toBeLessThanOrEqual(65536);
  });
});

describe("저장소 생성기(P7a-5)", () => {
  it("Node 표준 밖 명령(git·qlmanage·sips·perl)을 부르지 않고, make-exterior는 --layers·--out 없으면 2로 끝난다", () => {
    for (const f of readdirSync(join(ROOT, "scripts/theme-assets"))) {
      const src = readFileSync(join(ROOT, "scripts/theme-assets", f), "utf8");
      for (const bad of ['"git"', "qlmanage", '"sips"', '"perl"']) expect(src.includes(bad), `${f} ${bad}`).toBe(false);
    }
    const out = mkdtempSync(join(tmpdir(), "co-ext-"));
    try {
      expect(() => execFileSync(process.execPath, [join(ROOT, "scripts/theme-assets/make-exterior.mjs"), "--out", out], { stdio: "ignore" })).toThrow(expect.objectContaining({ status: 2 }));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("office 자산 재현성", () => {
  const out = mkdtempSync(join(tmpdir(), "co-theme-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  it("생성기를 다시 돌린 결과가 커밋된 web/themes/office와 바이트가 같고, 빠지거나 남는 생성 파일이 없다", () => {
    execFileSync(process.execPath, [join(ROOT, "scripts/theme-assets/build-office.mjs"), out], { stdio: "ignore" });
    const made = walk(out).map((f) => relative(out, f)).sort();
    const committed = walk(join(THEMES, "office")).map((f) => relative(join(THEMES, "office"), f)).filter((f) => !["theme.json", "LICENSE.md"].includes(f)).sort();
    expect(made).toEqual(committed);
    for (const f of made) expect(readFileSync(join(out, f)).equals(readFileSync(join(THEMES, "office", f))), f).toBe(true);
  }, 60_000);
});
