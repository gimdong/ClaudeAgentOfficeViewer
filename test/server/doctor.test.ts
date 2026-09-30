import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultProbePort, formatDoctor, runDoctor, type DoctorDeps, type DoctorItem } from "../../server/diag/doctor";
import type { HookStatsView } from "../../server/events/stats";
import type { OfficePaths } from "../../server/paths";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

// 자격 증명 파일을 열지 않는지 보려고 파일 읽기 함수를 감싸 경로를 기록한다(vi.mock은 import보다 먼저 실행된다)
const opened: string[] = vi.hoisted(() => []);
vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return { ...m, readFile: (p: unknown, ...a: unknown[]) => (opened.push(String(p)), (m.readFile as (...x: unknown[]) => unknown)(p, ...a)) };
});
vi.mock("node:fs", async (orig) => {
  const m = await orig<typeof import("node:fs")>();
  return { ...m, readFileSync: (p: unknown, ...a: unknown[]) => (opened.push(String(p)), (m.readFileSync as (...x: unknown[]) => unknown)(p, ...a)) };
});


const NOW = Date.UTC(2026, 9, 1, 3);
const FAKE_SECRET = "FAKE-sk-ant-xxx";
let h: FakeHome;
let paths: OfficePaths;
beforeEach(async () => {
  h = await makeHome();
  opened.length = 0;
  await h.write("app/web/index.html", "<!doctype html>");
  await h.write("app/server.mjs", "");
  paths = { mode: "installed", prefix: h.path("prefix"), logDir: h.path("prefix/logs"), diagDir: h.path("prefix/diagnostics"), staticDir: h.path("app/web") };
});
afterEach(() => h.cleanup());

const stats = (o: Partial<HookStatsView> = {}): HookStatsView => ({
  total: 0,
  byEvent: {},
  lastAt: null,
  rejected: { "403": 0, "415": 0, "413": 0, "400": 0 },
  last10min: 0,
  ...o,
});

function deps(o: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    claudeHome: h.path(".claude"),
    paths,
    port: 4317,
    nodeVersion: "v24.1.0",
    platform: "darwin",
    env: {},
    managedPath: h.path("managed-settings.json"),
    which: () => "/fake/bin/claude",
    probePort: async () => "ours",
    hooks: async () => stats({ total: 5, last10min: 3 }),
    now: () => NOW,
    ...o,
  };
}

