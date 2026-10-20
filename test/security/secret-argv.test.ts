// B265(Important-2): 프로세스 인자는 같은 컴퓨터의 다른 계정도 ps로 본다(macOS는 다른 사용자 프로세스 인자도 보인다).
// 대시보드 토큰과 층 열쇠 원문은 open·xdg-open·tmux 인자에 싣지 않는다.
// 방식: 런처는 0600 HTML(토큰 주소로 넘기는 페이지)을 0700 임시 폴더에 쓰고 그 파일 경로만 연다. 층 열쇠는 0600 파일에 두고
// tmux에는 그 경로(CLAUDE_OFFICE_FLOOR_KEY_FILE)만 넘긴다. channel 서버는 그 파일에서 열쇠를 읽는다
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchArgs } from "../../server/floors/launch";

const ROOT = join(__dirname, "../..");
const TOKEN = "c0ffee".repeat(10) + "abcd"; // 가짜 64자
const KEY = "be".repeat(32); // 가짜 층 열쇠
const PORT = 4391; // 아무것도 듣지 않는 포트(스텁만 쓴다)

describe.skipIf(process.platform === "win32")("런처(claude-office.sh)는 토큰을 open 인자에 싣지 않는다", () => {
  let base: string;
  let prefix: string;
  let logs: string;
  let env: NodeJS.ProcessEnv;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "co-sec-argv-"));
    prefix = join(base, "prefix");
    logs = join(base, "logs");
    const stub = join(base, "stub-bin");
    for (const d of [join(prefix, "bin"), join(prefix, "app"), stub, logs]) mkdirSync(d, { recursive: true });
    copyFileSync(join(ROOT, "packaging/claude-office.sh"), join(prefix, "bin/claude-office"));
    chmodSync(join(prefix, "bin/claude-office"), 0o755);
    writeFileSync(join(prefix, "app/server.mjs"), "");
    writeFileSync(join(prefix, "VERSION"), "0.0.0-test\n");
    writeFileSync(join(prefix, "token"), TOKEN, { mode: 0o600 });
    // 가짜 node: 버전 검사에만 답하고, 서버 실행(exec node server.mjs)은 잠깐 기다리기만 한다
    writeFileSync(join(stub, "node"), '#!/bin/sh\n[ "$1" = "-v" ] && { echo v24.0.0; exit 0; }\nsleep 5\n');
    // 가짜 open·xdg-open: 받은 인자를 적고, 인자가 파일이면 그 순간의 권한과 내용을 적는다
    const opener = `#!/bin/sh
for a in "$@"; do
  printf '%s\\n' "$a" >> "${logs}/argv"
  if [ -f "$a" ]; then ls -l "$a" | cut -c1-10 >> "${logs}/mode"; cat "$a" >> "${logs}/content"; fi
done
exit 0
`;
    for (const n of ["open", "xdg-open"]) {
      writeFileSync(join(stub, n), opener);
      chmodSync(join(stub, n), 0o755);
    }
    chmodSync(join(stub, "node"), 0o755);
    env = { HOME: join(base, "home"), TMPDIR: join(base, "tmp") + "/", PATH: `${stub}:/usr/bin:/bin`, LANG: "C" };
    mkdirSync(env.HOME!, { recursive: true });
    mkdirSync(env.TMPDIR!, { recursive: true });
  });
  afterEach(() => {
    child?.kill();
    child = undefined;
    for (const f of ["argv", "mode", "content"]) rmSync(join(logs, f), { force: true });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const read = (f: string) => (existsSync(join(logs, f)) ? readFileSync(join(logs, f), "utf8") : "");
  const expectSafeOpen = () => {
    expect(read("argv")).not.toContain(TOKEN);
    // 연 것은 파일이고, 그 순간 0600이며, 내용이 토큰 주소로 넘긴다
    expect(read("mode").trim().split("\n")[0]).toBe("-rw-------");
    expect(read("content")).toContain(`http://127.0.0.1:${PORT}/?k=${TOKEN}`);
  };

  it("기본 실행(서버 켜기 + 브라우저 열기)", async () => {
    child = spawn(join(prefix, "bin/claude-office"), ["--port", String(PORT)], { env, stdio: "ignore" });
    const t = Date.now();
    // 가짜 opener는 argv를 먼저, mode·content를 나중에 쓴다 — 마지막에 쓰는 content까지 기다린다
    while (!read("content") && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 50));
    expect(read("argv")).not.toBe("");
    expectSafeOpen();
  });

  it("open 하위 명령(기본 브라우저, 브라우저 이름 지정)", () => {
    for (const args of [["open", "--port", String(PORT)], ["open", "Safari", "--port", String(PORT)]]) {
      const r = spawnSync(join(prefix, "bin/claude-office"), args, { env, encoding: "utf8" });
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout + r.stderr, args.join(" ")).not.toContain(TOKEN);
      expectSafeOpen();
      for (const f of ["argv", "mode", "content"]) rmSync(join(logs, f), { force: true });
    }
  });
});

describe("층 열쇠는 tmux 인자에 싣지 않는다", () => {
  it("launchArgs 반환값 어디에도 열쇠 원문이 없고, 열쇠 파일 경로만 넘긴다", () => {
    const keyFile = "/x/floors/co-1.key";
    const a = launchArgs({ tmuxName: "co-1", claude: "/c/claude", channelSpec: "s", sessionId: "u1", key: KEY, keyFile, port: 4317, cwd: "/w", name: "n" } as unknown as Parameters<typeof launchArgs>[0]);
    for (const x of a) expect(x).not.toContain(KEY);
    expect(a).toContain(`CLAUDE_OFFICE_FLOOR_KEY_FILE=${keyFile}`);
  });
});

describe("channel 서버는 열쇠 파일에서 열쇠를 읽는다", () => {
  let server: Server | undefined;
  let child: ChildProcess | undefined;
  let dir: string;
  afterEach(async () => {
    child?.kill();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("CLAUDE_OFFICE_FLOOR_KEY_FILE(0600)만 있어도 대시보드에 연결을 시도하고, 요청 어디에도 열쇠 원문이 없다", async () => {
    dir = mkdtempSync(join(tmpdir(), "co-sec-keyfile-"));
    const keyFile = join(dir, "co-1.key");
    writeFileSync(keyFile, KEY, { mode: 0o600 });
    const seen: string[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${body}`);
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    child = spawn(process.execPath, [join(ROOT, "plugins/claude-office/channel/server.mjs")], {
      env: { PATH: process.env.PATH ?? "", CLAUDE_OFFICE_PORT: String(port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const w = (m: object) => child!.stdin!.write(JSON.stringify(m) + "\n");
    w({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    w({ jsonrpc: "2.0", method: "notifications/initialized" });
    const t = Date.now();
    while (seen.length === 0 && Date.now() - t < 4000) await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).not.toContain(KEY);
  });
});
