// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSnapshot } from "../../web/useSnapshot";

class FakeEventSource {
  static last: FakeEventSource;
  static instanceCount = 0;
  // 실제 EventSource 스펙과 같은 값(CONNECTING=0, OPEN=1, CLOSED=2).
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  listeners = new Map<string, (e: MessageEvent) => void>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  readyState = FakeEventSource.CONNECTING;
  constructor(public url: string) {
    FakeEventSource.last = this;
    FakeEventSource.instanceCount++;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  /** readyState를 지정한 값으로 바꾼 뒤 onerror를 부른다(실제 브라우저가 오류 시 하는 일). */
  triggerError(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

beforeEach(() => {
  FakeEventSource.instanceCount = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ generatedAt: "initial" }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSnapshot", () => {
  it("초기 스냅샷을 받고, SSE 이벤트로 갱신하며, 오류 시 live=false", async () => {
    const { result, unmount } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.snapshot?.generatedAt).toBe("initial"));
    expect(FakeEventSource.last.url).toBe("/api/stream");

    act(() => FakeEventSource.last.emit("snapshot", { generatedAt: "sse" }));
    expect(result.current).toEqual({ snapshot: { generatedAt: "sse" }, live: true, unauthorized: false });

    act(() => FakeEventSource.last.onerror?.());
    expect(result.current.live).toBe(false);

    unmount();
    expect(FakeEventSource.last.closed).toBe(true);
  });

  // director 검토 관점(미리 알림): 깨진 메시지(JSON 파싱 실패)에 훅이 죽지 않을 것.
  // FakeEventSource.emit은 항상 JSON.stringify를 거치므로, 여기서는 listeners 맵을 직접 호출해
  // 파싱 불가능한 원시 데이터를 흉내낸다.
  it("깨진 SSE 메시지가 와도 죽지 않고 이전 상태를 유지하며, 이후 정상 메시지는 계속 반영된다", async () => {
    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.snapshot?.generatedAt).toBe("initial"));

    act(() => FakeEventSource.last.emit("snapshot", { generatedAt: "ok" }));
    expect(result.current.snapshot?.generatedAt).toBe("ok");

    expect(() => {
      act(() => {
        FakeEventSource.last.listeners.get("snapshot")?.({ data: "{not valid json" } as MessageEvent);
      });
    }).not.toThrow();
    expect(result.current.snapshot?.generatedAt).toBe("ok"); // 깨진 메시지는 무시, 이전 값 유지

    act(() => FakeEventSource.last.emit("snapshot", { generatedAt: "after-broken" }));
    expect(result.current.snapshot?.generatedAt).toBe("after-broken"); // 훅은 계속 정상 동작
  });
});

// director 검토 관점: EventSource가 CLOSED(영구 종료)되면 표준은 재연결하지 않는다.
// tsx watch 재시작(개발)이나 배포 전 500 응답 같은 상황에서 새로고침 없이는 복구되지 않던 문제.
describe("useSnapshot - CLOSED 재연결(backoff)", () => {
  it("CLOSED 상태로 오류가 나면 일정 시간 뒤 새 EventSource를 만든다", () => {
    vi.useFakeTimers();
    renderHook(() => useSnapshot());
    expect(FakeEventSource.instanceCount).toBe(1);
    const first = FakeEventSource.last;

    act(() => first.triggerError(FakeEventSource.CLOSED));
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instanceCount).toBe(1); // 아직 backoff 시간이 안 지났다

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(FakeEventSource.instanceCount).toBe(2);
    expect(FakeEventSource.last).not.toBe(first);
    expect(FakeEventSource.last.url).toBe("/api/stream");
  });

  it("네트워크 오류(CONNECTING)면 브라우저 자동 재연결에 맡기고 새로 만들지 않는다(이중 연결 방지)", () => {
    vi.useFakeTimers();
    renderHook(() => useSnapshot());
    const first = FakeEventSource.last;

    act(() => first.triggerError(FakeEventSource.CONNECTING));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(FakeEventSource.instanceCount).toBe(1);
  });

  it("언마운트 후에는 재연결하지 않는다", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSnapshot());
    const first = FakeEventSource.last;

    act(() => first.triggerError(FakeEventSource.CLOSED)); // 재연결 타이머가 걸린 채로
    unmount();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(FakeEventSource.instanceCount).toBe(1);
  });

  it("재연결에 성공(snapshot 이벤트)하면 backoff가 초기값으로 되돌아간다", () => {
    vi.useFakeTimers();
    renderHook(() => useSnapshot());
    const first = FakeEventSource.last;

    act(() => first.triggerError(FakeEventSource.CLOSED));
    act(() => {
      vi.advanceTimersByTime(2000); // 1차 재연결(2초 뒤)
    });
    const second = FakeEventSource.last;
    expect(second).not.toBe(first);

    act(() => second.emit("snapshot", { generatedAt: "reconnected" })); // 재연결 성공 → backoff 초기화

    act(() => second.triggerError(FakeEventSource.CLOSED));
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(FakeEventSource.instanceCount).toBe(2); // 초기화되지 않았다면(4초로 늘었다면) 아직도 재연결 전이어야 맞다
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeEventSource.instanceCount).toBe(3); // 정확히 2초(초기값) 뒤에 재연결됨 — backoff가 초기화됐다는 증거
  });

  it("onopen을 받으면 live=true가 된다", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSnapshot());
    act(() => FakeEventSource.last.onopen?.());
    expect(result.current.live).toBe(true);
  });
});
