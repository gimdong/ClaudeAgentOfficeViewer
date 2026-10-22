// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySum } from "../../src/shared/tokens";
import { Building } from "../../web/building/Building";
import { BUILDING_TEXT } from "../../web/building/BuildingInfo";
import { BAR_EMPTY, remainingOf } from "../../web/hud/remaining";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const sessions = [makeSession({ id: "a", floor: 1, members: [makeMember({ name: "team-lead", role: "lead" }), makeMember({ name: "qa" })] }), makeSession({ id: "b", floor: 2 })];
const snap = makeSnapshot({ sessions, usage: { today: { ...emptySum(), cacheRead: 820_000, total: 1_240_000 }, last5h: { ...emptySum(), total: 312_000 }, last7d: { ...emptySum(), total: 4_800_000 }, byModel: [], hourly: new Array(24).fill(0) } });

describe("지붕 간판(phase6b §11.1)", () => {
  it("간판은 버튼, 누르면 빌딩 정보 창(층·팀원 수, HUD와 같은 숫자)", () => {
    render(<Building sessions={sessions} snapshot={snap} />);
    const sign = screen.getByRole("button", { name: BUILDING_TEXT.signAria("User") });
    expect(sign.textContent).toBe("User의 회사");
    fireEvent.click(sign);
    const dlg = screen.getByRole("dialog", { name: BUILDING_TEXT.title });
    expect(within(dlg).getByText(BUILDING_TEXT.floorsValue(2, 3))).toBeTruthy();
    expect(within(dlg).getByText("1.24M")).toBeTruthy();
  });

  it("이름은 글자로만 — HTML이 그려지지 않는다", () => {
    render(<Building sessions={sessions} snapshot={snap} userName="<b>Acme</b>" />);
    const sign = screen.getByRole("button", { name: /빌딩 정보 열기/ });
    expect(sign.textContent).toBe("<b>Acme</b>의 회사");
    expect(sign.querySelector("b")).toBeNull();
  });

  it("저장은 onSaveName으로, 없으면 실패로 보인다", async () => {
    const onSaveName = vi.fn(async () => true);
    render(<Building sessions={sessions} snapshot={snap} onSaveName={onSaveName} />);
    fireEvent.click(screen.getByRole("button", { name: /빌딩 정보 열기/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /이름/ }), { target: { value: "Acme" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: BUILDING_TEXT.save }));
    });
    expect(onSaveName).toHaveBeenCalledWith("Acme");
  });
});

describe("remainingOf", () => {
  it("PLAN은 더 많이 쓴 창, 없으면 null", () => {
    expect(remainingOf(makeSnapshot()).plan).toBeNull();
    const r = remainingOf(makeSnapshot({ limits: { fiveHourPct: 30, weeklyPct: 70 } as never }));
    expect(r.plan).toBe(30);
    expect(r.planHint).toBe("WEEK");
  });
});

describe("빌딩 정보 PLAN 이유 줄(스펙 12장 j W33, qa #627 F)", () => {
  const plan = (statusline: "on" | "off" | "unsupported") => {
    cleanup();
    render(<Building sessions={sessions} snapshot={{ ...snap, statusline }} />);
    fireEvent.click(screen.getByRole("button", { name: /빌딩 정보 열기/ }));
    return screen.getByRole("dialog").textContent!;
  };
  it("꺼짐이면 켜는 법, 연결됐는데 없으면 요금제 사실", () => {
    expect(plan("off")).toContain(BUILDING_TEXT.planOff + BUILDING_TEXT.planWhyOff);
    expect(BUILDING_TEXT.planWhyOff).toBe("PLAN 잔여는 Claude Code가 상태줄에 넘겨 주는 값입니다. 이 설치본은 상태줄 연결이 꺼져 있어 받지 못합니다. 켜려면 설치 스크립트를 --statusline을 붙여 다시 실행하세요.");
    expect(plan("on")).toContain(BUILDING_TEXT.planNone + BUILDING_TEXT.planWhyOn);
    expect(BUILDING_TEXT.planWhyOn).toBe("PLAN 잔여는 Claude Code가 상태줄에 넘겨 주는 값입니다. Pro·Max 요금제나 지출 한도가 있는 gateway에서만 오고, 이 계정에는 오지 않습니다.");
    // B331: Windows는 같은 사실(HUD와 같은 상수) + 한 줄 이유
    expect(BUILDING_TEXT.planUnsupported).toBe(BAR_EMPTY.planUnsupported);
    expect(plan("unsupported")).toContain(BUILDING_TEXT.planUnsupported + BUILDING_TEXT.planWhyUnsupported);
    // B332: 상태를 모르는 옛 서버는 off와 같다("아직" 문장은 없음)
    cleanup();
    render(<Building sessions={sessions} snapshot={{ ...snap, statusline: undefined }} />);
    fireEvent.click(screen.getByRole("button", { name: /빌딩 정보 열기/ }));
    expect(screen.getByRole("dialog").textContent).toContain(BUILDING_TEXT.planOff + BUILDING_TEXT.planWhyOff);
    expect(Object.values(BUILDING_TEXT).some((v) => typeof v === "string" && v.includes("아직"))).toBe(false);
  });
});
