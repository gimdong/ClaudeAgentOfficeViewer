// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsChip } from "../../web/diag/DiagnosticsChip";
import { DiagnosticsPanel } from "../../web/diag/DiagnosticsPanel";
import { hookLine } from "../../web/diag/format";
import { Hud } from "../../web/hud/Hud";
import type { DiagnosticsSummary } from "../../src/shared/types";
import { makeSnapshot } from "./fixtures";

const NOW = Date.UTC(2026, 9, 1, 5, 32);
const summary = (o: Partial<DiagnosticsSummary> = {}): DiagnosticsSummary => ({
  doctor: [
    { id: "node", status: "ok", title: "Node.js", detail: "버전 24", fix: "" },
    { id: "proxy", status: "warn", title: "프록시", detail: "있음(로컬 주소 예외 없음)", fix: "환경변수 NO_PROXY에 127.0.0.1,localhost 를 넣어 주세요(회사 IT 담당자에게 문의)." },
    { id: "managed", status: "fail", title: "회사 관리자 설정", detail: "있음: 관리자 hook만 허용", fix: "사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요." },
    { id: "statusline", status: "ok", title: "요금제 한도(선택)", detail: "없음", fix: "PLAN 바(요금제 한도)는 베타에서 지원하지 않습니다. 회사 좌석에서는 대부분 표시되지 않습니다" },
  ],
  hooks: { total: 9, byEvent: {}, lastAt: new Date(NOW - 2 * 60_000).toISOString(), rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 5 },
  errorsLastHour: 0,
  logDir: "~/.claude-office/logs",
  diagDir: "~/.claude-office/diagnostics",
  ...o,
});

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let bundle: () => Promise<Response>;
let diag: () => Promise<Response>;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  calls = [];
  diag = () => json(summary());
  bundle = () => json({ file: "claude-office-diag-20261001-143205.json" }, 201);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return url === "/api/diagnostics/bundle" ? bundle() : url === "/api/diagnostics" ? diag() : json({}, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DiagnosticsChip", () => {
  it("오류가 없으면 점이 없고, 1시간 안 오류가 있으면 빨간 점과 aria 문구", () => {
    const { container, rerender } = render(<DiagnosticsChip errorsLastHour={0} open={false} onToggle={() => {}} />);
    const chip = screen.getByRole("button", { name: "진단 열기" });
    expect(chip.textContent).toContain("진단");
    expect(container.querySelector(".diag-dot")).toBeNull();
    rerender(<DiagnosticsChip errorsLastHour={3} open={false} onToggle={() => {}} />);
    expect(container.querySelector(".diag-dot")).not.toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("진단 열기, 최근 1시간 오류 3건");
    expect(screen.getByRole("button").getAttribute("aria-controls")).toBe("diag-panel");
  });
});

describe("hookLine", () => {
  it("마지막 수신 방금 / N분 전 / N시간 전 / 없음", () => {
    const h = summary().hooks;
    expect(hookLine(h, NOW)).toBe("최근 10분 5건, 마지막 수신 2분 전, 거부 0건");
    expect(hookLine({ ...h, lastAt: new Date(NOW - 30_000).toISOString() }, NOW)).toContain("마지막 수신 방금");
    expect(hookLine({ ...h, lastAt: new Date(NOW - 3 * 3_600_000 - 10).toISOString() }, NOW)).toContain("마지막 수신 3시간 전");
    expect(hookLine({ ...h, last10min: 0, lastAt: null, rejected: { "403": 1, "415": 0, "413": 0, "400": 2 } }, NOW)).toBe("최근 10분 0건, 마지막 수신 없음, 거부 3건");
  });
});

