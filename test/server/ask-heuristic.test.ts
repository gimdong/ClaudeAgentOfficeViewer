import { describe, expect, it } from "vitest";
import { MAX_AWAIT_TEXT, detectAsk, tailText } from "../../server/events/askHeuristic";

// Phase 6b 스펙 4장·9장(참·거짓 각 10, qa #605 예시). 판정 대상은 대화 기록의 마지막 assistant 글 전체
const ASKS: Array<{ t: string; options: string[] }> = [
  { t: "테스트 3건이 실패합니다. 원인은 타임존 처리입니다. 지금 고칠까요?", options: [] },
  { t: "두 가지 방법이 있습니다.\n\n1. 서버에서 캐시를 지운다\n2. 클라이언트에서 다시 받는다\n\n어느 쪽으로 할지 정해 주세요.", options: ["서버에서 캐시를 지운다", "클라이언트에서 다시 받는다"] },
  { t: "PR을 main에 병합해도 되겠습니까", options: [] },
  { t: "Should I push the branch now?", options: [] },
  { t: "배포 전에 확인이 필요합니다. 버전을 beta.15로 올릴지, 그대로 둘지 알려 주세요. 어느 쪽을 원하시나요?", options: [] },
  { t: "Which one do you want?\n1) Keep the old API\n2) Migrate now\n3) Decide later", options: ["Keep the old API", "Migrate now", "Decide later"] },
  { t: "리뷰 결과 Important 2건입니다:\n- 로그에 토큰 길이 노출\n- 재시도 무한 루프\n\n둘 다 이번에 고칠까요, 아니면 첫 번째만 고칠까요?  ", options: [] },
  { t: "다음 중 하나를 골라 주세요.\n1. **A안** — 빠름\n2. **B안** — 안전\n", options: ["A안 — 빠름", "B안 — 안전"] },
  { t: "이 파일은 지워도 될지 모르겠습니다. 지울지 말지 정해 주세요?", options: [] },
  { t: "I found three options:\n1. Retry\n2. Skip\n3. Abort\nLet me know which.", options: ["Retry", "Skip", "Abort"] },
];
const NOT_ASKS = [
  "모든 테스트가 통과했습니다. 커밋 a1b2c3d로 완료했습니다.",
  "수정했습니다. 이제 `url?.trim()`으로 빈 값을 거릅니다.",
  '사용자가 "이걸 지금 배포할까요?"라고 물었던 부분은 Ruling B302로 정리했습니다.',
  "다음 순서로 진행합니다.\n1. 스펙 읽기\n2. 테스트 작성\n3. 구현\n\n지금 1번을 하고 있습니다.",
  "```ts\nconst ok = a ? b : c;\n```\n위처럼 바꿨습니다.",
  "```sh\ncurl 'http://127.0.0.1:4321/?k=…'\n```",
  "Done. Pushed to feat/v2-phase6b and opened PR #42.",
  "남은 일:\n1. 설명서 6장 갱신\n2. 릴리스 노트\n3. 태그는 사용자 승인 후",
  "왜 실패했을까요? 원인을 찾아 보니 포트 충돌이었고, 4321로 바꿔 해결했습니다.",
  "확인 결과 문제없습니다. 질문이 있으면 말씀해 주세요.",
];

describe("detectAsk — 끝말·번호 목록 선택지(스펙 4장)", () => {
  for (const [i, a] of ASKS.entries()) {
    it(`참 ${i + 1}: ${a.t.slice(0, 24).replace(/\n/g, " ")}`, () => {
      expect(detectAsk(a.t)).toEqual({ asks: true, options: a.options });
    });
  }
  for (const [i, t] of NOT_ASKS.entries()) {
    it(`거짓 ${i + 1}: ${t.slice(0, 24).replace(/\n/g, " ")}`, () => {
      expect(detectAsk(t).asks).toBe(false);
    });
  }

  it("선택지는 최대 6개, 글자마다 200자로 자른다", () => {
    const list = Array.from({ length: 8 }, (_, i) => `${i + 1}. ${"x".repeat(250)}`).join("\n");
    const r = detectAsk(`어느 것을 고를지 정해 주세요.\n${list}`);
    expect(r.asks).toBe(true);
    expect(r.options).toHaveLength(6);
    expect(r.options.every((o) => o.length === 200)).toBe(true);
  });

  // 애매(qa 예시 — 테스트 기준으로 쓰지 않고 지금 결과만 남김): "커밋했습니다. 다음으로 Task 4를 시작할까요? (답이 없으면 그대로 진행합니다.)" → false,
  // "진행할까요? 🙂" → false, "Let me know if you want me to continue." → false, "1. 지금 배포\n2. 내일 배포" → false
});

describe(`tailText — 뒤 ${MAX_AWAIT_TEXT}자를 남기고 앞에 …(B313)`, () => {
  it("넘으면 뒤를 남기고 앞에 …, 안 넘으면 그대로", () => {
    const long = "a".repeat(10) + "b".repeat(MAX_AWAIT_TEXT);
    expect(tailText(long)).toBe(`…${"b".repeat(MAX_AWAIT_TEXT)}`);
    expect(tailText("짧은 글")).toBe("짧은 글");
  });
});
