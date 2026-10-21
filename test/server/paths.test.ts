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
      tokenFile: resolve("/p/token"),
      hookKeyFile: resolve("/p/hook.key"),
      reportsFile: resolve("/p/reports.json"),
      buildingFile: resolve("/p/building.json"),
      stateFile: resolve("/p/state.json"),
      policyFile: resolve("/p/policy.json"),
    });
  });

  it("없으면 dev, 저장소 .logs", () => {
    expect(resolvePaths({ moduleUrl: url("/repo/server/index.ts"), env: {} })).toEqual({
      mode: "dev",
      prefix: null,
      logDir: resolve("/repo/.logs"),
      diagDir: resolve("/repo/.logs/diagnostics"),
      staticDir: resolve("/repo/dist/web"),
      tokenFile: resolve("/repo/.logs/token"),
      hookKeyFile: resolve("/repo/.logs/hook.key"),
      reportsFile: resolve("/repo/.logs/reports.json"),
      buildingFile: resolve("/repo/.logs/building.json"),
      stateFile: resolve("/repo/.logs/state.json"),
      policyFile: resolve("/repo/.logs/policy.json"),
    });
  });

  it("--log-dir는 로그 폴더만 바꾼다", () => {
    const p = resolvePaths({ moduleUrl: url("/repo/server/index.ts"), env: { CLAUDE_OFFICE_PREFIX: "/p" }, logDir: "/elsewhere" });
    expect(p).toMatchObject({ mode: "installed", logDir: resolve("/elsewhere"), diagDir: resolve("/p/diagnostics"), tokenFile: resolve("/p/token") });
  });

  it("설치본은 <prefix>/token·state.json, 개발은 .logs 아래", () => {
    expect(resolvePaths({ moduleUrl: url("/x/app/app/server.mjs"), env: { CLAUDE_OFFICE_PREFIX: "/p" } })).toMatchObject({ tokenFile: resolve("/p/token"), stateFile: resolve("/p/state.json") });
    // 개발 모드는 --log-dir를 줘도 토큰·상태 파일은 저장소 .logs에 둔다(시험이 고른 임시 로그 폴더와 섞이지 않게)
    expect(resolvePaths({ moduleUrl: url("/repo/server/index.ts"), env: {}, logDir: "/tmp/x" })).toMatchObject({ tokenFile: resolve("/repo/.logs/token"), stateFile: resolve("/repo/.logs/state.json") });
  });

  it("policyFile은 설치본이면 prefix 아래, 개발이면 .logs 아래이고 --log-dir를 따라가지 않는다", () => {
    expect(resolvePaths({ moduleUrl: url("/x/app/app/server.mjs"), env: { CLAUDE_OFFICE_PREFIX: "/p" }, logDir: "/elsewhere" }).policyFile).toBe(resolve("/p/policy.json"));
    expect(resolvePaths({ moduleUrl: url("/repo/server/index.ts"), env: {}, logDir: "/tmp/x" }).policyFile).toBe(resolve("/repo/.logs/policy.json"));
  });
});
