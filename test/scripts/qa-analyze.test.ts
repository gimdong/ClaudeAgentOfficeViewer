import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../../scripts/qa-analyze";
import { buildBundle, type DiagBundle } from "../../server/diag/bundle";
import type { DoctorItem } from "../../server/diag/doctor";
import { HookStats } from "../../server/events/stats";
import { emptySnapshot } from "../../server/snapshot";

const NOW = Date.UTC(2026, 9, 1, 3);
const HOME = "/Users/fakeuser";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-qa-analyze-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const doctor: DoctorItem[] = [
  { id: "node", status: "ok", title: "Node.js", detail: "버전 24", fix: "" },
  { id: "plugin", status: "warn", title: "플러그인", detail: "꺼져 있음 또는 설치 안 됨", fix: "플러그인을 설치해 주세요." },
  { id: "managed", status: "fail", title: "회사 관리자 설정", detail: "있음: 관리자 hook만 허용", fix: "사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요." },
  { id: "port", status: "fail", title: "포트", detail: "다른 프로그램이 4317을 쓰고 있습니다", fix: "그 프로그램을 끄세요." },
];
const log = (t: string, level: string, src: string, msg: string, data?: unknown) => JSON.stringify({ t, level, src, msg, ...(data ? { data } : {}) });

async function bundle(): Promise<DiagBundle> {
  const logDir = join(dir, "logs");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "office-2026-10-01.log"),
    [
      log("2026-10-01T01:00:00.000Z", "info", "server", "start", { version: "2.0.0-beta.1" }),
      log("2026-10-01T01:01:00.000Z", "error", "hub", "snapshot build failed", { error: "EACCES" }),
      log("2026-10-01T01:02:00.000Z", "error", "hooks", "event handling failed", { error: "Error" }),
      log("2026-10-01T01:05:00.000Z", "error", "hub", "snapshot build failed", { error: "EACCES" }),
      log("2026-10-01T01:09:00.000Z", "error", "hub", "snapshot build failed", { error: "EACCES" }),
      log("2026-10-01T01:10:00.000Z", "warn", "teams", "cannot read team config", { error: "SyntaxError" }),
      log("2026-10-01T01:20:00.000Z", "warn", "teams", "cannot read team config", { error: "SyntaxError", suppressed: 4 }),
      log("2026-10-01T01:21:00.000Z", "warn", "usage", "cannot read transcript", { error: "EACCES", file: "transcript" }),
      "깨진 줄 { not json",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(logDir, "install-20261001-100000.log"),
    [
      "2026-10-01T01:00:00.000Z node ok v24.1.0",
      "2026-10-01T01:00:05.000Z plugin fail claude plugin install exited 1 at /Users/fakeuser/Code/fake-proj-alpha",
      "2026-10-01T01:00:06.000Z path skip 사용자가 거절",
    ].join("\n") + "\n",
  );
  const stats = new HookStats(() => NOW);
  stats.accept("PreToolUse");
  stats.accept("PreToolUse");
  stats.accept("Stop");
  stats.reject("403");
  return buildBundle({
    doctor: async () => doctor,
    hooks: stats.view(),
    snapshot: emptySnapshot(NOW, { budget: {}, contextWindows: {} }),
    logDir,
    home: HOME,
    now: () => NOW,
    appVersion: "2.0.0-beta.1",
    claudeVersion: "9.9.9",
  });
}

const section = (md: string, title: string) => {
  const start = md.indexOf(`## ${title}`);
  if (start < 0) throw new Error(`no section ${title}`);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next < 0 ? undefined : next);
};

