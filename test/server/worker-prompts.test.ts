import { describe, expect, it } from "vitest";
import { WORKER_PROMPT_TTL, WorkerPrompts, parseWorkerPrompt } from "../../server/decisions/workerPrompts";

const T = 1_800_000_000_000;
const ev = (at: number) => ({ at });

describe("팀원 권한 질문 알림(안 A, Notification worker_permission_prompt)", () => {
  it("글에서 팀원 이름·도구를 꺼낸다. 네트워크 질문은 호스트, 모르는 형식은 이름 없이", () => {
    expect(parseWorkerPrompt("developer needs permission for Bash")).toEqual({ name: "developer", tool: "Bash" });
    expect(parseWorkerPrompt("qa-2 needs network access to example.com")).toEqual({ name: "qa-2", tool: "network", target: "example.com" });
    expect(parseWorkerPrompt("Claude needs your permission")).toEqual({ tool: "?" });
    expect(parseWorkerPrompt(undefined)).toEqual({ tool: "?" });
    // 위조 입력 대비 길이 상한
    expect(parseWorkerPrompt(`${"x".repeat(200)} needs permission for Bash`)).toEqual({ tool: "?" });
  });

  it("같은 팀원의 새 알림은 옛것을 대체하고, 대화(층)마다 따로 둔다", () => {
    const w = new WorkerPrompts();
    w.note("s1", "developer needs permission for Bash", T);
    w.note("s1", "developer needs permission for Write", T + 10);
    w.note("s2", "qa needs permission for Bash", T + 20);
    expect(w.open("s1", T + 30, new Map())).toEqual([{ name: "developer", tool: "Write", at: T + 10 }]);
    expect(w.open("s2", T + 30, new Map()).map((p) => p.name)).toEqual(["qa"]);
  });

  it(`${WORKER_PROMPT_TTL / 60_000}분이 지나면 내린다`, () => {
    const w = new WorkerPrompts();
    w.note("s1", "developer needs permission for Bash", T);
    expect(w.open("s1", T + WORKER_PROMPT_TTL, new Map())).toHaveLength(1);
    expect(w.open("s1", T + WORKER_PROMPT_TTL + 1, new Map())).toEqual([]);
  });

  it("알림 뒤에 그 팀원의 이벤트가 오면 내린다(답을 받아 다시 일함). 알림 전 이벤트·다른 팀원 이벤트는 상관없다", () => {
    const w = new WorkerPrompts();
    w.note("s1", "developer needs permission for Bash", T);
    expect(w.open("s1", T + 5, new Map([["developer", [ev(T - 1)]], ["qa", [ev(T + 1)]]]))).toHaveLength(1);
    expect(w.open("s1", T + 5, new Map([["developer", [ev(T - 1), ev(T + 2)]]]))).toEqual([]);
    // 한 번 내린 것은 다시 올라오지 않는다
    expect(w.open("s1", T + 6, new Map())).toEqual([]);
  });

  it("이름을 모르는 알림은 마지막 하나만 두고 시간으로만 내린다", () => {
    const w = new WorkerPrompts();
    w.note("s1", "?", T);
    w.note("s1", "다른 형식", T + 1);
    expect(w.open("s1", T + 2, new Map([["team-lead", [ev(T + 2)]]]))).toEqual([{ tool: "?", at: T + 1 }]);
  });
});
