// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSnapshot } from "../../web/useSnapshot";

class FakeEventSource {
  static last: FakeEventSource;
  listeners = new Map<string, (e: MessageEvent) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ generatedAt: "initial" }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSnapshot", () => {
  it("초기 스냅샷을 받고, SSE 이벤트로 갱신하며, 오류 시 live=false", async () => {
    const { result, unmount } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.snapshot?.generatedAt).toBe("initial"));
    expect(FakeEventSource.last.url).toBe("/api/stream");

    act(() => FakeEventSource.last.emit("snapshot", { generatedAt: "sse" }));
    expect(result.current).toEqual({ snapshot: { generatedAt: "sse" }, live: true });

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
