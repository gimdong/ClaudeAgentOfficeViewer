// B262: Express 기본 오류 페이지는 스택 추적과 절대 경로(홈 폴더 사용자 이름)를 싣는다. 인증 전 경로에서도 나오므로
// 깨진 본문에는 상태 코드만 돌려줘야 한다
import type { AddressInfo, Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { ChannelHub } from "../../server/floors/channels";
import { makeSnapshot } from "../web/fixtures";

let server: Server;
let base: string;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "co-sec-err-"));
  const hub = new ChannelHub({ file: join(tmp, "experimental.json"), available: { ok: true } });
  server = createApp(
    { current: () => makeSnapshot(), subscribe: () => () => {} },
    { auth: { token: "f".repeat(64) }, channels: { hub, launch: async () => ({ ok: false, error: "tmux" }) } },
  ).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("깨진 본문에 스택·경로를 싣지 않는다(B262)", () => {
  it("/channel/ack 깨진 JSON → 400, 본문에 오류 이름·스택·절대 경로 없음", async () => {
    for (const body of ["{bad", '{"id":', "\u0000"]) {
      const r = await fetch(`${base}/channel/ack`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Floor ${"0".repeat(64)}` }, body });
      const t = await r.text();
      expect(r.status, body).toBe(400);
      for (const bad of ["SyntaxError", "/Users", "/home", "node_modules", "    at "]) expect(t, `${body}: ${bad}`).not.toContain(bad);
    }
  });

  it("/channel/ack 큰 본문 → 413, 본문에 스택 없음", async () => {
    const r = await fetch(`${base}/channel/ack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "x".repeat(4096) }) });
    const t = await r.text();
    expect(r.status).toBe(413);
    for (const bad of ["PayloadTooLargeError", "/Users", "/home", "node_modules"]) expect(t, bad).not.toContain(bad);
  });
});
