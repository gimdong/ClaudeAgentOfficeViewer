import { describe, expect, it } from "vitest";
import { OTHER_MAX, budgetReason, buildAnswers, parseAnswer, permissionResponse, preToolAsk } from "../../server/decisions/protocol";
import { toGraphemes } from "../../server/events/summarize";
import { OTHER_MAX as WEB_OTHER_MAX } from "../../web/report/QuestionForm";
import { graphemes } from "../../web/report/text";

describe("hook 응답 형식(스펙 2장, 계획 Global Constraints)", () => {
  it("권한 응답 JSON이 글자 그대로다", () => {
    expect(permissionResponse("allow")).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(JSON.stringify(permissionResponse("deny", { message: "이유" }))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"이유"}}}',
    );
    expect(permissionResponse("allow", { updatedInput: { a: 1 } })).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { a: 1 } } },
    });
    expect(JSON.stringify(preToolAsk("R"))).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"R"}}');
  });

  it("budgetReason은 천 단위 쉼표와 스펙 문구", () => {
    expect(budgetReason(500000)).toBe("예산(500,000토큰)에 도달했습니다. 대시보드나 이 창에서 계속할지 정해 주세요");
  });
});

const Q = (question: string, labels: string[], multiSelect = false) => ({ question, header: "H", multiSelect, options: labels.map((label) => ({ label, description: "d" })) });

describe("buildAnswers", () => {
  const input = { questions: [Q("과일은?", ["사과", "배"]), Q("토핑은?", ["버섯", "치즈", "올리브"], true)] };

  it("buildAnswers: 단일·다중·기타", () => {
    expect(buildAnswers(input, [{ labels: [1] }, { labels: [0, 2] }])).toEqual({ "과일은?": "배", "토핑은?": "버섯, 올리브" });
    expect(buildAnswers(input, [{ other: "자유" }, { labels: [1] }])).toEqual({ "과일은?": "자유", "토핑은?": "치즈" });
  });

  it("buildAnswers: 가려진 질문도 원문 그대로 answers의 키가 된다", () => {
    const raw = `token=FAKE12345 무엇을 할까요 ${"꼬".repeat(300)}`;
    const out = buildAnswers({ questions: [Q(raw, ["예"])] }, [{ labels: [0] }]);
    expect(Object.keys(out!)).toEqual([raw]);
  });

  it("질문 원문이 __proto__여도 answers에 들어간다", () => {
    const out = buildAnswers({ questions: [Q("__proto__", ["a"]), Q("constructor", ["b"])] }, [{ labels: [0] }, { other: "자유" }]);
    expect(Object.keys(out!)).toEqual(["__proto__", "constructor"]);
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse('{"__proto__":"a","constructor":"자유"}'));
  });

  it("buildAnswers: 어긋나면 null", () => {
    expect(buildAnswers(input, [{ labels: [0] }])).toBeNull(); // 개수
    expect(buildAnswers(input, [{ labels: [2] }, { labels: [0] }])).toBeNull(); // 범위 밖
    expect(buildAnswers(input, [{ labels: [-1] }, { labels: [0] }])).toBeNull();
    expect(buildAnswers(input, [{ labels: [0, 1] }, { labels: [0] }])).toBeNull(); // 단일 선택에 둘
    expect(buildAnswers(input, [{ labels: [] }, { labels: [0] }])).toBeNull();
    expect(buildAnswers(input, [{ labels: [0] }, { labels: [1, 1] }])).toBeNull(); // 같은 선택지 두 번
    expect(buildAnswers(input, [{ other: "" }, { labels: [0] }])).toBeNull();
    expect(buildAnswers(input, [{ other: "   " }, { labels: [0] }])).toBeNull();
    expect(buildAnswers(input, [{ other: "가".repeat(501) }, { labels: [0] }])).toBeNull();
    expect(buildAnswers(input, [{ other: "가".repeat(500) }, { labels: [0] }])).not.toBeNull();
    expect(buildAnswers({ questions: "x" }, [{ labels: [0] }])).toBeNull();
    expect(buildAnswers(null, [])).toBeNull();
    expect(buildAnswers(input, "x" as never)).toBeNull();
    expect(buildAnswers(input, [{ labels: [0.5] }, { labels: [0] }] as never)).toBeNull();
  });
});

describe("parseAnswer(답 본문 모양)", () => {
  it("다섯 가지 모양만 받는다", () => {
    expect(parseAnswer({ action: "allow" })).toEqual({ action: "allow" });
    expect(parseAnswer({ action: "deny" })).toEqual({ action: "deny" });
    expect(parseAnswer({ action: "deny", reason: "r" })).toEqual({ action: "deny", reason: "r" });
    expect(parseAnswer({ action: "continue" })).toEqual({ action: "continue" });
    expect(parseAnswer({ action: "stop" })).toEqual({ action: "stop" });
    expect(parseAnswer({ action: "answer", answers: [{ labels: [0, 1] }, { other: "x" }] })).toEqual({ action: "answer", answers: [{ labels: [0, 1] }, { other: "x" }] });
  });

  it("임의 키·큰 배열·__proto__·틀린 타입은 null", () => {
    for (const bad of [
      null, [], "x", 1, {}, { action: "nope" }, { action: 1 },
      { action: "allow", extra: 1 }, { action: "deny", reason: 1 }, { action: "stop", reason: "r" },
      { action: "answer" }, { action: "answer", answers: "x" }, { action: "answer", answers: Array(3000).fill({ labels: [0] }) },
      { action: "answer", answers: [{ labels: [0], other: "x" }] }, { action: "answer", answers: [{ labels: ["0"] }] },
      { action: "answer", answers: [{ labels: Array(100).fill(0) }] }, { action: "answer", answers: [{ other: 1 }] }, { action: "answer", answers: [null] },
      JSON.parse('{"__proto__":{"x":1},"action":"allow"}'),
      JSON.parse('{"action":"answer","answers":[{"__proto__":{},"labels":[0]}]}'),
    ]) expect(parseAnswer(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("화면과 서버가 같은 기준으로 센다(Ruling B72)", () => {
  it("기타 답 상한 OTHER_MAX가 화면과 서버에서 같다", () => {
    expect(WEB_OTHER_MAX).toBe(OTHER_MAX);
  });

  it("화면 graphemes와 서버 toGraphemes가 이모지·결합 문자에 같은 결과를 낸다", () => {
    const s = "가👍🏽나👨‍👩‍👧e\u0301🇰🇷한\u1100\u1161";
    expect(graphemes(s)).toEqual(toGraphemes(s));
    expect(graphemes(s)).toHaveLength(8);
  });
});
