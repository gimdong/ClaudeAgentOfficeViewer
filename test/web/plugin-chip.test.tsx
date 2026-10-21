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
    // 모양(B252): q-chip이 아니라 정책 칩 읽기 실패와 같은 모양, 글자 앞에 진단 warn 삼각형(aria-hidden)
    const chip = screen.getByTestId("plugin-chip");
    expect(chip.className).toBe("plugin-chip");
    const svg = chip.firstElementChild!;
    expect([svg.tagName.toLowerCase(), svg.getAttribute("aria-hidden"), svg.getAttribute("width")]).toEqual(["svg", "true", "14"]);
  });

  it("옛 http 입구로 온 세션이 있으면(legacy) 버전이 같아도 '옛 플러그인(http hook)이 남아 있습니다 — 같은 압축 파일로 다시 설치하세요'(Phase 6a §4)", () => {
    for (const plugin of [{ version: "2.0.0-beta.14", match: true, legacy: true as const }, { version: "2.0.0-beta.13", match: false, legacy: true as const }]) {
      render(<PluginChip snapshot={makeSnapshot({ serverVersion: "2.0.0-beta.14", plugin })} />);
      expect(screen.getByTestId("plugin-chip").textContent).toBe("옛 플러그인(http hook)이 남아 있습니다 — 같은 압축 파일로 다시 설치하세요");
      cleanup();
    }
    expect(PLUGIN_TEXT.legacy).toBe("옛 플러그인(http hook)이 남아 있습니다 — 같은 압축 파일로 다시 설치하세요");
  });

  it("헤더가 없던 옛 플러그인(unknown)은 '플러그인 버전 모름'", () => {
    render(<PluginChip snapshot={makeSnapshot({ serverVersion: "2.0.0-beta.12", plugin: { version: "unknown", match: false } })} />);
    expect(screen.getByTestId("plugin-chip").textContent).toBe(PLUGIN_TEXT.unknown);
    expect(PLUGIN_TEXT.unknown).toBe("플러그인 버전 모름");
  });
});