describe("analyze", () => {
  it("환경 요약", async () => {
    const env = section(analyze(await bundle()), "환경");
    expect(env).toContain("2.0.0-beta.1");
    expect(env).toContain(process.version);
    expect(env).toContain(process.platform);
    expect(env).toContain("9.9.9");
  });

  it("fail·warn doctor 항목만", async () => {
    const s = section(analyze(await bundle()), "점검");
    expect(s).toContain("회사 관리자 설정");
    expect(s).toContain("플러그인");
    expect(s).not.toContain("Node.js");
    expect(s.indexOf("회사 관리자 설정")).toBeLessThan(s.indexOf("플러그인")); // fail이 위
  });

  it("오류 묶음: 같은 src+msg의 error를 묶어 많은 순", async () => {
    const s = section(analyze(await bundle()), "오류 묶음");
    expect(s).toContain("| hub | snapshot build failed | 3 | 2026-10-01T01:01:00.000Z | 2026-10-01T01:09:00.000Z |");
    expect(s).toContain("| hooks | event handling failed | 1 |");
    expect(s.indexOf("snapshot build failed")).toBeLessThan(s.indexOf("event handling failed"));
    expect(s).not.toContain("cannot read team config"); // warn은 묶음에 넣지 않는다
  });

  it("경고 묶음: suppressed를 더해 세고 많은 순, 상위 10개", async () => {
    const s = section(analyze(await bundle()), "경고 묶음");
    // 억제 없는 한 줄(1) + suppressed:4인 한 줄(1+4) = 6
    expect(s).toContain("| teams | cannot read team config | 6 | 2026-10-01T01:10:00.000Z | 2026-10-01T01:20:00.000Z |");
    expect(s).toContain("| usage | cannot read transcript | 1 |");
    expect(s.indexOf("cannot read team config")).toBeLessThan(s.indexOf("cannot read transcript"));

    const b = await bundle();
    const many = Array.from({ length: 12 }, (_, i) => log("2026-10-01T02:00:00.000Z", "warn", "x", `w${i}`, i === 0 ? { suppressed: 4 } : undefined));
    const md = analyze({ ...b, logs: [{ file: "office-2026-10-01.log", lines: many }] });
    const w = section(md, "경고 묶음");
    expect(w).toContain("| x | w0 | 5 |"); // suppressed:4인 한 줄은 5건
    expect((w.match(/^\| x \|/gm) ?? []).length).toBe(10);
    expect(w).toContain("상위 10개");
  });

  it("error가 없고 warn만 있으면 [QA 인폼] 근거에 warn 상위 항목을 쓴다", async () => {
    const b = await bundle();
    const only = [log("2026-10-01T02:00:00.000Z", "warn", "teams", "cannot read team config", { suppressed: 2 })];
    const md = analyze({ ...b, logs: [{ file: "office-2026-10-01.log", lines: only }] });
    const inform = section(md, "[QA 인폼]");
    expect(inform).toMatch(/근거: [^\n]*teams cannot read team config[^\n]*3/);
  });

  it("설치 실패 줄은 따로 보여 주고, 이름은 가린 채로 둔다", async () => {
    const md = analyze(await bundle());
    const s = section(md, "설치 실패");
    expect(s).toContain("plugin");
    expect(s).toContain("<project-");
    expect(s).not.toContain("node ok");
    expect(md).not.toMatch(/fakeuser|fake-proj-alpha/);
  });

  it("hook 통계", async () => {
    const s = section(analyze(await bundle()), "hook 통계");
    expect(s).toContain("수신 합계 3건");
    expect(s).toContain("| PreToolUse | 2 |");
    expect(s).toContain("| Stop | 1 |");
    expect(s).toContain("거부 1건");
  });

  it("[QA 인폼] 초안이 마지막 절이고 다섯 칸을 채운다", async () => {
    const md = analyze(await bundle());
    const last = md.slice(md.lastIndexOf("\n## ") + 1);
    expect(last.startsWith("## [QA 인폼]")).toBe(true);
    for (const k of ["증상:", "재현 조건:", "근거:", "추정 원인:", "제안:"]) expect(last).toContain(k);
    expect(last).toContain("회사 관리자 설정"); // 첫 fail
    expect(last).toContain("사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요."); // 첫 fail의 fix
    expect(last).toContain("snapshot build failed");
  });

  it("문제가 없으면 없다고 쓴다", async () => {
    const b = await bundle();
    const clean: DiagBundle = { ...b, doctor: [doctor[0]], logs: [] };
    const md = analyze(clean);
    expect(section(md, "점검")).toContain("fail·warn 없음");
    expect(section(md, "오류 묶음")).toContain("error 없음");
    expect(section(md, "[QA 인폼]")).toContain("특이 사항 없음");
  });
});

describe("CLI", () => {
  const run = (args: string[]) => spawnSync(join("node_modules", ".bin", "tsx"), ["scripts/qa-analyze.ts", ...args], { encoding: "utf8" });

  it("진단 파일을 읽어 Markdown을 출력한다", async () => {
    const f = join(dir, "d.json");
    writeFileSync(f, JSON.stringify(await bundle()));
    const r = run([f]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("## [QA 인폼]");
  }, 20_000);

  it("kind는 맞는데 형식이 다르면 한 줄 안내와 종료 코드 2(스택 없음)", () => {
    const f = join(dir, "partial.json");
    writeFileSync(f, JSON.stringify({ kind: "claude-office-diag" }));
    const r = run([f]);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe("진단 파일 형식이 다릅니다(format undefined)");
    expect(r.stderr).not.toMatch(/TypeError|\n\s+at /);
    const g = join(dir, "broken.json");
    writeFileSync(g, JSON.stringify({ kind: "claude-office-diag", format: 1, doctor: null }));
    const r2 = run([g]);
    expect(r2.status).toBe(2);
    expect(r2.stderr.trim()).toBe("진단 파일 형식이 다릅니다(format 1)");
  }, 20_000);

  it("kind가 claude-office-diag가 아니면 오류 종료 코드 2", () => {
    const f = join(dir, "x.json");
    writeFileSync(f, JSON.stringify({ kind: "other" }));
    const r = run([f]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("진단 파일이 아닙니다");
    expect(run([]).status).toBe(2);
  }, 20_000);
});

it("beta-feedback/는 .gitignore에 있다", () => {
  expect(spawnSync("git", ["check-ignore", "-q", "beta-feedback/x.json"]).status).toBe(0);
});