describe("Hud의 진단 칩과 패널", () => {
  it("칩을 누르면 패널이 열리고 doctor 항목이 상태별로 보인다(fail이 위, ok는 fix 없이)", async () => {
    render(<Hud snapshot={makeSnapshot()} live />);
    fireEvent.click(await screen.findByRole("button", { name: "진단 열기" }));
    const panel = await screen.findByRole("dialog", { name: "진단" });
    await within(panel).findByText("회사 관리자 설정");
    expect(document.activeElement?.id).toBe("dp-title");
    const rows = [...panel.querySelectorAll(".dp-row")];
    expect(rows.map((r) => r.className.replace("dp-row dp-row--", ""))).toEqual(["fail", "warn", "ok", "ok"]);
    expect(rows[0].textContent).toContain("문제: 회사 관리자 설정");
    expect(rows[0].textContent).toContain("사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요.");
    expect(rows[1].textContent).toContain("확인 필요: 프록시");
    // ok 행은 제목과 detail 한 줄. fix가 있어도(B12 요금제 한도) 보이지 않는다(디자인 4장)
    expect(rows[3].textContent).toContain("요금제 한도(선택)");
    expect(rows[3].querySelector(".f")).toBeNull();
    expect(panel.textContent).toContain("문제 1개를 찾았습니다");
    expect(panel.textContent).toContain("최근 1시간 오류 없음");
    expect(panel.textContent).toContain("로그 폴더 ~/.claude-office/logs");
    expect(screen.getByRole("button", { name: "진단 열기" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("hook 요약 줄", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    render(<Hud snapshot={makeSnapshot()} live />);
    fireEvent.click(await screen.findByRole("button", { name: "진단 열기" }));
    expect(await screen.findByText("최근 10분 5건, 마지막 수신 2분 전, 거부 0건")).toBeTruthy();
  });

  it("오류가 있으면 칩에 빨간 점(요약을 가져온 뒤)", async () => {
    diag = () => json(summary({ errorsLastHour: 2 }));
    const { container } = render(<Hud snapshot={makeSnapshot()} live />);
    await screen.findByRole("button", { name: "진단 열기, 최근 1시간 오류 2건" });
    expect(container.querySelector(".diag-chip .diag-dot")).not.toBeNull();
  });

  it("진단 파일 만들기 → 만드는 중 → 경로와 받기 링크(포커스가 링크로)", async () => {
    let resolve!: (r: Response) => void;
    bundle = () => new Promise((r) => (resolve = r));
    render(<Hud snapshot={makeSnapshot()} live />);
    fireEvent.click(await screen.findByRole("button", { name: "진단 열기" }));
    fireEvent.click(await screen.findByRole("button", { name: "진단 파일 만들기" }));
    const busy = await screen.findByRole("button", { name: "만드는 중…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    const post = calls.find((c) => c.url === "/api/diagnostics/bundle")!;
    expect(post.init?.method).toBe("POST");
    expect((post.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(post.init?.body).toBe("{}");
    await act(async () => resolve(new Response(JSON.stringify({ file: "claude-office-diag-20261001-143205.json" }), { status: 201 })));
    const link = await screen.findByRole("link", { name: "받기" });
    expect(link.getAttribute("href")).toBe("/api/diagnostics/files/claude-office-diag-20261001-143205.json");
    expect(link.hasAttribute("download")).toBe(true);
    expect(screen.getByText("~/.claude-office/diagnostics/claude-office-diag-20261001-143205.json")).toBeTruthy();
    expect(screen.getByText("진단 파일을 만들었습니다").closest("[role=status]")).not.toBeNull();
    expect(document.activeElement).toBe(link);
    expect(screen.getByRole("button", { name: "다시 만들기" })).toBeTruthy();
  });

  it("실패하면 알림 문구, 버튼 다시 사용 가능", async () => {
    bundle = () => json({ error: "진단 파일을 만들지 못했습니다" }, 500);
    render(<Hud snapshot={makeSnapshot()} live />);
    fireEvent.click(await screen.findByRole("button", { name: "진단 열기" }));
    fireEvent.click(await screen.findByRole("button", { name: "진단 파일 만들기" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("진단 파일을 만들지 못했습니다. 잠시 뒤 다시 눌러 주세요. 계속 안 되면 터미널에서 claude-office diag를 실행해 주세요.");
    expect(alert.querySelector("code")?.textContent).toBe("claude-office diag");
    const btn = screen.getByRole("button", { name: "진단 파일 만들기" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it("Esc로 닫고 칩으로 포커스가 돌아간다, 다시 열면 진단 파일 상태는 처음으로", async () => {
    render(<Hud snapshot={makeSnapshot()} live />);
    const chip = await screen.findByRole("button", { name: "진단 열기" });
    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole("button", { name: "진단 파일 만들기" }));
    await screen.findByRole("link", { name: "받기" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    expect(await screen.findByRole("button", { name: "진단 파일 만들기" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "받기" })).toBeNull();
  });

  it("말풍선이 떠 있으면 Esc는 말풍선이 먼저(패널은 그대로)", async () => {
    render(<Hud snapshot={makeSnapshot()} live />);
    fireEvent.click(await screen.findByRole("button", { name: "진단 열기" }));
    await screen.findByRole("dialog");
    const bubble = document.createElement("div");
    bubble.setAttribute("role", "tooltip");
    bubble.className = "say";
    document.body.appendChild(bubble);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    bubble.remove();
  });

  it("닫기 버튼과 칩 다시 누르기도 닫는다", async () => {
    render(<Hud snapshot={makeSnapshot()} live />);
    const chip = await screen.findByRole("button", { name: "진단 열기" });
    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(chip);
    await screen.findByRole("dialog");
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("불러오기 실패면 알림과 다시 시도", async () => {
    diag = () => Promise.reject(new TypeError("fetch failed"));
    render(<Hud snapshot={makeSnapshot()} live />);
    fireEvent.click(await screen.findByRole("button", { name: "진단 열기" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("진단 정보를 가져오지 못했습니다. 서버가 켜져 있는지 확인해 주세요.");
    diag = () => json(summary());
    fireEvent.click(within(alert).getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("회사 관리자 설정")).toBeTruthy();
  });
});

describe("DiagnosticsPanel", () => {
  it("모두 정상이면 '모두 정상입니다', 불러오는 중이면 안내", () => {
    const ok = summary({ doctor: [{ id: "node", status: "ok", title: "Node.js", detail: "버전 24", fix: "" }] });
    const { rerender } = render(<DiagnosticsPanel data={ok} error={null} checkedAt={NOW} busy={false} onReload={() => {}} onClose={() => {}} />);
    expect(screen.getByText("모두 정상입니다")).toBeTruthy();
    rerender(<DiagnosticsPanel data={null} error={null} checkedAt={null} busy={false} onReload={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe("진단 정보를 불러오는 중…");
  });
});
