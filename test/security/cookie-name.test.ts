// B297·B298·B300: 쿠키 이름을 Host 헤더의 포트로 정한다. 어떤 Host 값에서도 Set-Cookie는 정해진 두 모양뿐이어야 하고
// (co_<1~65535>=토큰 또는 옛 co 지우기), Host의 글자가 속성으로 끼어들면 안 된다. 옛 co는 토큰이 맞을 때만 이전·삭제한다
import { request } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { makeSnapshot } from "../web/fixtures";

const TOKEN = "9d".repeat(32);
const OTHER = "e1".repeat(32);
const NEW = new RegExp(`^co_(\\d{1,5})=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000$`);
const CLEAR = /^co=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/;

let server: Server;
let port: number;
beforeAll(async () => {
  server = createApp({ current: () => makeSnapshot(), subscribe: () => () => {} }, { auth: { token: TOKEN } }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

function get(path: string, host: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; cookies: string[] }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: host, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, cookies: ([] as string[]).concat(res.headers["set-cookie"] ?? []) }));
    });
    r.on("error", reject);
    r.end();
  });
}
/** Set-Cookie가 정해진 모양뿐인지, 새 이름의 포트가 기대값인지 */
function expectShapes(cookies: string[], wantPort: number) {
  expect(cookies.length).toBeGreaterThan(0);
  for (const c of cookies) {
    expect(NEW.test(c) || CLEAR.test(c), c).toBe(true);
    const m = NEW.exec(c);
    if (m) expect(Number(m[1])).toBe(wantPort);
  }
}

// Host 검사(호스트명)는 통과하지만 포트 쪽에 이상한 글자가 있는 값들. 기대 이름은 listen 포트
const odd = ["127.0.0.1:1; Domain=evil.example", "127.0.0.1:4317;Path=/api", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:abc", "127.0.0.1:43 17", "[::1]:x", "localhost:-1", "127.0.0.1:99999999999"];

describe("쿠키 이름(B297·B298)", () => {
  it("정상 포트는 그 포트, 포트 없음은 80, 0으로 시작해도 숫자로 정규화", async () => {
    for (const [h, p] of [["127.0.0.1:4317", 4317], ["localhost:14317", 14317], ["[::1]:5173", 5173], ["127.0.0.1", 80], ["127.0.0.1:04317", 4317]] as const) {
      const r = await get(`/?k=${TOKEN}`, h);
      expect(r.status, h).toBe(302);
      expectShapes(r.cookies, p);
    }
  });

  it("포트 쪽에 이상한 글자가 있으면 listen 포트 이름이고, Host 글자가 Set-Cookie에 섞이지 않는다(?k=·/api 이전 둘 다)", async () => {
    for (const h of odd) {
      const a = await get(`/?k=${TOKEN}`, h);
      expect(a.status, h).toBe(302);
      expectShapes(a.cookies, port);
      const b = await get("/api/snapshot", h, { Cookie: `co=${TOKEN}` });
      expect(b.status, h).toBe(200);
      expectShapes(b.cookies, port);
      for (const c of [...a.cookies, ...b.cookies]) for (const bad of ["Domain", "evil", "abc", "/api"]) expect(c, h).not.toContain(bad);
    }
  });
});

describe("옛 co 이전(B297·B300)", () => {
  it("토큰이 맞는 옛 co만 새 이름으로 다시 심고 지운다. 틀린 옛 co는 401, Set-Cookie 없음", async () => {
    const ok = await get("/api/snapshot", `127.0.0.1:${port}`, { Cookie: `co=${TOKEN}` });
    expect(ok.status).toBe(200);
    expectShapes(ok.cookies, port);
    expect(ok.cookies.some((c) => CLEAR.test(c))).toBe(true);
    const bad = await get("/api/snapshot", `127.0.0.1:${port}`, { Cookie: `co=${OTHER}` });
    expect(bad).toEqual({ status: 401, cookies: [] });
  });

  it("?k= 성공 때 옛 co는 값이 이 토큰과 같을 때만 지운다(다른 설치본의 co는 남김, B300)", async () => {
    const mine = await get(`/?k=${TOKEN}`, `127.0.0.1:${port}`, { Cookie: `co=${TOKEN}` });
    expect(mine.cookies.some((c) => CLEAR.test(c))).toBe(true);
    const others = await get(`/?k=${TOKEN}`, `127.0.0.1:${port}`, { Cookie: `co=${OTHER}` });
    expect(others.cookies.some((c) => CLEAR.test(c))).toBe(false);
    expectShapes(others.cookies, port);
  });

  it("새 이름 쿠키는 그 포트에서만: 다른 포트 이름의 쿠키로는 인증되지 않는다", async () => {
    expect((await get("/api/snapshot", "127.0.0.1:14317", { Cookie: `co_4317=${TOKEN}` })).status).toBe(401);
    expect((await get("/api/snapshot", "127.0.0.1:14317", { Cookie: `co_14317=${TOKEN}` })).status).toBe(200);
  });
});
