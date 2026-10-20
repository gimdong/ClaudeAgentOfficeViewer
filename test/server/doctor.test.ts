import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { chmodSync, existsSync, utimesSync } from "node:fs";
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
const FAKE_TOKEN = "f".repeat(64);
let h: FakeHome;
let paths: OfficePaths;
beforeEach(async () => {
  h = await makeHome();
  opened.length = 0;
  await h.write("app/web/index.html", "<!doctype html>");
  await h.write("app/server.mjs", "");
  paths = { mode: "installed", prefix: h.path("prefix"), logDir: h.path("prefix/logs"), diagDir: h.path("prefix/diagnostics"), staticDir: h.path("app/web"), tokenFile: h.path("prefix/token"), hookKeyFile: h.path("prefix/hook.key"), stateFile: h.path("prefix/state.json"), policyFile: h.path("prefix/policy.json") };
});
afterEach(() => h.cleanup());

const stats = (o: Partial<HookStatsView> = {}): HookStatsView => ({
  total: 0,
  byEvent: {},
  lastAt: null,
  rejected: { "403": 0, "415": 0, "413": 0, "400": 0, "403-uid": 0, "401-v2": 0 },
  v2: 0,
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
    expect((await runDoctor(deps())).map((i) => i.id)).toEqual(["node", "app", "port", "claude_home", "claude_cli", "plugin", "token", "hook_timeout", "managed", "proxy", "hooks", "statusline"]);
  });

  it("점검 하나가 던지면 그 항목만 warn(확인 중 오류)이고 나머지는 낸다", async () => {
    const items = await runDoctor(deps({ probePort: async () => { throw new Error("boom"); }, which: () => { throw new Error("boom"); } }));
    expect(items).toHaveLength(12);
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
    // B261: 모르는 프로그램이면 다른 포트로 피하지 말고 플러그인을 꺼 두라고 안내한다(detail 글자는 문서가 인용해 그대로)
    expect(other.fix).toBe("직접 켠 프로그램이면 그 프로그램을 끄거나 다른 포트로 켜 주세요(다른 포트에서는 말풍선·손들기가 보이지 않습니다. 플러그인은 4317로 보냄). 모르는 프로그램이면 다른 포트로 켜지 말고, 무엇인지 확인한 뒤 비워질 때까지 플러그인을 꺼 두세요: claude plugin disable claude-office@claude-office --scope user");
    const free = await item("port", { probePort: async () => "free" });
    expect(free.status).toBe("warn");
    expect(free.detail).toContain("서버가 꺼져 있습니다");
    const hung = await item("port", { probePort: async () => "timeout" });
    expect(hung.status).toBe("warn");
    expect(hung.detail).toContain("응답이 없습니다");
    expect(hung.detail).not.toContain("다른 프로그램");
    // FB-2: /api/snapshot은 응답하는데 /api/diagnostics가 없으면 이전 버전(v1)
    const old = await item("port", { probePort: async () => "v1" });
    expect(old.status).toBe("warn");
    expect(old.detail).toBe("이전 버전(v1) 서버가 4317을 쓰고 있습니다 — 끄고 다시 실행해 주세요");
    expect(old.fix).toContain("claude-office");
    expect((await item("port", { port: 4399, probePort: async () => "v1" })).detail).toContain("4399을 쓰고");
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

  it("token: 있으면 ok '있음', 없으면 warn과 다시 켜기 안내, 권한이 넓으면 warn(값은 내보내지 않음)", async () => {
    const missing = await item("token");
    expect(missing).toMatchObject({ status: "warn", detail: "없음", fix: "claude-office를 다시 켜면 만들어집니다" });
    await h.write("prefix/token", FAKE_TOKEN);
    chmodSync(h.path("prefix/token"), 0o600);
    const ok = await item("token");
    expect(ok).toMatchObject({ status: "ok", detail: "있음" });
    chmodSync(h.path("prefix/token"), 0o644);
    const loose = await item("token", { platform: "darwin" });
    expect(loose).toMatchObject({ status: "warn", detail: "있음(권한 확인 필요)" });
    expect(loose.fix).toContain("claude-office를 다시 켜면");
    // Windows는 권한 비트를 보지 않는다
    expect((await item("token", { platform: "win32" })).status).toBe("ok");
    const all = await runDoctor(deps());
    expect(JSON.stringify(all)).not.toContain(FAKE_TOKEN);
  });

  it("토큰 파일을 열지 않는다(존재와 권한만 본다)", async () => {
    await h.write("prefix/token", FAKE_TOKEN);
    opened.length = 0;
    await runDoctor(deps());
    expect(opened.filter((p) => p === paths.tokenFile || p.endsWith("/token"))).toEqual([]);
  });

  it("hook_timeout: 가장 최근 버전 폴더의 PermissionRequest timeout이 600이면 ok, 아니면 warn, 캐시가 없으면 warn", async () => {
    const cache = (v: string) => `.claude/plugins/cache/claude-office/claude-office/${v}/hooks/hooks.json`;
    const hooks = (t: number) => ({ hooks: { PreToolUse: [{ hooks: [{ type: "http", url: "http://127.0.0.1:4317/hooks/event", timeout: 5 }] }], PermissionRequest: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:4317/hooks/event", timeout: t }] }] } });
    const none = await item("hook_timeout");
    expect(none).toMatchObject({ status: "warn", detail: "플러그인 캐시 없음" });
    expect(none.fix).toContain("claude plugin install claude-office@claude-office");
    await h.write(cache("2.0.0-beta.2"), hooks(5));
    const old = await item("hook_timeout");
    expect(old).toMatchObject({ status: "warn", detail: "5초 — 대시보드에서 답하려면 플러그인을 업데이트해 주세요" });
    expect(old.fix).toContain("claude plugin");
    // 새 버전 폴더(더 최근 mtime)가 생기면 그것을 본다
    await h.write(cache("2.1.0-dev"), hooks(600));
    const past = new Date(NOW - 3_600_000);
    utimesSync(h.path(".claude/plugins/cache/claude-office/claude-office/2.0.0-beta.2"), past, past);
    expect(await item("hook_timeout")).toMatchObject({ status: "ok", detail: "600초" });
    // 반대로 옛 폴더가 더 최근이면 옛 폴더를 본다
    const later = new Date(Date.now() + 60_000);
    utimesSync(h.path(".claude/plugins/cache/claude-office/claude-office/2.0.0-beta.2"), later, later);
    expect((await item("hook_timeout")).detail).toContain("5초");
  });

  it("hook_timeout: hooks.json이 깨졌거나 PermissionRequest 항목이 없으면 던지지 않고 warn('알 수 없음', '초'를 붙이지 않음)", async () => {
    const file = ".claude/plugins/cache/claude-office/claude-office/2.1.0-dev/hooks/hooks.json";
    await h.write(file, "{not json");
    const broken = await item("hook_timeout");
    expect(broken).toMatchObject({ status: "warn", detail: "알 수 없음 — 대시보드에서 답하려면 플러그인을 업데이트해 주세요" });
    expect(broken.detail).not.toContain("초");
    await h.write(file, { hooks: { PreToolUse: [{ hooks: [{ type: "http", url: "http://127.0.0.1:4317/hooks/event", timeout: 5 }] }] } });
    const missing = await item("hook_timeout");
    expect(missing).toMatchObject({ status: "warn", detail: "알 수 없음 — 대시보드에서 답하려면 플러그인을 업데이트해 주세요" });
    expect(missing.fix).toContain("claude plugin update claude-office@claude-office");
  });

  it("hook_timeout: 등록된 installPath를 캐시의 최근 폴더보다 먼저 본다(FB-4: 업그레이드 뒤 등록이 옛 버전에 남음)", async () => {
    const dir = (v: string) => `.claude/plugins/cache/claude-office/claude-office/${v}`;
    const hooks = (t: number) => ({ hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:4317/hooks/event", timeout: t }] }] } });
    const register = (v: string) => h.write(".claude/plugins/installed_plugins.json", { version: 2, plugins: { "claude-office@claude-office": [{ scope: "user", installPath: h.path(dir(v)), version: v }] } });
    await h.write(`${dir("2.0.0-beta.1")}/hooks/hooks.json`, hooks(5));
    await h.write(`${dir("2.1.0-dev")}/hooks/hooks.json`, hooks(600));
    // 새 폴더가 더 최근이어도 등록이 옛 버전이면 Claude Code는 옛 hook(5초)을 쓴다
    const past = new Date(NOW - 3_600_000);
    utimesSync(h.path(dir("2.0.0-beta.1")), past, past);
    await register("2.0.0-beta.1");
    const stale = await item("hook_timeout");
    expect(stale).toMatchObject({ status: "warn", detail: "5초 — 대시보드에서 답하려면 플러그인을 업데이트해 주세요" });
    expect(stale.fix).toContain("claude plugin update claude-office@claude-office");
    // 등록을 갱신하면 폴더 시각과 무관하게 600초
    const later = new Date(Date.now() + 60_000);
    utimesSync(h.path(dir("2.0.0-beta.1")), later, later);
    await register("2.1.0-dev");
    expect(await item("hook_timeout")).toMatchObject({ status: "ok", detail: "600초" });
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

  it("v1이면 hooks도 '서버가 꺼져 있어'가 아니라 이전 버전 서버라고 한다(같은 실행에서 모순 없음)", async () => {
    let probes = 0;
    const items = await runDoctor(deps({ probePort: async () => (probes++, "v1"), hooks: async () => null }));
    expect(items.find((i) => i.id === "port")!.status).toBe("warn");
    const hooks = items.find((i) => i.id === "hooks")!;
    expect(hooks).toMatchObject({ status: "warn", detail: "확인하지 못했습니다(이전 버전 서버)" });
    expect(hooks.detail).not.toContain("서버가 꺼져");
    expect(probes).toBe(1); // 포트는 한 번만 조회한다
  });

  it("hooks", async () => {
    const off = await item("hooks", { hooks: async () => null });
    expect(off).toMatchObject({ status: "warn", detail: "서버가 꺼져 있어 확인하지 못했습니다" });
    const zero = await item("hooks", { hooks: async () => stats() });
    expect(zero.status).toBe("warn");
    expect(zero.fix).toContain("플러그인");
    const ok = await item("hooks", { hooks: async () => stats({ total: 9, last10min: 4 }) });
    expect(ok).toMatchObject({ status: "ok", detail: "최근 10분 4건" });
    const rej = await item("hooks", { hooks: async () => stats({ total: 9, last10min: 4, rejected: { "403": 2, "415": 0, "413": 0, "400": 1, "403-uid": 0, "401-v2": 0 } }) });
    expect(rej.status).toBe("warn");
    expect(rej.detail).toContain("3");
    // 다른 계정의 접속은 기존 거부 합계 경고보다 먼저, 따로(Phase 5 §2)
    const uid = await item("hooks", { hooks: async () => stats({ total: 9, last10min: 4, rejected: { "403": 2, "415": 0, "413": 0, "400": 1, "403-uid": 4, "401-v2": 0 } }) });
    // 기존 판정(거부 3건)에 덧붙인다(B251 M1)
    expect(uid).toMatchObject({ status: "warn", detail: "거부된 요청 3건. 다른 계정의 접속 4건을 막았습니다. 여러 사람이 쓰는 컴퓨터라면 정상입니다." });
    // 이벤트 0건 진단이 가려지지 않는다
    const uidZero = await item("hooks", { hooks: async () => stats({ total: 0, rejected: { "403": 0, "415": 0, "413": 0, "400": 0, "403-uid": 2, "401-v2": 0 } }) });
    expect(uidZero.status).toBe("warn");
    expect(uidZero.detail).toBe("받은 이벤트 0건. 다른 계정의 접속 2건을 막았습니다. 여러 사람이 쓰는 컴퓨터라면 정상입니다.");
    expect(uidZero.fix).toContain("플러그인");
    // 나머지가 정상이어도 상태는 warn(둘 중 나쁜 쪽)
    const uidOk = await item("hooks", { hooks: async () => stats({ total: 9, last10min: 4, rejected: { "403": 0, "415": 0, "413": 0, "400": 0, "403-uid": 1, "401-v2": 0 } }) });
    expect(uidOk).toMatchObject({ status: "warn", detail: "최근 10분 4건. 다른 계정의 접속 1건을 막았습니다. 여러 사람이 쓰는 컴퓨터라면 정상입니다." });
  });

  it("statusline: limits.json 없음(베타 미지원, ok)·최근·오래됨", async () => {
    expect(await item("statusline")).toMatchObject({
      status: "ok",
      detail: "없음",
      fix: "PLAN 바(요금제 한도)는 베타에서 지원하지 않습니다. 회사 좌석에서는 대부분 표시되지 않습니다",
    });
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

describe("권한 정책이 적용되지 않을 때의 덧붙임(Phase 3)", () => {
  const NOTE = "권한 정책이 적용되지 않고 있습니다. ";
  const FAKE_NAME = "FAKE-NAME-rev";
  const withPolicy = () => writeFile(paths.policyFile, JSON.stringify({ version: 1, targets: { [`agent:${FAKE_NAME}`]: { bash: "deny" } } }));
  const pluginOn = () => h.write(".claude/settings.json", { enabledPlugins: { "claude-office@claude-office": true } });
  const zero = async () => stats();
  const off = async () => null;
  const pick = (items: DoctorItem[], id: string) => items.find((i) => i.id === id)!;
  const noted = (items: DoctorItem[]) => items.filter((i) => i.fix.includes(NOTE)).map((i) => i.id);

  beforeEach(() => mkdir(h.path("prefix"), { recursive: true }));

  it("정책이 있고 받은 이벤트가 0건이면 hooks 안내 앞에 문장이 붙는다(B98, 부록 A 안내는 끝 그대로)", async () => {
    await withPolicy();
    await pluginOn();
    const items = await runDoctor(deps({ hooks: zero }));
    const fix = pick(items, "hooks").fix;
    expect(fix).toBe(`${NOTE}Claude Code 세션에서 아무 작업이나 해 보세요. 그래도 0건이면 플러그인과 회사 관리자 설정 항목을 확인해 주세요. 그래도 안 되면 회사 관리자에게 사용설명서 부록 A를 전달해 주세요.`);
    expect(noted(items)).toEqual(["hooks"]);
  });

  it("정책이 있고 서버가 꺼져 있으면 붙는다", async () => {
    await withPolicy();
    await pluginOn();
    const items = await runDoctor(deps({ hooks: off, probePort: async () => "free" }));
    expect(pick(items, "hooks")).toMatchObject({ detail: "서버가 꺼져 있어 확인하지 못했습니다" });
    expect(pick(items, "hooks").fix).toBe(`${NOTE}대시보드를 켠 뒤 다시 확인해 주세요.`);
    expect(noted(items)).toEqual(["hooks"]);
  });

  it("플러그인이 warn이어도 이벤트가 들어오면 붙지 않는다(B98: 다른 곳에서 켠 플러그인)", async () => {
    await withPolicy();
    const items = await runDoctor(deps());
    expect(pick(items, "plugin").status).toBe("warn");
    expect(pick(items, "hooks").status).toBe("ok");
    expect(noted(items)).toEqual([]);
    // 거부된 요청이 있어도(이벤트는 닿음) 붙지 않는다
    expect(noted(await runDoctor(deps({ hooks: async () => stats({ total: 3, last10min: 3, rejected: { "403": 1, "415": 0, "413": 0, "400": 0, "403-uid": 0, "401-v2": 0 } }) })))).toEqual([]);
    // 정말 꺼져 이벤트가 0건이면 hooks 안내에 붙는다
    expect(noted(await runDoctor(deps({ hooks: zero })))).toEqual(["hooks"]);
  });

  it("정책이 없으면 어떤 경우에도 붙지 않는다", async () => {
    for (const o of [{ hooks: zero }, { hooks: off }, {}] as Array<Partial<DoctorDeps>>) expect(noted(await runDoctor(deps(o)))).toEqual([]);
    // 대상이 하나도 없는 파일도 정책 없음
    await writeFile(paths.policyFile, JSON.stringify({ version: 1, targets: {} }));
    expect(noted(await runDoctor(deps({ hooks: zero })))).toEqual([]);
  });

  it("정책이 있어도 hooks·plugin이 정상이면 붙지 않는다", async () => {
    await withPolicy();
    await pluginOn();
    expect(noted(await runDoctor(deps()))).toEqual([]);
  });

  it("정책 파일이 깨졌으면 대상 0개로 본다(던지지 않는다)", async () => {
    await writeFile(paths.policyFile, "{oops");
    const items = await runDoctor(deps({ hooks: zero }));
    expect(items).toHaveLength(12);
    expect(noted(items)).toEqual([]);
    // doctor는 읽기만 한다: 깨진 파일을 고치거나 .broken으로 옮기지 않는다(B100)
    expect(await readFile(paths.policyFile, "utf8")).toBe("{oops");
    expect(existsSync(`${paths.policyFile}.broken`)).toBe(false);
  });

  it("깨진 정책 파일로 여러 번 돌려도 policy 로그는 10분에 한 줄(로거의 반복 억제)", async () => {
    await writeFile(paths.policyFile, "{oops");
    const { Logger, setLogger } = await import("../../server/log");
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = h.path("logs-doctor");
    setLogger(new Logger({ dir, now: () => NOW }));
    try {
      for (let i = 0; i < 3; i++) await runDoctor(deps({ hooks: zero }));
      const lines = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean));
      expect(lines.filter((l) => JSON.parse(l).src === "policy")).toHaveLength(1);
    } finally {
      setLogger(new Logger({ dir: "" }));
    }
  });

  it("항목은 여전히 12개이고 순서가 같다", async () => {
    await withPolicy();
    expect((await runDoctor(deps({ hooks: zero }))).map((i) => i.id)).toEqual(["node", "app", "port", "claude_home", "claude_cli", "plugin", "token", "hook_timeout", "managed", "proxy", "hooks", "statusline"]);
  });

  it("doctor 결과에 대상 이름이 없다", async () => {
    await withPolicy();
    const text = JSON.stringify(await runDoctor(deps({ hooks: zero })));
    const leaked = text.includes(FAKE_NAME);
    expect(leaked).toBe(false);
  });
});

describe("읽지 못한 정책 파일(B101)", () => {
  const NOTE = '저장해 둔 권한 정책 파일을 읽지 못했습니다. 대시보드는 정책이 없는 상태로 켜집니다. 위쪽 막대의 "권한 정책"에서 다시 정해 주세요.';
  const AT = "app"; // 제거 요약에서 policy.json은 "프로그램 파일"에 든다
  const marked = (items: DoctorItem[]) => items.filter((i) => i.fix.includes("권한 정책 파일")).map((i) => i.id);
  beforeEach(() => mkdir(h.path("prefix"), { recursive: true }));

  it("깨진 파일이면 프로그램 파일 항목이 warn이 되고 안내가 나온다(파일은 바꾸지 않는다)", async () => {
    await writeFile(paths.policyFile, "{oops");
    const items = await runDoctor(deps());
    expect(items).toHaveLength(12);
    expect(items.find((i) => i.id === AT)).toMatchObject({ status: "warn", detail: "권한 정책 파일을 읽지 못함", fix: NOTE });
    expect(marked(items)).toEqual([AT]);
    expect(await readFile(paths.policyFile, "utf8")).toBe("{oops");
    expect(existsSync(`${paths.policyFile}.broken`)).toBe(false);
  });

  it("읽지 못한 파일 + 이벤트 0건이어도 hooks에는 B98 문장이 붙지 않는다(대상 0개, B103)", async () => {
    await writeFile(paths.policyFile, "{oops");
    const hooks = (await runDoctor(deps({ hooks: async () => stats() }))).find((i) => i.id === "hooks")!;
    expect(hooks.detail).toBe("받은 이벤트 0건");
    expect(hooks.fix.includes("권한 정책")).toBe(false);
  });

  it("권한 없는 파일(chmod 000)도 같다", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await writeFile(paths.policyFile, JSON.stringify({ version: 1, targets: { lead: { bash: "ask" } } }));
    chmodSync(paths.policyFile, 0o000);
    try {
      expect(marked(await runDoctor(deps()))).toEqual([AT]);
    } finally {
      chmodSync(paths.policyFile, 0o600);
    }
  });

  it("프로그램 파일이 이미 fail이면 fail 그대로 두고 값과 안내에 덧붙인다", async () => {
    await writeFile(paths.policyFile, "{oops");
    const { rm } = await import("node:fs/promises");
    await rm(h.path("app/server.mjs"));
    const app = (await runDoctor(deps())).find((i) => i.id === AT)!;
    expect(app.status).toBe("fail");
    expect(app.detail).toBe("화면 파일 있음, 서버 파일 없음, 권한 정책 파일을 읽지 못함");
    expect(app.fix).toBe(`${NOTE} 설치 스크립트로 다시 설치해 주세요.`);
  });

  it("파일이 없거나 정상이거나 일부 규칙만 버린 파일이면 나오지 않는다", async () => {
    expect(marked(await runDoctor(deps()))).toEqual([]);
    await writeFile(paths.policyFile, JSON.stringify({ version: 1, targets: { lead: { bash: "ask" } } }));
    expect(marked(await runDoctor(deps()))).toEqual([]);
    await writeFile(paths.policyFile, JSON.stringify({ version: 1, targets: { lead: { bash: "allow" } } }));
    expect(marked(await runDoctor(deps()))).toEqual([]);
    expect((await runDoctor(deps())).find((i) => i.id === AT)!.status).toBe("ok");
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

  it("snapshot은 있는데 diagnostics가 없으면 v1, 둘 다 있으면 ours, 다른 응답이면 other", async () => {
    const { createServer } = await import("node:http");
    const serve = (routes: Record<string, [number, string, string]>) =>
      new Promise<{ port: number; close: () => void }>((r) => {
        const s = createServer((req, res) => {
          const [status, type, body] = routes[req.url ?? ""] ?? [404, "text/html", "<!doctype html><p>not found"];
          res.writeHead(status, { "Content-Type": type }).end(body);
        }).listen(0, "127.0.0.1", () => r({ port: (s.address() as { port: number }).port, close: () => s.close() }));
      });
    const snap: [number, string, string] = [200, "application/json", JSON.stringify({ generatedAt: "2026-10-02T00:00:00.000Z", sessions: [] })];
    const v1 = await serve({ "/api/snapshot": snap });
    const v2 = await serve({ "/api/snapshot": snap, "/api/diagnostics": [200, "application/json", JSON.stringify({ doctor: [], hooks: {}, errorsLastHour: 0 })] });
    // v1처럼 SPA가 모든 경로에 index.html(200)을 돌려주는 경우도 v1이다
    const spa = await serve({ "/api/snapshot": snap, "/api/diagnostics": [200, "text/html", "<!doctype html><div id=root>"] });
    const other = await serve({ "/api/snapshot": [200, "text/html", "<!doctype html>"] });
    // 베타 서버의 진단 API가 내부 오류(500)면 v1이 아니다(진짜 우리 서버가 아픈 것)
    const sick = await serve({ "/api/snapshot": snap, "/api/diagnostics": [500, "application/json", JSON.stringify({ error: "진단 정보를 만들지 못했습니다" })] });
    try {
      expect(await defaultProbePort(v1.port)).toBe("v1");
      expect(await defaultProbePort(v2.port)).toBe("ours");
      expect(await defaultProbePort(spa.port)).toBe("v1");
      expect(await defaultProbePort(other.port)).toBe("other");
      expect(await defaultProbePort(sick.port)).toBe("ours");
    } finally {
      for (const s of [v1, v2, spa, other, sick]) s.close();
    }
  });

  it("401과 app 표시가 있으면 ours이고, probe는 Authorization을 보내지 않는다(Ruling B52)", async () => {
    const { createServer } = await import("node:http");
    const seen: Array<string | undefined> = [];
    const s = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized", app: "claude-office" }));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const p = (s.address() as { port: number }).port;
    const other401 = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(401, { "Content-Type": "application/json" }).end("{}");
    }).listen(0, "127.0.0.1");
    await new Promise((r) => other401.once("listening", r));
    try {
      expect(await defaultProbePort(p)).toBe("ours");
      expect(await defaultProbePort((other401.address() as { port: number }).port)).toBe("other");
      expect(defaultProbePort.length).toBe(1); // 토큰 인자를 받지 않는다
      expect(seen).toEqual([undefined, undefined]);
    } finally {
      s.close();
      other401.close();
    }
  });

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
