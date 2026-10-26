import { describe, expect, it } from "vitest";
import { builtinBundles, CONTRACT, loadTheme, REQUIRED_SLOTS, resolveTheme, type ThemeBundle } from "../../web/themes/registry";

// Phase 7 Task 2(계약 docs/design/phase7/SPEC.md §1·§2): 테마 로더. 모르는 테마·큰 contract → 오피스, 빠진 필수 칸·낱말 → 그 칸만 오피스
const office = loadTheme("office");
const officeBundle = (): ThemeBundle => builtinBundles().office;
const LAYOUT = { slots: { "desk-work": [0, 0, 64, 46] }, wallVariants: 4 };

function fake(over: Record<string, unknown> = {}, files: Record<string, string> = {}): ThemeBundle {
  const base = { ...office.manifest, id: "neon", name: { ko: "네온", en: "Neon" }, variants: { night: { ui: "dark" } }, ...over };
  return { manifest: base, files: { "scene-night.png": "/neon/scene-night.png", "sky.png": "/neon/sky.png", "backdrop-night.png": "/neon/backdrop-night.png", "street-night.png": "/neon/street-night.png", "extras.json": "/neon/extras.json", ...files }, data: { "scene.json": LAYOUT } };
}
const bundles = (b: ThemeBundle) => ({ office: officeBundle(), neon: b });

describe("loadTheme·resolveTheme", () => {
  it("office는 계약 1, 변형 낮(light)·밤(dark), 필수 칸 모두에 변형마다 그림 주소가 있다", () => {
    expect(CONTRACT).toBe(1);
    expect(office.manifest.id).toBe("office");
    expect(office.manifest.variants).toEqual({ day: { ui: "light" }, night: { ui: "dark" } });
    for (const slot of REQUIRED_SLOTS) for (const v of ["day", "night"]) expect(office.slots[slot]?.[v]?.url, `${slot}/${v}`).toBeTruthy();
    expect(office.slots.desk.day.url).not.toBe(office.slots.desk.night.url);
    // 장면 칸은 그림과 좌표(scene.json)가 한 쌍
    expect(Object.keys(office.slots.desk.day.layout!.slots)).toContain("desk-work");
    expect(office.slots.sky.day.layout).toBeUndefined();
    expect(office.words.rest).toEqual({ ko: "카페", en: "Cafe" });
  });

  it("알 수 없는 id·contract가 앱보다 큰 테마·모양이 틀린 매니페스트는 오피스", () => {
    expect(resolveTheme("nope", bundles(fake())).manifest.id).toBe("office");
    expect(resolveTheme("neon", bundles(fake({ contract: CONTRACT + 1 }))).manifest.id).toBe("office");
    expect(resolveTheme("neon", bundles(fake({ variants: {} }))).manifest.id).toBe("office");
    expect(resolveTheme("neon", bundles(fake({ variants: { night: { ui: "blue" } } }))).manifest.id).toBe("office");
    expect(resolveTheme("neon", bundles(fake())).manifest.id).toBe("neon");
  });

  it("missing slot falls back to office — 필수 칸 하나가 빠지면 그 칸만 오피스 그림(같은 ui의 오피스 변형)", () => {
    const t = resolveTheme("neon", bundles(fake({}, { "sky.png": undefined as never })));
    expect(t.slots.desk.night).toEqual({ url: "/neon/scene-night.png", layout: LAYOUT });
    expect(t.slots.sky.night).toEqual(office.slots.sky.night);
    const noStreet = resolveTheme("neon", bundles(fake({}, { "street-night.png": undefined as never })));
    expect(noStreet.slots.street.night).toEqual(office.slots.street.night);
  });

  it("P7a-5 m1: 장면 그림만 빠지면 그림과 좌표 모두 오피스(갈리지 않게), 좌표만 빠져도 둘 다 오피스", () => {
    const noPng = resolveTheme("neon", bundles(fake({}, { "scene-night.png": undefined as never })));
    expect(noPng.slots.desk.night).toEqual(office.slots.desk.night);
    const noLayout = resolveTheme("neon", { office: officeBundle(), neon: { ...fake(), data: {} } });
    expect(noLayout.slots.desk.night).toEqual(office.slots.desk.night);
    const badLayout = resolveTheme("neon", { office: officeBundle(), neon: { ...fake(), data: { "scene.json": { wallVariants: 4 } } } });
    expect(badLayout.slots.desk.night).toEqual(office.slots.desk.night);
  });

  it("words에서 빠진 낱말(rest)과 모양이 틀린 낱말은 오피스 낱말", () => {
    const t = resolveTheme("neon", bundles(fake({ words: { floor: { ko: "{n}구역", en: "Zone {n}" }, lobby: { ko: 3 } } })));
    expect(t.words.floor).toEqual({ ko: "{n}구역", en: "Zone {n}" });
    expect(t.words.rest).toEqual(office.words.rest);
    expect(t.words.lobby).toEqual(office.words.lobby);
  });

  it("T5: 캐릭터 층 시트는 테마 것, 빠진 장은 오피스 것(장면 시트·다른 파일은 섞지 않음)", () => {
    expect(Object.keys(office.sheets).sort()).toEqual(expect.arrayContaining(["aura.png", "cap.png", "layers/body.png", "layers/hair-short-gold.png", "layers/outfit.png"]));
    expect(Object.keys(office.sheets).some((f) => f.startsWith("scene-") || f.startsWith("extra-"))).toBe(false);
    const t = resolveTheme("neon", bundles(fake({}, { "layers/outfit.png": "/neon/outfit.png" })));
    expect(t.sheets["layers/outfit.png"]).toBe("/neon/outfit.png");
    expect(t.sheets["layers/body.png"]).toBe(office.sheets["layers/body.png"]);
  });
});
