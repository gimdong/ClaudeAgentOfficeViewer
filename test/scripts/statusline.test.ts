import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
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

  // final review I-3: settings.json/백업 쓰기를 원자적으로(tmp + rename) 만든다.
  it("install/remove 후 tmp 파일이 남지 않는다", async () => {
    await h.write("settings.json", { statusLine: { type: "command", command: "echo hi" } });
    execFileSync("node", [SETUP, "install"], { env });
    execFileSync("node", [SETUP, "remove"], { env });
    const rootFiles = await readdir(h.home);
    const officeFiles = await readdir(h.path("claude-office"));
    for (const f of [...rootFiles, ...officeFiles]) expect(f).not.toMatch(/\.tmp-/);
  });

  it("B326 ②: 백업이 없어도 remove는 0 — 우리 tap이 아니면 그대로 두고, 우리 tap이면 original-statusline.sh의 명령으로(없으면 키를 지움)", async () => {
    await h.write("settings.json", { theme: "dark" });
    execFileSync("node", [SETUP, "remove"], { env, stdio: "pipe" });
    expect(await json("settings.json")).toEqual({ theme: "dark" });
    for (const [orig, want] of [["echo O", { type: "command", command: "echo O" }], ["", undefined]] as const) {
      await h.write("settings.json", { theme: "dark", statusLine: { type: "command", command: "echo O" } });
      execFileSync("node", [SETUP, "install"], { env, stdio: "pipe" });
      await h.write("claude-office/original-statusline.sh", `#!/bin/sh\n${orig}\n`);
      for (const f of await readdir(h.path("claude-office"))) if (f.startsWith("settings.backup")) await rm(h.path(`claude-office/${f}`));
      execFileSync("node", [SETUP, "remove"], { env, stdio: "pipe" });
      expect((await json("settings.json")).statusLine, orig).toEqual(want);
    }
  });

  it("B328 Minor-10: 다시 install할 때 지금 값이 우리 tap이 아니면 백업을 새로 만든다", async () => {
    await h.write("settings.json", { statusLine: { type: "command", command: "echo A" } });
    execFileSync("node", [SETUP, "install"], { env });
    await h.write("settings.json", { statusLine: { type: "command", command: "echo B" } }); // 백업이 남은 채 사용자가 바꿈
    execFileSync("node", [SETUP, "install"], { env });
    execFileSync("node", [SETUP, "remove"], { env });
    expect((await json("settings.json")).statusLine.command).toBe("echo B");
  });

  it("B333 m3: 다른 설치본(다른 경로의 tap)을 제거해도 이 설치본의 연결은 되돌리지 않는다", async () => {
    await h.write("settings.json", { statusLine: { type: "command", command: "echo A" } });
    execFileSync("node", [SETUP, "install"], { env });
    const mine = (await json("settings.json")).statusLine.command;
    const other = h.path("other-prefix");
    await mkdir(other, { recursive: true });
    for (const f of ["statusline-setup.mjs", "statusline-tap.sh"]) await copyFile(resolve("scripts", f), `${other}/${f}`);
    execFileSync("node", [`${other}/statusline-setup.mjs`, "remove"], { env, stdio: "pipe" });
    expect((await json("settings.json")).statusLine.command).toBe(mine);
    expect(execFileSync("node", [`${other}/statusline-setup.mjs`, "status"], { env, encoding: "utf8" }).trim()).not.toBe("on");
    // 다른 설치본이 이어받아 켜면 이 tap을 "원래 명령"으로 백업하지 않는다 — 그쪽을 제거하면 사용자 원래 값으로
    execFileSync("node", [`${other}/statusline-setup.mjs`, "install"], { env, stdio: "pipe" });
    execFileSync("node", [`${other}/statusline-setup.mjs`, "remove"], { env, stdio: "pipe" });
    expect((await json("settings.json")).statusLine.command).toBe("echo A");
  });

  it("status는 on·off·other(우리가 연결했던 흔적이 있는데 다른 statusline으로 바뀜)를 낸다", async () => {
    const status = () => execFileSync("node", [SETUP, "status"], { env, encoding: "utf8" }).trim();
    await h.write("settings.json", { statusLine: { type: "command", command: "echo A" } });
    expect(status()).toBe("off");
    execFileSync("node", [SETUP, "install"], { env });
    expect(status()).toBe("on");
    const s = await json("settings.json");
    await h.write("settings.json", { ...s, statusLine: { type: "command", command: "echo B" } });
    expect(status()).toBe("other");
    execFileSync("node", [SETUP, "remove"], { env });
    expect(status()).toBe("off");
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

  // final review I-4: 기존 command가 없으면(기본 상태줄 사용자) 설치 후 상태줄이 비어 보일 수
  // 있다는 사실을 install 시점에 안내한다.
  it("기존 command가 없으면 설치 시 안내를 stderr에 출력한다", async () => {
    await h.write("settings.json", { theme: "dark" });
    const result = spawnSync("node", [SETUP, "install"], { env });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toContain("비어 보일 수");
    // 설치본(--installed)은 설치본에 있는 되돌리기 명령만 안내한다(qa #627 D)
    await h.write("settings.json", { theme: "dark" });
    execFileSync("node", [SETUP, "remove"], { env });
    const installed = spawnSync("node", [SETUP, "install", "--installed"], { env });
    expect(installed.stderr.toString()).toContain("claude-office uninstall");
    expect(installed.stderr.toString()).not.toContain("npm run");
  });

  it("기존 command가 있으면 안내를 출력하지 않는다", async () => {
    await h.write("settings.json", { statusLine: { type: "command", command: "echo hi" } });
    const result = spawnSync("node", [SETUP, "install"], { env });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).not.toContain("비어 보일 수");
  });

  // Task 3: Windows에는 아직 이 기능을 안 만든다. 설치를 시도하지 않고 안내만 하고 끝낸다.
  it("Windows에서는 지원하지 않는다고 알리고 설정을 바꾸지 않는다", async () => {
    await h.write("settings.json", { statusLine: { type: "command", command: "echo hi" } });
    const winEnv = { ...env, STATUSLINE_PLATFORM: "win32" };
    const result = spawnSync("node", [SETUP, "install"], { env: winEnv });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("PLAN 바(statusline 연결)는 Windows에서 지원하지 않습니다."); // qa #627 C: 약속 단어 없이
    expect(await json("settings.json")).toEqual({ statusLine: { type: "command", command: "echo hi" } });
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
