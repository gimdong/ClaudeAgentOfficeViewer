import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { ChannelHub } from "../../server/floors/channels";
import { Logger, setLogger } from "../../server/log";
import { makeSnapshot } from "../web/fixtures";

// B262: express 기본 오류 페이지는 스택(설치 경로·사용자 이름)을 내보낸다 — 마지막 오류 처리기가 짧게 답한다
let server: Server;
let port: number;
let tmp: string;
let hub: ChannelHub;
beforeEach(async () => {
  setLogger(new Logger({ dir: "" }));
  tmp = mkdtempSync(join(tmpdir(), "co-errh-"));
  hub = new ChannelHub({ file: join(tmp, "experimental.json"), available: { ok: true } });
  const snap = makeSnapshot({});
  server = createApp({ current: () => snap, subscribe: () => () => {}, poke: () => {} }, { channels: { hub, launch: async () => ({ ok: false, error: "tmux" }) } }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});
const post = (path: string, body: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
    });
    req.on("error", reject);
    req.end(body);
  });

describe("마지막 오류 처리기(B262)", () => {
  it("/channel/ack에 깨진 JSON → 400, 본문에 스택·경로·오류 이름이 없다", async () => {
    const r = await post("/channel/ack", "{broken");
    expect(r.status).toBe(400);
    for (const s of ["SyntaxError", "at ", "/Users", "/home", "node_modules"]) expect(r.body).not.toContain(s);
  });

  it("본문 크기 초과는 413, 본문 없음", async () => {
    const r = await post("/channel/ack", JSON.stringify({ id: "x".repeat(4000) }));
    expect(r).toEqual({ status: 413, body: "" });
  });

  it("상태 코드가 없는 예외는 500, 본문 없음(B276 — 서버 쪽 잘못을 요청 잘못으로 보이지 않게)", async () => {
    hub.hello = () => {
      throw new Error("boom /Users/someone/app");
    };
    expect(await post("/channel/hello", JSON.stringify({ kid: "a".repeat(64), nonce: "b".repeat(64) }))).toEqual({ status: 500, body: "" });
  });

  it("/hooks/event의 기존 400·413 처리는 그대로(빈 본문)", async () => {
    expect(await post("/hooks/event", "{broken")).toEqual({ status: 400, body: "" });
  });
});
