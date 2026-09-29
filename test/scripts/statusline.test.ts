import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

const TAP = resolve("scripts/statusline-tap.sh");
const SETUP = resolve("scripts/statusline-setup.mjs");

let h: FakeHome;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  h = await makeHome();
  env = { ...process.env, CLAUDE_CONFIG_DIR: h.home };
});
afterEach(() => h.cleanup());

const json = async (rel: string) => JSON.parse(await readFile(h.path(rel), "utf8"));

describe("statusline-tap.sh", () => {
  it("입력을 limits.json에 저장하고 원래 명령의 출력을 그대로 낸다", async () => {
    await h.write("claude-office/original-statusline.sh", '#!/bin/sh\necho "ORIG:$(cat)"\n');
    execFileSync("chmod", ["755", h.path("claude-office/original-statusline.sh")]);
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } });
    const out = execFileSync("sh", [TAP], { input, env }).toString();
    expect(out.trim()).toBe(`ORIG:${input}`);
    expect(await json("claude-office/limits.json")).toEqual(JSON.parse(input));
  });

  it("원래 명령이 없어도 저장은 한다", async () => {
    const out = execFileSync("sh", [TAP], { input: '{"a":1}', env }).toString();
    expect(out).toBe("");
    expect(await json("claude-office/limits.json")).toEqual({ a: 1 });
  });

  // director 검토 관점(미리 알림): 원래 명령 실패 시 tap의 종료 코드·출력.
  it("원래 명령이 실패해도(0이 아닌 종료 코드) 그 종료 코드와 출력을 그대로 전달한다", async () => {
    await h.write("claude-office/original-statusline.sh", '#!/bin/sh\necho "partial output"\nexit 7\n');
    execFileSync("chmod", ["755", h.path("claude-office/original-statusline.sh")]);
    const input = JSON.stringify({ rate_limits: {} });
    const result = spawnSync("sh", [TAP], { input, env });
    expect(result.status).toBe(7);
    expect(result.stdout.toString().trim()).toBe("partial output");
    // 원래 명령이 실패해도 limits.json 저장은 그보다 먼저 끝나 있어야 한다.
    expect(await json("claude-office/limits.json")).toEqual(JSON.parse(input));
  });

  // director 검토 관점(미리 알림): 경로에 공백이 있을 때 인용.
  it("CLAUDE_CONFIG_DIR 경로에 공백이 있어도 정상 동작한다", async () => {
    const rel = "weird dir with space";
    const spacedEnv = { ...process.env, CLAUDE_CONFIG_DIR: h.path(rel) };
    const input = JSON.stringify({ ok: true });
    const out = execFileSync("sh", [TAP], { input, env: spacedEnv }).toString();
    expect(out).toBe("");
    expect(await json(`${rel}/claude-office/limits.json`)).toEqual({ ok: true });
  });
});

