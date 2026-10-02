// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionView, QuestionView } from "../../src/shared/types";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<object>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { QuestionForm } from "../../web/report/QuestionForm";

const QS: QuestionView[] = [
  { question: "과일은?", header: "과일", multiSelect: false, options: [{ label: "사과", description: "빨강" }, { label: "배" }] },
  { question: "토핑은?", multiSelect: true, options: [{ label: "버섯" }, { label: "치즈" }, { label: "올리브" }] },
];

type Answers = Array<{ labels: number[] } | { other: string }>;
let sent: Answers[];
const form = (questions = QS, disabled = false) => render(<QuestionForm questions={questions} disabled={disabled} onSubmit={(a) => sent.push(a)} />);
const submit = () => screen.getByRole("button", { name: "이 답 보내기" });

beforeEach(() => {
  sent = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("QuestionForm", () => {
  it("단일 선택은 라디오, 다중 선택은 체크박스로 그린다", () => {
    form();
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.tagName)).toEqual(["FIELDSET", "FIELDSET"]);
    expect(groups[0].querySelector("legend")!.textContent).toContain("과일은?");
    expect(groups[0].textContent).toContain("과일"); // header
    expect(within(groups[0]).getAllByRole("radio")).toHaveLength(3); // 사과, 배, 기타
    expect(within(groups[1]).getAllByRole("checkbox")).toHaveLength(4); // 버섯, 치즈, 올리브, 기타
    expect(within(groups[0]).getByRole("radio", { name: /사과/ })).toBeTruthy();
    expect(groups[0].textContent).toContain("빨강"); // 설명
    expect(within(groups[0]).getByRole("radio", { name: "기타 (직접 입력)" })).toBeTruthy();
  });

  it("선택하고 보내면 질문 순서대로 인덱스를 보낸다", () => {
    form();
    const [g0, g1] = screen.getAllByRole("group");
    fireEvent.click(within(g0).getByRole("radio", { name: "배" }));
    fireEvent.click(within(g1).getByRole("checkbox", { name: "올리브" }));
    fireEvent.click(within(g1).getByRole("checkbox", { name: "버섯" }));
    fireEvent.click(submit());
    expect(sent).toEqual([[{ labels: [1] }, { labels: [0, 2] }]]);
  });

  it("\"기타\"를 고르면 입력란이 나오고 {other}로 보낸다", () => {
    form();
    const [g0, g1] = screen.getAllByRole("group");
    expect(within(g0).queryByLabelText("기타 답")).toBeNull();
    fireEvent.click(within(g0).getByRole("radio", { name: "기타 (직접 입력)" }));
    const other = within(g0).getByLabelText("기타 답") as HTMLTextAreaElement;
    expect(other.tagName).toBe("TEXTAREA");
    fireEvent.change(other, { target: { value: "망고" } });
    expect(g0.textContent).toContain("2/500");
    fireEvent.click(within(g1).getByRole("checkbox", { name: "치즈" }));
    fireEvent.click(submit());
    expect(sent).toEqual([[{ other: "망고" }, { labels: [1] }]]);
  });

  it("다중 선택의 기타는 다른 선택지와 함께 고를 수 없다", () => {
    form();
    const g1 = screen.getAllByRole("group")[1];
    const cheese = within(g1).getByRole("checkbox", { name: "치즈" }) as HTMLInputElement;
    const other = within(g1).getByRole("checkbox", { name: /^기타 \(직접 입력\)/ }) as HTMLInputElement; // 다중 선택은 이름에 안내 줄이 붙는다
    fireEvent.click(cheese);
    fireEvent.click(other);
    expect(cheese.checked).toBe(false);
    expect(other.checked).toBe(true);
    fireEvent.click(cheese);
    expect(other.checked).toBe(false);
    expect(within(g1).queryByLabelText("기타 답")).toBeNull();
  });

  it("기타 입력은 500자까지", () => {
    form();
    const g0 = screen.getAllByRole("group")[0];
    fireEvent.click(within(g0).getByRole("radio", { name: "기타 (직접 입력)" }));
    const other = within(g0).getByLabelText("기타 답") as HTMLTextAreaElement;
    fireEvent.change(other, { target: { value: "가".repeat(600) } });
    expect(other.value).toHaveLength(500);
    expect(g0.textContent).toContain("500/500");
  });

  it("기타 입력은 서버와 같이 글자(그래핌)로 센다: 이모지가 섞인 500자가 들어가고 카운터가 500", () => {
    form([QS[0]]);
    const g0 = screen.getAllByRole("group")[0];
    fireEvent.click(within(g0).getByRole("radio", { name: "기타 (직접 입력)" }));
    const other = within(g0).getByLabelText("기타 답") as HTMLTextAreaElement;
    const text = "😀".repeat(250) + "가".repeat(250);
    fireEvent.change(other, { target: { value: text } });
    expect(other.value).toBe(text);
    expect(g0.textContent).toContain("500/500");
    fireEvent.change(other, { target: { value: text + "👍🏽" } });
    expect(other.value).toBe(text); // 501번째 글자는 들어가지 않는다
    fireEvent.click(submit());
    expect(sent).toEqual([[{ other: text }]]);
  });

  it("다중 선택의 기타 상자에만 \"고르면 다른 선택은 풀립니다\" 안내가 있다", () => {
    form();
    const [g0, g1] = screen.getAllByRole("group");
    expect(within(g1).getByRole("checkbox", { name: /기타 \(직접 입력\)/ }).closest("label")!.textContent).toContain("고르면 다른 선택은 풀립니다");
    expect(g0.textContent).not.toContain("고르면 다른 선택은 풀립니다");
  });

  it("한글 조합 중 Enter는 보내지 않는다", () => {
    form([QS[0]]);
    const g0 = screen.getAllByRole("group")[0];
    fireEvent.click(within(g0).getByRole("radio", { name: "기타 (직접 입력)" }));
    const other = within(g0).getByLabelText("기타 답");
    fireEvent.change(other, { target: { value: "망고" } });
    fireEvent.keyDown(other, { key: "Enter", isComposing: true });
    fireEvent.keyDown(other, { key: "Enter", shiftKey: true }); // Shift+Enter는 줄바꿈
    expect(sent).toEqual([]);
    fireEvent.keyDown(other, { key: "Enter" });
    expect(sent).toEqual([[{ other: "망고" }]]);
  });

  it("모든 질문에 답하기 전에는 보내기 버튼이 눌리지 않는다", () => {
    form();
    const hint = "모든 질문에 답하면 보낼 수 있습니다";
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(hint)).toBeTruthy();
    const describedBy = submit().getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)!.textContent).toBe(hint);
    const [g0, g1] = screen.getAllByRole("group");
    fireEvent.click(within(g0).getByRole("radio", { name: "기타 (직접 입력)" }));
    fireEvent.click(within(g1).getByRole("checkbox", { name: "치즈" }));
    fireEvent.click(submit());
    expect(sent).toEqual([]); // 기타를 골랐지만 입력이 비어 있으면 답하지 않은 것
    fireEvent.change(within(g0).getByLabelText("기타 답"), { target: { value: "   " } });
    fireEvent.click(submit());
    expect(sent).toEqual([]);
    fireEvent.change(within(g0).getByLabelText("기타 답"), { target: { value: "키위" } });
    expect(submit().getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(hint)).toBeNull();
    fireEvent.click(submit());
    expect(sent).toHaveLength(1);
  });

  it("disabled면 보내지 않는다(보내는 중·잠금)", () => {
    form([QS[0]], true);
    fireEvent.click(within(screen.getAllByRole("group")[0]).getByRole("radio", { name: "배" }));
    fireEvent.click(submit());
    expect(sent).toEqual([]);
    expect(submit().getAttribute("aria-disabled")).toBe("true");
  });

  it("라디오는 화살표 키로 이동한다", () => {
    form([QS[0]]);
    const radios = within(screen.getAllByRole("group")[0]).getAllByRole("radio") as HTMLInputElement[];
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1].checked).toBe(true);
    fireEvent.keyDown(radios[1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[2], { key: "ArrowDown" }); // 끝에서는 처음으로
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(radios[2]);
    expect(radios[2].checked).toBe(true);
  });

  it("label이 같은 선택지 두 개도 따로 고를 수 있다", () => {
    form([{ question: "어느 쪽?", multiSelect: false, options: [{ label: "같음" }, { label: "같음" }] }]);
    const [a, b] = screen.getAllByRole("radio", { name: "같음" }) as HTMLInputElement[];
    expect(a.id).not.toBe(b.id);
    fireEvent.click(b);
    expect(a.checked).toBe(false);
    expect(b.checked).toBe(true);
    fireEvent.click(submit());
    expect(sent).toEqual([[{ labels: [1] }]]);
  });
});

