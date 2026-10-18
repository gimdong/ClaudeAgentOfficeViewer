// B258: tmux는 new-session -c 값을 형식 확장하고 #(cmd)를 셸로 실행한다. "##"는 글자 그대로의 "#"다.
// 폴더 이름에 #(…)가 든 저장소를 새 층·옮겨 열기로 열어도 명령이 실행되지 않아야 한다
import { describe, expect, it } from "vitest";
import { launchArgs } from "../../server/floors/launch";

const base = { tmuxName: "co-1", claude: "/c/claude", channelSpec: "s", sessionId: "u1", key: "k".repeat(64), port: 4317, name: "n" };
const cwdArg = (cwd: string) => {
  const a = launchArgs({ ...base, cwd });
  return a[a.indexOf("-c") + 1];
};

describe("launchArgs: tmux -c 형식 확장(B258)", () => {
  it("#는 ##로 넘긴다(#(cmd)·#{fmt}·이미 ##인 것 모두)", () => {
    expect(cwdArg("/x/#(id)")).toBe("/x/##(id)");
    expect(cwdArg("/x/#{pane_pid}")).toBe("/x/##{pane_pid}");
    expect(cwdArg("/x/a##b")).toBe("/x/a####b");
  });

  it("#가 없는 폴더는 그대로", () => {
    expect(cwdArg("/w/프로젝트 a")).toBe("/w/프로젝트 a");
  });
});
