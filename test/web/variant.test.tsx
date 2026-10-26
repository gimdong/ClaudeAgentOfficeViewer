// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILDING_TEXT, BuildingInfo } from "../../web/building/BuildingInfo";
import { loadTheme, type ResolvedTheme } from "../../web/themes/registry";
import { useVariant } from "../../web/themes/useVariant";

// Phase 7 Task 3: 낮·밤 변형. system이면 prefers-color-scheme을 따르고, 바뀌면 다시 그리지 않고 바로 따라간다
let dark = false;
const listeners = new Set<(e: { matches: boolean }) => void>();
beforeEach(() => {
  dark = false;
  listeners.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({
    media: q,
    get matches() {
      return dark;
    },
    addEventListener: (_t: string, f: (e: { matches: boolean }) => void) => void listeners.add(f),
    removeEventListener: (_t: string, f: (e: { matches: boolean }) => void) => void listeners.delete(f),
  }));
  for (const k of ["theme", "variant", "ui"]) delete document.documentElement.dataset[k];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const setDark = (v: boolean) => act(() => {
  dark = v;
  for (const f of listeners) f({ matches: v });
});
const office = loadTheme("office");
let renders = 0;
function Probe({ setting, theme = office }: { setting: "day" | "night" | "system"; theme?: ResolvedTheme }) {
  renders++;
  const r = useVariant(setting, theme);
  return <p data-testid="v">{`${r.variant}/${r.ui}`}</p>;
}
const root = () => ({ ...document.documentElement.dataset });

describe("useVariant", () => {
  it("system + 시스템 어둠 → night(dark), 루트에 data-theme·data-variant·data-ui", () => {
    dark = true;
    render(<Probe setting="system" />);
    expect(screen.getByTestId("v").textContent).toBe("night/dark");
    expect(root()).toMatchObject({ theme: "office", variant: "night", ui: "dark" });
  });

  it("follows prefers-color-scheme change without reload — 같은 화면이 바로 낮으로", () => {
    dark = true;
    const { container } = render(<Probe setting="system" />);
    const node = container.firstChild;
    setDark(false);
    expect(screen.getByTestId("v").textContent).toBe("day/light");
    expect(container.firstChild).toBe(node); // 다시 마운트하지 않음
    expect(root()).toMatchObject({ variant: "day", ui: "light" });
  });

  it("낮·밤 고정은 시스템 밝기를 무시한다", () => {
    dark = true;
    render(<Probe setting="day" />);
    expect(screen.getByTestId("v").textContent).toBe("day/light");
    cleanup();
    dark = false;
    render(<Probe setting="night" />);
    setDark(false);
    expect(screen.getByTestId("v").textContent).toBe("night/dark");
  });

  it("변형이 하나뿐인 테마는 설정과 관계없이 그 변형", () => {
    const one: ResolvedTheme = { ...office, manifest: { ...office.manifest, id: "neon", variants: { neon: { ui: "dark" } } } };
    dark = false;
    render(<Probe setting="day" theme={one} />);
    expect(screen.getByTestId("v").textContent).toBe("neon/dark");
  });
});

if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
const info = (extra: Partial<Parameters<typeof BuildingInfo>[0]> = {}) => (
  <BuildingInfo userName="User" usage={{ today: 0, todayCacheRead: 0, last5h: 0, last7d: 0 }} remaining={{ five: null, week: null, plan: null }} floors={1} members={1} appVersion="t" onSave={async () => true} onClose={() => {}} {...extra} />
);

describe("빌딩 정보의 낮·밤 설정", () => {
  it("글자(qa·P7a-6 확정): 묶음 '화면', 낮 / 밤 / 시스템 따라, 설명 한 줄, 알림 세 문장, 단일 변형 보조 글", () => {
    expect([BUILDING_TEXT.variant, BUILDING_TEXT.variantDay, BUILDING_TEXT.variantNight, BUILDING_TEXT.variantSystem]).toEqual(["화면", "낮", "밤", "시스템 따라"]);
    expect(BUILDING_TEXT.variantHelp).toBe("시스템 따라: 컴퓨터가 어두운 모드면 밤, 밝은 모드면 낮입니다. 시각에 따라 저절로 바뀌지는 않습니다.");
    expect(["day", "night", "system"].map((v) => BUILDING_TEXT.variantSaved(v as "day"))).toEqual(["낮으로 바꿨습니다", "밤으로 바꿨습니다", "시스템 설정을 따르도록 바꿨습니다"]);
    expect(BUILDING_TEXT.variantOnly).toBe("이 테마는 한 가지 모습만 있어 낮·밤을 바꿀 수 없습니다");
  });

  it("낮 / 밤 / 시스템 따라 라디오, 지금 값이 골라져 있고 고르면 onSaveVariant, 저장되면 초록 줄과 알림", async () => {
    const onSaveVariant = vi.fn(async () => true);
    const announce = vi.fn();
    render(info({ variant: "system", variantCount: 2, onSaveVariant, announce }));
    expect(screen.getByText(BUILDING_TEXT.variantHelp)).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: BUILDING_TEXT.variant });
    expect(group).toBeTruthy();
    expect((screen.getByRole("radio", { name: BUILDING_TEXT.variantSystem }) as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: BUILDING_TEXT.variantNight }));
    });
    expect(onSaveVariant).toHaveBeenCalledWith("night");
    expect(screen.getByText(BUILDING_TEXT.variantSaved("night"))).toBeTruthy();
    expect(announce).toHaveBeenCalledWith("밤으로 바꿨습니다");
  });

  it("변형이 하나뿐인 테마면 라디오는 aria-disabled이고 눌러도 저장하지 않는다", async () => {
    const onSaveVariant = vi.fn(async () => true);
    render(info({ variant: "system", variantCount: 1, onSaveVariant }));
    for (const r of screen.getAllByRole("radio")) expect(r.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(BUILDING_TEXT.variantOnly)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: BUILDING_TEXT.variantDay }));
    });
    expect(onSaveVariant).not.toHaveBeenCalled();
  });
});
void renders;