describe("보고서에서 질문 답하기", () => {
  const T0 = Date.UTC(2026, 9, 2, 3);
  const dv = (): DecisionView => ({
    id: "q1",
    sessionId: "s1",
    agent: "developer",
    kind: "question",
    toolName: "AskUserQuestion",
    state: "pending",
    createdAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 590_000).toISOString(),
    detail: {},
    questions: QS,
    answerable: true,
  });

  it("보낸 뒤 배너 \"대시보드에서 답함\"", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const fetchMock = vi.fn(async (url: string) =>
      String(url).startsWith("/api/decisions") ? { ok: true, status: 200, json: async () => ({ state: "answered-dashboard" }) } : { ok: true, status: 200, json: async () => ({}) },
    );
    vi.stubGlobal("fetch", fetchMock);
    const v = dv();
    state.value = {
      ...state.value,
      snapshot: makeSnapshot({
        sessions: [makeSession({ id: "s1", name: "claude_project", floor: 3, members: [makeMember({ name: "developer", state: "decision", decision: { kind: "question", since: v.createdAt, id: v.id, deadline: v.deadline } })] })],
        decisions: [v],
        decisionCount: 1,
      }),
    };
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    const dialog = screen.getByRole("dialog");
    const [g0, g1] = within(dialog).getAllByRole("group");
    fireEvent.click(within(g0).getByRole("radio", { name: /사과/ }));
    fireEvent.click(within(g1).getByRole("checkbox", { name: "치즈" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "이 답 보내기" }));
    const posts = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/decisions"));
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe("/api/decisions/q1");
    expect(JSON.parse((posts[0] as unknown as [string, { body: string }])[1].body)).toEqual({ action: "answer", answers: [{ labels: [0] }, { labels: [1] }] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog.textContent).toContain("대시보드에서 답함");
    expect(screen.getByRole("status").textContent!.trim()).toBe("대시보드에서 답함");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("다른 질문 결정으로 넘기면 고른 상태가 새로 시작한다(key로 초기화)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    const a = dv();
    const b = { ...dv(), id: "q2", agent: "reviewer", createdAt: new Date(T0 + 1000).toISOString() };
    const decided = (v: DecisionView) => ({ state: "decision" as const, decision: { kind: "question" as const, since: v.createdAt, id: v.id, deadline: v.deadline } });
    state.value = {
      ...state.value,
      snapshot: makeSnapshot({
        sessions: [makeSession({ id: "s1", name: "claude_project", floor: 3, members: [makeMember({ name: "developer", ...decided(a) }), makeMember({ name: "reviewer", ...decided(b) })] })],
        decisions: [a, b],
        decisionCount: 2,
      }),
    };
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    const g0 = within(screen.getByRole("dialog")).getAllByRole("group")[0];
    fireEvent.click(within(g0).getByRole("radio", { name: "배" }));
    expect((within(g0).getByRole("radio", { name: "배" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "다음 결정" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("3F claude_project · reviewer");
    const radios = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(within(dialog).getByRole("button", { name: "이 답 보내기" }).getAttribute("aria-disabled")).toBe("true");
  });
});
