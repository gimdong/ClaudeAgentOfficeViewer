// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_TEXT, PluginChip } from "../../web/hud/PluginChip";
import { makeSnapshot } from "./fixtures";

afterEach(cleanup);

describe("플러그인 버전 칩(Phase 5 §3)", () => {
  it("plugin이 없거나 match면 그리지 않는다", () => {
    const { container, rerender } = render(<PluginChip snapshot={makeSnapshot({ serverVersion: "2.0.0-beta.12" })} />);
    expect(container.innerHTML).toBe("");
    rerender(<PluginChip snapshot={makeSnapshot({ serverVersion: "2.0.0-beta.12", plugin: { version: "2.0.0-beta.12", match: true } })} />);
    expect(container.innerHTML).toBe("");
  });

  it("다르면 '플러그인 {version} ≠ 서버 {서버 버전} — 같은 압축 파일로 다시 설치하세요'", () => {
    render(<PluginChip snapshot={makeSnapshot({ serverVersion: "2.0.0-beta.12", plugin: { version: "2.0.0-beta.11", match: false } })} />);
    expect(screen.getByTestId("plugin-chip").textContent).toBe("플러그인 2.0.0-beta.11 ≠ 서버 2.0.0-beta.12 — 같은 압축 파일로 다시 설치하세요");
    expect(PLUGIN_TEXT.mismatch("a", "b")).toBe("플러그인 a ≠ 서버 b — 같은 압축 파일로 다시 설치하세요");
  });

  it("헤더가 없던 옛 플러그인(unknown)은 '플러그인 버전 모름'", () => {
    render(<PluginChip snapshot={makeSnapshot({ serverVersion: "2.0.0-beta.12", plugin: { version: "unknown", match: false } })} />);
    expect(screen.getByTestId("plugin-chip").textContent).toBe(PLUGIN_TEXT.unknown);
    expect(PLUGIN_TEXT.unknown).toBe("플러그인 버전 모름");
  });
});
