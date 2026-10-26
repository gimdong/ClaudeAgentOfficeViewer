// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { floorWallVariant } from "../../web/building/Floor";
import { ACTIONS, Character, LOOKS, memberVariant, type ActionName } from "../../web/office/Character";
import { loadTheme } from "../../web/themes/registry";

// Phase 7 Task 5(계약 docs/design/phase7/SPEC.md §3): 캐릭터 = div 하나 + 층 시트 여러 장, 오라는 type일 때만
afterEach(cleanup);
const office = loadTheme("office");

describe("Character", () => {
  it("행 이름 13개가 계약 순서대로 행 번호 0–12", () => {
    const names: ActionName[] = ["walk_left", "walk_right", "sit_down", "type", "think", "idle", "hand_up", "coffee", "hand_up_stand", "walk_down", "walk_up", "ride", "ride_lurch"];
    expect(Object.keys(ACTIONS)).toEqual(names);
    names.forEach((n, i) => expect(ACTIONS[n].row).toBe(i));
    expect([ACTIONS.type.frames, ACTIONS.think.frames, ACTIONS.idle.frames, ACTIONS.sit_down.frames]).toEqual([2, 2, 4, 3]);
  });

  it("div 하나에 data-action·--row·--frames, aria-hidden, 층 6장(안경 있는 모습, body 맨 아래)", () => {
    const { container } = render(<Character name="dev" action="think" variantIndex={1} />);
    const ch = container.querySelector(".character") as HTMLElement;
    expect(ch.dataset.action).toBe("think");
    expect(ch.getAttribute("aria-hidden")).toBe("true");
    expect(ch.style.getPropertyValue("--row")).toBe("4");
    expect(ch.style.getPropertyValue("--frames")).toBe("2");
    const imgs = ch.style.backgroundImage.split("url(").slice(1);
    expect(imgs).toHaveLength(6);
    expect(imgs[imgs.length - 1]).toContain(office.sheets["layers/body.png"]);
    expect(imgs[0]).toContain(office.sheets["layers/prop.png"]);
    expect(imgs[1]).toContain(office.sheets["layers/glasses.png"]);
    expect(container.querySelector(".aura")).toBeNull();
  });

  it("오라는 type일 때만, data-aura = auraRow(effort); 4단계는 금색 머리 판", () => {
    const { container, rerender } = render(<Character name="dev" action="type" effort="high" variantIndex={0} />);
    expect((container.querySelector(".aura") as HTMLElement).dataset.aura).toBe("3");
    expect(container.querySelector(".aura")!.getAttribute("aria-hidden")).toBe("true");
    rerender(<Character name="dev" action="type" variantIndex={0} />);
    expect((container.querySelector(".aura") as HTMLElement).dataset.aura).toBe("1");
    rerender(<Character name="dev" action="type" effort="max" variantIndex={0} />);
    expect((container.querySelector(".character") as HTMLElement).style.backgroundImage).toContain(office.sheets["layers/hair-short-gold.png"]);
    rerender(<Character name="dev" action="idle" effort="max" variantIndex={0} />);
    expect(container.querySelector(".aura")).toBeNull();
    expect((container.querySelector(".character") as HTMLElement).style.backgroundImage).not.toContain("gold");
  });

  it("memberVariant: 같은 이름은 늘 같은 값, 범위 안, 이름마다 고루", () => {
    expect(memberVariant("developer", LOOKS.length)).toBe(memberVariant("developer", LOOKS.length));
    const seen = new Set(["a", "b", "c", "dev", "qa", "lead", "reviewer", "designer"].map((n) => memberVariant(n, LOOKS.length)));
    for (const v of seen) expect(v >= 0 && v < LOOKS.length).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
    expect(memberVariant("x", 0)).toBe(0);
  });

  it("variantIndex가 다르면 머리 층이 다르다", () => {
    const bg = (i: number) => {
      const { container } = render(<Character name="dev" action="idle" variantIndex={i} />);
      const s = (container.querySelector(".character") as HTMLElement).style.backgroundImage;
      cleanup();
      return s;
    };
    expect(new Set(LOOKS.map((_, i) => bg(i))).size).toBe(LOOKS.length);
  });
});

describe("floorWallVariant", () => {
  it("같은 층 id는 늘 같은 값, 0..count-1", () => {
    expect(floorWallVariant("s-1", 4)).toBe(floorWallVariant("s-1", 4));
    const vs = new Set(["s-1", "s-2", "s-3", "abc", "def", "ghi", "jkl"].map((id) => floorWallVariant(id, 4)));
    for (const v of vs) expect(v >= 0 && v < 4).toBe(true);
    expect(vs.size).toBeGreaterThan(1);
    expect(floorWallVariant("s-1", 0)).toBe(0);
  });
});
