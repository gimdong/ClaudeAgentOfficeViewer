// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../web/App";
import { UNAUTHORIZED_POLL_MS } from "../../web/useSnapshot";
import { makeSnapshot } from "./fixtures";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static count = 0;
  static last: FakeEventSource;
  readyState = FakeEventSource.CONNECTING;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.count++;
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

let status = 401;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.count = 0;
  status = 401;
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn(async (url: string) =>
    String(url) === "/api/snapshot"
      ? { ok: status === 200, status, json: async () => (status === 200 ? makeSnapshot() : { error: "unauthorized", app: "claude-office" }) }
      : { ok: true, status: 200, json: async () => ({}) },
  );
  vi.stubGlobal("fetch", fetchMock);
  document.title = "Claude Office";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
const snapshotCalls = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/snapshot").length;

describe("401 안내 화면(디자인 phase2 §8)", () => {
  it("401이면 안내 화면을 보여 준다", async () => {
    render(<App />);
    await flush();
    const main = screen.getByRole("main");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("터미널에서 claude-office로 열어 주세요");
    expect(main.querySelector("h1 code")!.textContent).toBe("claude-office");
    expect(main.getAttribute("aria-labelledby")).toBe("auth-title");
    expect(main.textContent).toContain("이 화면은 접속 열쇠가 있어야 볼 수 있습니다. 터미널에서 claude-office를 실행하면 열쇠가 담긴 주소로 브라우저가 열립니다.");
    expect(main.textContent).toContain("북마크로 열었는데 이 화면이 보이면, 터미널에서 한 번만 다시 열어 주세요. 그 뒤로는 북마크로 열립니다.");
    expect(main.textContent).toContain("$ claude-office");
    expect(document.title).toBe("접속 열쇠 필요 · Claude Office");
    expect(screen.queryByRole("banner")).toBeNull(); // HUD 없음
  });

  it("401 뒤에는 EventSource를 다시 만들지 않는다", async () => {
    render(<App />);
    await flush();
    expect(FakeEventSource.count).toBe(1);
    expect(FakeEventSource.last.closed).toBe(true);
    const before = snapshotCalls();
    act(() => vi.advanceTimersByTime(UNAUTHORIZED_POLL_MS - 1));
    await flush();
    expect(snapshotCalls()).toBe(before);
    act(() => vi.advanceTimersByTime(1));
    await flush();
    expect(snapshotCalls()).toBe(before + 1); // 30초에 한 번만 다시 본다
    // 다음 확인은 앞의 확인이 끝난 뒤에 건다
    for (let i = 0; i < 3; i++) {
      act(() => vi.advanceTimersByTime(UNAUTHORIZED_POLL_MS));
      await flush();
    }
    expect(FakeEventSource.count).toBe(1);
    expect(snapshotCalls()).toBe(before + 4);
  });

  it("열쇠가 생기면(200) 화면을 바꾸고 스트림을 다시 연다", async () => {
    render(<App />);
    await flush();
    status = 200;
    act(() => vi.advanceTimersByTime(UNAUTHORIZED_POLL_MS));
    await flush();
    expect(screen.queryByRole("heading", { level: 1, name: "터미널에서 claude-office로 열어 주세요" })).toBeNull();
    expect(screen.getByRole("banner")).toBeTruthy(); // HUD가 돌아왔다
    expect(FakeEventSource.count).toBe(2);
    expect(document.title).toBe("Claude Office");
  });

  it("스트림이 닫힌 이유가 401이면 재연결을 되풀이하지 않는다", async () => {
    status = 200;
    render(<App />);
    await flush();
    status = 401;
    act(() => {
      FakeEventSource.last.readyState = FakeEventSource.CLOSED;
      FakeEventSource.last.onerror?.();
    });
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "터미널에서 claude-office로 열어 주세요" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(10_000));
    await flush();
    expect(FakeEventSource.count).toBe(1);
  });
});
