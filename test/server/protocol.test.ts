import { describe, expect, it } from "vitest";
import { budgetReason, buildAnswers, permissionResponse, preToolAsk, preToolDeny } from "../../server/decisions/protocol";

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
    expect(JSON.stringify(preToolDeny("R"))).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"R"}}');
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
