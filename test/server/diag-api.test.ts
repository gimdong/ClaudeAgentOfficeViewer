import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, isSameOrigin, type DiagnosticsSummary } from "../../server/app";
import { HookStats } from "../../server/events/stats";
import { emptySnapshot } from "../../server/snapshot";

const FILE = "claude-office-diag-20261001-123456.json";
const summary: DiagnosticsSummary = {
  doctor: [{ id: "node", status: "ok", title: "Node.js", detail: "버전 24", fix: "" }],
  hooks: new HookStats().view(),
  errorsLastHour: 2,
  logDir: "~/.claude-office/logs",
  diagDir: "~/.claude-office/diagnostics",
};

let server: Server;
let port: number;
let root: string;
let diagDir: string;
let made: number;
let fail: boolean;
beforeEach(async () => {
  made = 0;
  fail = false;
  // 실제 설치 위치(~/.claude-office/diagnostics)처럼 점 폴더 안에 둔다 — 정적 파일 전송은 기본값으로 점 경로를 거부한다
  root = mkdtempSync(join(tmpdir(), "office-diag-api-"));
  diagDir = join(root, ".claude-office", "diagnostics");
  mkdirSync(diagDir, { recursive: true });
  writeFileSync(join(diagDir, FILE), '{"kind":"claude-office-diag"}');
  const snap = emptySnapshot(0, { budget: {}, contextWindows: {} });
  const diagnostics = {
    summary: async () => summary,
    makeBundle: async () => {
      made++;
      if (fail) throw Object.assign(new Error("EACCES: open '/x/fake-secret'"), { code: "EACCES" });
      return FILE;
    },
    diagDir,
  };
  server = createApp({ current: () => snap, subscribe: () => () => {} }, { diagnostics }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

function req(method: string, path: string, headers: Record<string, string> = {}, body = ""): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    r.on("error", reject);
    r.end(body);
  });
}
const json = { "Content-Type": "application/json" };

describe("진단 API", () => {
  it("GET /api/diagnostics는 요약 JSON", async () => {
    const r = await req("GET", "/api/diagnostics");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(summary);
  });

  it("같은 출처 버튼 요청은 201", async () => {
    const r = await req("POST", "/api/diagnostics/bundle", { ...json, Origin: `http://127.0.0.1:${port}` }, "{}");
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body)).toEqual({ file: FILE });
    expect(made).toBe(1);
  });

  it("Origin이 없어도 201(CLI·curl)", async () => {
    expect((await req("POST", "/api/diagnostics/bundle", json, "{}")).status).toBe(201);
  });

  it("다른 출처 Origin·JSON 아닌 요청·경로 조작을 거부한다", async () => {
    expect((await req("POST", "/api/diagnostics/bundle", { ...json, Origin: "http://evil.example" }, "{}")).status).toBe(403);
    expect((await req("POST", "/api/diagnostics/bundle", { ...json, Origin: "http://localhost:5173" }, "{}")).status).toBe(403);
    expect((await req("POST", "/api/diagnostics/bundle", { "Content-Type": "text/plain" }, "{}")).status).toBe(415);
    expect((await req("POST", "/api/diagnostics/bundle", { ...json, Host: "evil.example" }, "{}")).status).toBe(403);
    expect((await req("GET", "/api/diagnostics/files/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await req("GET", "/api/diagnostics/files/other.json")).status).toBe(404);
    expect(made).toBe(0);
  });

  it("만들기 실패는 500과 쉬운 말, 오류 원문은 응답에 없다", async () => {
    fail = true;
    const r = await req("POST", "/api/diagnostics/bundle", json, "{}");
    expect(r.status).toBe(500);
    expect(r.body).toContain("진단 파일을 만들지 못했습니다");
    expect(r.body).not.toContain("fake-secret");
  });

  it("파일 받기는 이름 규칙에 맞을 때만, 첨부로", async () => {
    const r = await req("GET", `/api/diagnostics/files/${FILE}`);
    expect(r.status).toBe(200);
    expect(String(r.headers["content-disposition"])).toContain(FILE);
    expect(JSON.parse(r.body).kind).toBe("claude-office-diag");
    expect((await req("GET", "/api/diagnostics/files/claude-office-diag-20261001-000000.json")).status).toBe(404);
  });
});

describe("isSameOrigin", () => {
  it("규칙", () => {
    expect(isSameOrigin("http://127.0.0.1:4317", "127.0.0.1:4317")).toBe(true);
    expect(isSameOrigin("http://localhost:4317", "localhost:4317")).toBe(true);
    expect(isSameOrigin("http://[::1]:4317", "[::1]:4317")).toBe(true);
    expect(isSameOrigin(undefined, "127.0.0.1:4317")).toBe(true);
    expect(isSameOrigin("null", "127.0.0.1:4317")).toBe(false);
    expect(isSameOrigin("http://evil.example:4317", "evil.example:4317")).toBe(false);
    expect(isSameOrigin("not a url", "127.0.0.1:4317")).toBe(false);
    expect(isSameOrigin("https://127.0.0.1:4317", "127.0.0.1:4317")).toBe(false);
  });
});
