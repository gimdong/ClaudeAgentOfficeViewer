import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePaths } from "../../server/paths";

const url = (p: string) => pathToFileURL(resolve(p)).href;

describe("resolvePaths", () => {
  it("CLAUDE_OFFICE_PREFIX가 있으면 installed", () => {
    expect(resolvePaths({ moduleUrl: url("/x/app/app/server.mjs"), env: { CLAUDE_OFFICE_PREFIX: "/p" } })).toEqual({
      mode: "installed",
      prefix: resolve("/p"),
      logDir: resolve("/p/logs"),
      diagDir: resolve("/p/diagnostics"),
      staticDir: resolve("/x/app/app/web"),
    });
  });

  it("없으면 dev, 저장소 .logs", () => {
    expect(resolvePaths({ moduleUrl: url("/repo/server/index.ts"), env: {} })).toEqual({
      mode: "dev",
      prefix: null,
      logDir: resolve("/repo/.logs"),
      diagDir: resolve("/repo/.logs/diagnostics"),
      staticDir: resolve("/repo/dist/web"),
    });
  });

  it("--log-dir는 로그 폴더만 바꾼다", () => {
    const p = resolvePaths({ moduleUrl: url("/repo/server/index.ts"), env: { CLAUDE_OFFICE_PREFIX: "/p" }, logDir: "/elsewhere" });
    expect(p).toMatchObject({ mode: "installed", logDir: resolve("/elsewhere"), diagDir: resolve("/p/diagnostics") });
  });
});
