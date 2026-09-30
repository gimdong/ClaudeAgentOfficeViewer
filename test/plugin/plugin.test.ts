import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN = join(ROOT, "plugins/claude-office");
const EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "PermissionDenied", "Notification", "SubagentStart", "SubagentStop", "TeammateIdle", "Stop",
];
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"];

type Hook = { type: string; url: string; timeout: number };
type HookFile = { hooks: Record<string, Array<{ matcher?: string; hooks: Hook[] }>> };
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, "utf8")) as T;
const allHooks = (f: HookFile) => Object.values(f.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));

describe("marketplace.json", () => {
  it("저장소를 claude-office 마켓플레이스로 만들고 플러그인 폴더를 가리킨다", async () => {
    const m = await readJson<{ name: string; plugins: Array<{ name: string; source: string }> }>(join(ROOT, ".claude-plugin/marketplace.json"));
    expect(m.name).toBe("claude-office");
    expect(m.plugins).toEqual([expect.objectContaining({ name: "claude-office", source: "./plugins/claude-office" })]);
  });
});

describe("plugin.json", () => {
  it("이름, 버전 2.0.0-beta.1, 설명, MIT 라이선스를 가진다", async () => {
    const p = await readJson<Record<string, unknown>>(join(PLUGIN, ".claude-plugin/plugin.json"));
    expect(p.name).toBe("claude-office");
    expect(p.version).toBe("2.0.0-beta.1"); // Task 6: 베타 릴리스 버전으로 통일
    expect(typeof p.description).toBe("string");
    expect(p.license).toBe("MIT");
  });

  it("저장소 LICENSE는 MIT이고 package.json도 MIT다 (Ruling P5)", async () => {
    const text = await readFile(join(ROOT, "LICENSE"), "utf8");
    expect(text.startsWith("MIT License")).toBe(true);
    expect(text).toContain("Copyright (c) 2026 gimdong");
    expect((await readJson<{ license?: string }>(join(ROOT, "package.json"))).license).toBe("MIT");
  });
});

describe("hooks.json", () => {
  it("13개 이벤트를 모두, 그리고 그것만 등록한다", async () => {
    const f = await readJson<HookFile>(join(PLUGIN, "hooks/hooks.json"));
    expect(Object.keys(f.hooks).sort()).toEqual([...EVENTS].sort());
  });

  it("모든 hook은 http 타입, 같은 URL, timeout 5 이하다", async () => {
    const f = await readJson<HookFile>(join(PLUGIN, "hooks/hooks.json"));
    const hooks = allHooks(f);
    expect(hooks).toHaveLength(EVENTS.length);
    for (const h of hooks) {
      expect(h.type).toBe("http");
      expect(h.url).toBe("http://127.0.0.1:4317/hooks/event");
      expect(h.timeout).toBeLessThanOrEqual(5);
    }
  });

  it("도구 이벤트는 matcher '*'를 쓴다", async () => {
    const f = await readJson<HookFile>(join(PLUGIN, "hooks/hooks.json"));
    for (const e of TOOL_EVENTS) expect(f.hooks[e].map((g) => g.matcher)).toEqual(["*"]);
  });
});

describe("make-dev-plugin", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "claude-office-plugin-"));
  });
  afterEach(() => rm(tmp, { recursive: true, force: true }));

  it("포트만 바꾸고 나머지는 그대로 복사한다", async () => {
    const out = join(tmp, "dev");
    execFileSync("node", [join(ROOT, "scripts/make-dev-plugin.mjs"), "--port", "4318", "--out", out], { stdio: "pipe" });
    const dev = await readJson<HookFile>(join(out, "hooks/hooks.json"));
    expect(new Set(allHooks(dev).map((h) => h.url))).toEqual(new Set(["http://127.0.0.1:4318/hooks/event"]));
    const origText = await readFile(join(PLUGIN, "hooks/hooks.json"), "utf8");
    const devText = await readFile(join(out, "hooks/hooks.json"), "utf8");
    expect(devText.replaceAll(":4318/", ":4317/")).toBe(origText);
    expect(await readFile(join(out, ".claude-plugin/plugin.json"), "utf8")).toBe(await readFile(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"));
  });

  it("포트가 잘못되면 종료 코드 1", () => {
    expect(() => execFileSync("node", [join(ROOT, "scripts/make-dev-plugin.mjs"), "--port", "99999", "--out", join(tmp, "x")], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync("node", [join(ROOT, "scripts/make-dev-plugin.mjs"), "--port", "4318"], { stdio: "pipe" })).toThrow();
  });
});