async function item(id: string, o: Partial<DoctorDeps> = {}): Promise<DoctorItem> {
  const found = (await runDoctor(deps(o))).find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe("runDoctor", () => {
  it("항목 id 순서가 고정이다", async () => {
    expect((await runDoctor(deps())).map((i) => i.id)).toEqual(["node", "app", "port", "claude_home", "claude_cli", "plugin", "managed", "proxy", "hooks", "statusline"]);
  });

  it("점검 하나가 던지면 그 항목만 warn(확인 중 오류)이고 나머지는 낸다", async () => {
    const items = await runDoctor(deps({ probePort: async () => { throw new Error("boom"); }, which: () => { throw new Error("boom"); } }));
    expect(items).toHaveLength(10);
    expect(items.find((i) => i.id === "port")).toMatchObject({ status: "warn", title: "포트", detail: "확인 중 오류" });
    expect(items.find((i) => i.id === "claude_cli")).toMatchObject({ status: "warn", detail: "확인 중 오류" });
    expect(items.find((i) => i.id === "node")!.status).toBe("ok");
  });

  it("node", async () => {
    expect((await item("node", { nodeVersion: "v22.0.0" })).status).toBe("fail");
    expect((await item("node", { nodeVersion: "v24.1.0" })).status).toBe("ok");
  });

  it("app: 화면 파일이 없으면 fail", async () => {
    const i = await item("app", { paths: { ...paths, staticDir: h.path("nowhere") } });
    expect(i.status).toBe("fail");
    expect(i.fix).toContain("다시 설치");
    expect((await item("app")).status).toBe("ok");
  });

  it("port", async () => {
    expect((await item("port", { probePort: async () => "ours" })).status).toBe("ok");
    const other = await item("port", { probePort: async () => "other" });
    expect(other.status).toBe("fail");
    expect(other.detail).toContain("다른 프로그램이 4317을 쓰고 있습니다");
    const free = await item("port", { probePort: async () => "free" });
    expect(free.status).toBe("warn");
    expect(free.detail).toContain("서버가 꺼져 있습니다");
    const hung = await item("port", { probePort: async () => "timeout" });
    expect(hung.status).toBe("warn");
    expect(hung.detail).toContain("응답이 없습니다");
    expect(hung.detail).not.toContain("다른 프로그램");
    const moved = await item("port", { port: 4399, probePort: async () => "ours" });
    expect(moved.status).toBe("warn");
    expect(moved.detail).toContain("4317");
  });

  it("claude_home: 없으면 fail, 있으면 개수만", async () => {
    expect((await item("claude_home")).status).toBe("fail");
    await h.write(".claude/sessions/1.json", {});
    await h.write(".claude/sessions/2.json", {});
    for (const p of ["-a", "-b", "-c"]) await mkdir(h.path(`.claude/projects/${p}`), { recursive: true });
    const i = await item("claude_home");
    expect(i.status).toBe("ok");
    expect(i.detail).toBe("세션 2개, 프로젝트 3개");
  });

  it("claude_cli: 경로는 넣지 않는다", async () => {
    expect((await item("claude_cli", { which: () => null })).status).toBe("warn");
    const i = await item("claude_cli");
    expect(i.status).toBe("ok");
    expect(JSON.stringify(i)).not.toContain("/fake/bin");
  });

  it("plugin: enabledPlugins만 읽고 다른 값은 내보내지 않는다", async () => {
    await h.write(".claude/settings.json", { env: { ANTHROPIC_API_KEY: FAKE_SECRET }, enabledPlugins: { "claude-office@claude-office": true } });
    const all = await runDoctor(deps());
    expect(all.find((i) => i.id === "plugin")!.status).toBe("ok");
    expect(JSON.stringify(all)).not.toContain(FAKE_SECRET);
    await h.write(".claude/settings.json", { env: { ANTHROPIC_API_KEY: FAKE_SECRET } });
    const missing = await item("plugin");
    expect(missing.status).toBe("warn");
    expect(missing.fix).toContain("claude plugin install claude-office@claude-office");
  });

  it("managed: 파일 없음 ok, 훅 차단 fail, 허용 목록 확인", async () => {
    const none = await item("managed");
    expect(none).toMatchObject({ status: "ok", detail: "파일 없음(회사가 다른 방식으로 정책을 배포했을 수 있음)" });

    await writeFile(h.path("managed-settings.json"), JSON.stringify({ allowManagedHooksOnly: true, apiKeyHelper: FAKE_SECRET }));
    const blocked = await runDoctor(deps());
    expect(blocked.find((i) => i.id === "managed")!.status).toBe("fail");
    expect(JSON.stringify(blocked)).not.toContain(FAKE_SECRET);

    await writeFile(h.path("managed-settings.json"), JSON.stringify({ allowManagedHooksOnly: true, enabledPlugins: { "claude-office@claude-office": true } }));
    expect((await item("managed")).status).toBe("ok");

    await writeFile(h.path("managed-settings.json"), JSON.stringify({ allowedHttpHookUrls: ["https://corp.example/*"] }));
    expect((await item("managed")).status).toBe("fail");
    await writeFile(h.path("managed-settings.json"), JSON.stringify({ allowedHttpHookUrls: ["https://corp.example/*", "http://127.0.0.1:4317/*"] }));
    expect((await item("managed")).status).toBe("ok");
    await writeFile(h.path("managed-settings.json"), JSON.stringify({ allowedHttpHookUrls: ["http://127.0.0.1:*"] }));
    expect((await item("managed")).status).toBe("ok");
  });

  it("managed 파일이 없고 hook이 0건이면 hooks 안내에 부록 A를 붙인다", async () => {
    const zero = async () => stats();
    expect((await item("hooks", { hooks: zero })).fix).toContain("부록 A");
    // hook이 1건 이상이면 붙이지 않는다
    expect((await item("hooks", { hooks: async () => stats({ total: 1, last10min: 1 }) })).fix).not.toContain("부록 A");
    // 서버가 꺼져 확인하지 못한 경우도 0건이 아니다
    expect((await item("hooks", { hooks: async () => null })).fix).not.toContain("부록 A");
    // managed 파일이 있으면(그 항목이 원인을 직접 보여 주므로) 붙이지 않는다
    await writeFile(h.path("managed-settings.json"), JSON.stringify({ allowedHttpHookUrls: ["http://127.0.0.1:4317/*"] }));
    expect((await item("hooks", { hooks: zero })).fix).not.toContain("부록 A");
  });

  it("proxy: 주소는 넣지 않는다", async () => {
    expect((await item("proxy")).status).toBe("ok");
    const w = await item("proxy", { env: { HTTPS_PROXY: "http://fakeproxy.corp:8080" } });
    expect(w.status).toBe("warn");
    expect(JSON.stringify(w)).not.toContain("fakeproxy");
    expect((await item("proxy", { env: { https_proxy: "http://fakeproxy.corp:8080", NO_PROXY: "corp, localhost" } })).status).toBe("ok");
    expect((await item("proxy", { env: { HTTP_PROXY: "http://fakeproxy.corp:8080", no_proxy: "127.0.0.1" } })).status).toBe("ok");
  });

  it("hooks", async () => {
    const off = await item("hooks", { hooks: async () => null });
    expect(off).toMatchObject({ status: "warn", detail: "서버가 꺼져 있어 확인하지 못했습니다" });
    const zero = await item("hooks", { hooks: async () => stats() });
    expect(zero.status).toBe("warn");
    expect(zero.fix).toContain("플러그인");
    const ok = await item("hooks", { hooks: async () => stats({ total: 9, last10min: 4 }) });
    expect(ok).toMatchObject({ status: "ok", detail: "최근 10분 4건" });
    const rej = await item("hooks", { hooks: async () => stats({ total: 9, last10min: 4, rejected: { "403": 2, "415": 0, "413": 0, "400": 1 } }) });
    expect(rej.status).toBe("warn");
    expect(rej.detail).toContain("3");
  });

  it("statusline: limits.json 없음·최근·오래됨", async () => {
    expect((await item("statusline")).status).toBe("warn");
    await h.write(".claude/claude-office/limits.json", {});
    const t = new Date(NOW - 10 * 60_000);
    await utimes(h.path(".claude/claude-office/limits.json"), t, t);
    expect((await item("statusline")).status).toBe("ok");
    const old = new Date(NOW - 3 * 3_600_000);
    await utimes(h.path(".claude/claude-office/limits.json"), old, old);
    expect((await item("statusline")).status).toBe("warn");
  });

  it("자격 증명 파일을 열지 않는다", async () => {
    await h.write(".claude/.credentials.json", { token: FAKE_SECRET });
    await h.write(".claude/fake.key", FAKE_SECRET);
    await h.write(".claude/settings.json", { enabledPlugins: {} });
    const all = await runDoctor(deps());
    expect(opened.length).toBeGreaterThan(0); // 감시가 실제로 동작함
    expect(opened.filter((p) => p.endsWith(".credentials.json") || p.endsWith(".key"))).toEqual([]);
    expect(JSON.stringify(all)).not.toContain(FAKE_SECRET);
  });
});

describe("defaultProbePort", () => {
  it("연결은 되는데 답이 없으면 timeout", async () => {
    const { createServer } = await import("node:net");
    const hang = createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => hang.once("listening", r));
    const p = (hang.address() as { port: number }).port;
    try {
      expect(await defaultProbePort(p)).toBe("timeout");
    } finally {
      hang.close();
    }
  }, 5000);

  it("아무도 없으면 free", async () => {
    const { createServer } = await import("node:net");
    const s = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const p = (s.address() as { port: number }).port;
    await new Promise((r) => s.close(r));
    expect(await defaultProbePort(p)).toBe("free");
  });
});

describe("formatDoctor", () => {
  it("상태 기호와 고칠 방법 줄", () => {
    const out = formatDoctor([
      { id: "a", status: "ok", title: "A", detail: "좋음", fix: "" },
      { id: "b", status: "warn", title: "B", detail: "주의", fix: "이렇게" },
      { id: "c", status: "fail", title: "C", detail: "나쁨", fix: "저렇게" },
    ]).split("\n");
    expect(out[0].startsWith("✅")).toBe(true);
    expect(out[1].startsWith("⚠️")).toBe(true);
    expect(out[2]).toBe("  → 이렇게");
    expect(out[3].startsWith("❌")).toBe(true);
    expect(out[4]).toBe("  → 저렇게");
  });
});