describe("statusline-setup.mjs", () => {
  it("install은 백업·원래 명령 저장 후 tap으로 교체하고, remove는 원래대로 되돌린다", async () => {
    await h.write("settings.json", { theme: "dark", statusLine: { type: "command", command: "echo hi" } });

    execFileSync("node", [SETUP, "install"], { env });
    const installed = await json("settings.json");
    expect(installed.theme).toBe("dark");
    expect(installed.statusLine.command).toContain("statusline-tap.sh");
    expect(await readFile(h.path("claude-office/original-statusline.sh"), "utf8")).toContain("echo hi");
    expect((await json("claude-office/settings.backup.json")).statusLine.command).toBe("echo hi");

    execFileSync("node", [SETUP, "install"], { env }); // 두 번 실행해도 백업을 덮어쓰지 않는다
    expect((await json("claude-office/settings.backup.json")).statusLine.command).toBe("echo hi");

    execFileSync("node", [SETUP, "remove"], { env });
    expect(await json("settings.json")).toEqual({ theme: "dark", statusLine: { type: "command", command: "echo hi" } });
  });

  it("statusLine이 없던 설정도 install/remove 할 수 있다", async () => {
    await h.write("settings.json", { theme: "dark" });
    execFileSync("node", [SETUP, "install"], { env });
    execFileSync("node", [SETUP, "remove"], { env });
    expect(await json("settings.json")).toEqual({ theme: "dark" });
  });

  // director 검토 관점(fix round 1, Ruling 16): remove가 백업을 지우지 않고 install이 백업 있으면
  // 새로 만들지 않아, remove 후 statusLine을 바꾸고 다시 install/remove하면 옛 백업으로 되돌아가던 버그.
  it("remove 후 statusLine을 바꾸고 다시 install/remove하면 바뀐 값으로 복원된다", async () => {
    await h.write("settings.json", { statusLine: { type: "command", command: "echo A" } });
    execFileSync("node", [SETUP, "install"], { env });
    execFileSync("node", [SETUP, "remove"], { env });
    expect((await json("settings.json")).statusLine.command).toBe("echo A");

    // remove 이후 사용자가 statusLine을 바꿨다고 가정한다.
    await h.write("settings.json", { statusLine: { type: "command", command: "echo B" } });
    execFileSync("node", [SETUP, "install"], { env });
    // original-statusline.sh도 매 install마다 현재 값으로 덮어써지는지 함께 확인한다
    // (director 지시: remove 후에도 남아있는 original-statusline.sh가 다음 install에서 덮어써지는지 확인).
    expect(await readFile(h.path("claude-office/original-statusline.sh"), "utf8")).toContain("echo B");
    execFileSync("node", [SETUP, "remove"], { env });
    expect((await json("settings.json")).statusLine.command).toBe("echo B");
  });

  it("remove는 백업을 지우지 않고 타임스탬프를 붙여 보관한다", async () => {
    await h.write("settings.json", { statusLine: { type: "command", command: "echo A" } });
    execFileSync("node", [SETUP, "install"], { env });
    execFileSync("node", [SETUP, "remove"], { env });
    await expect(readFile(h.path("claude-office/settings.backup.json"), "utf8")).rejects.toThrow(); // 원래 이름으로는 더 이상 없다
    const files = await readdir(h.path("claude-office"));
    const renamed = files.filter((f) => f !== "settings.backup.json" && /^settings\.backup\..+\.json$/.test(f));
    expect(renamed).toHaveLength(1);
    expect(JSON.parse(await readFile(h.path(`claude-office/${renamed[0]}`), "utf8")).statusLine.command).toBe("echo A");
  });

  it("백업 없이 remove하면 종료 코드 1", async () => {
    await h.write("settings.json", {});
    expect(() => execFileSync("node", [SETUP, "remove"], { env, stdio: "pipe" })).toThrow();
  });

  // director 검토 관점(미리 알림): 깨진 settings.json이면 건드리지 않고 실패.
  it("settings.json이 깨졌으면 install이 손대지 않고 실패한다", async () => {
    await h.write("settings.json", "{not json");
    expect(() => execFileSync("node", [SETUP, "install"], { env, stdio: "pipe" })).toThrow();
    expect(await readFile(h.path("settings.json"), "utf8")).toBe("{not json");
  });

  it("settings.json이 깨졌으면 remove도 손대지 않고 실패한다", async () => {
    await h.write("settings.json", { theme: "dark", statusLine: { type: "command", command: "echo hi" } });
    execFileSync("node", [SETUP, "install"], { env }); // 정상 설치로 백업을 만들어 둔다
    await h.write("settings.json", "{not json"); // 그 뒤에 settings.json이 깨졌다고 가정
    expect(() => execFileSync("node", [SETUP, "remove"], { env, stdio: "pipe" })).toThrow();
    expect(await readFile(h.path("settings.json"), "utf8")).toBe("{not json");
  });

  // director 검토 관점(미리 알림): 경로에 공백이 있을 때 인용.
  it("CLAUDE_CONFIG_DIR 경로에 공백이 있어도 install/remove가 정상 동작한다", async () => {
    const rel = "weird dir with space";
    const spacedEnv = { ...process.env, CLAUDE_CONFIG_DIR: h.path(rel) };
    await h.write(`${rel}/settings.json`, { theme: "x" });

    execFileSync("node", [SETUP, "install"], { env: spacedEnv });
    const installed = await json(`${rel}/settings.json`);
    expect(installed.statusLine.command).toContain("statusline-tap.sh");

    execFileSync("node", [SETUP, "remove"], { env: spacedEnv });
    expect(await json(`${rel}/settings.json`)).toEqual({ theme: "x" });
  });
});

// 추가 방어(director 권고): CLAUDE_CONFIG_DIR=""(빈 문자열, unset이 아님)일 때 ?? 는 대체하지 않지만
// || 는 대체한다. 실제 스크립트를 CLAUDE_CONFIG_DIR=""로 실행하면 fallback 경로가 진짜 ~/.claude가
// 되어버려 위험하므로(그 자체가 막아야 할 상황), 스크립트를 그렇게 실행하는 테스트는 만들지 않는다.
// 대신 그 판단의 근거가 되는 JS 연산자 의미 차이만 별도로 문서화해 둔다.
describe("빈 문자열 CLAUDE_CONFIG_DIR에 대한 ?? vs || (문서화용, 스크립트를 실행하지 않음)", () => {
  it("??는 빈 문자열을 대체하지 않고, ||는 대체한다", () => {
    const empty: string = ""; // string으로 넓혀서 tsc가 리터럴 타입으로 항상 falsy/non-nullish라고 단정하지 않게 한다
    expect(empty ?? "fallback").toBe("");
    expect(empty || "fallback").toBe("fallback");
  });
});
