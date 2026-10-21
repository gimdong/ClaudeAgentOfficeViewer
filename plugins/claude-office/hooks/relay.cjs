"use strict";
// Claude Office hook relay(Phase 6a §3). Claude Code가 hook마다 띄운다: node relay.cjs <열쇠 파일> [포트]
// stdin의 hook 이벤트를 열쇠 파일에서 HKDF로 만든 요청 키로 AES-256-GCM 암호화해 127.0.0.1의 대시보드에 한 번 보내고,
// 응답 키로 풀린 답만 stdout에 쓴다. 출력 안전 규칙: 어떤 실패·예외·신호·시간 초과에서도 stdout 없이 exit 0(exit 1·2는 쓰지 않는다).
// node 내장만 쓰는 CommonJS 한 파일 — 서버(server/hooks/v2.ts HOOK_V2)와 같은 글자를 따로 적고, 테스트가 대조한다(B292)
const { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } = require("node:crypto");
const { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } = require("node:fs");
const { connect } = require("node:net");
const { dirname, join } = require("node:path");

const PLUGIN_VERSION = "2.0.0-beta.14";
const C = {
  infoReq: "claude-office hook req v1",
  infoRes: "claude-office hook res v1",
  body: ["kid", "iv", "ct", "tag"],
  plain: ["v", "id", "ts", "plugin", "event"],
  reply: ["id", "out"],
};
const MAX_STDIN = 1024 * 1024; // 바이트. base64 암호문이 서버 상한 1.5MB 안에 들도록
const MAX_RESPONSE = 2 * 1024 * 1024;
/** 답을 쓰지 않는 이벤트(문맥 주입·멈춤 방지, 스펙 3장 7번) */
const SILENT = new Set(["UserPromptSubmit", "SessionStart", "Stop", "SubagentStop", "TeammateIdle"]);
/**
 * stdout에 쓸 수 있는 최상위 키(스펙 3장 6번): 대시보드 서버(server/decisions/protocol.ts)가 만드는 hookSpecificOutput 하나뿐.
 * 옛 decision:"approve"(허용으로 읽힘)·PostToolUse decision:"block"+reason(글이 Claude에 전달됨) 경로를 닫는다
 */
const ALLOWED = new Set(["hookSpecificOutput"]);

const quiet = () => process.exit(0);

/** 복호화·형식 실패만 남긴다: 이유 한 단어 + 시각(본문·열쇠 없음). 1MB를 넘으면 앞을 지운다. 로그 실패는 무시 */
function note(keyFile, reason) {
  try {
    const f = join(dirname(keyFile), "logs", "relay.log");
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = statSync(f).size;
    } catch {}
    if (size > 1024 * 1024) writeFileSync(f, readFileSync(f, "utf8").slice(-512 * 1024).replace(/^[^\n]*\n/, ""), { mode: 0o600 });
    appendFileSync(f, `${new Date().toISOString()} ${reason}\n`, { mode: 0o600 });
  } catch {}
}

function readStdin() {
  const chunks = [];
  let n = 0;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let r;
    try {
      r = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === "EAGAIN") continue;
      if (e.code === "EOF") break;
      throw e;
    }
    if (r === 0) break;
    n += r;
    if (n > MAX_STDIN) return null;
    chunks.push(Buffer.from(buf.subarray(0, r)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 열쇠 파일: 일반 파일, 소유자 = 자기, 그룹·다른 사용자 권한 없음(Windows는 소유자·권한 생략). 32바이트 hex */
function readKey(file) {
  const fd = openSync(file, "r");
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (process.platform !== "win32" && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)) return null;
    const text = readFileSync(fd, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, "hex") : null;
  } finally {
    closeSync(fd);
  }
}

function keys(key) {
  const hk = (info) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, 32));
  return { req: hk(C.infoReq), res: hk(C.infoRes), kid: createHash("sha256").update(key).digest("hex").slice(0, 16) };
}

/** 소켓 하나로 HTTP/1.1 POST 한 번. 응답을 다 받은 뒤에만 닫는다(half-close 금지 — 서버가 끊김으로 본다) */
function post(port, body, waitMs) {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => (s.destroy(), reject(new Error("wait"))), waitMs);
    let buf = Buffer.alloc(0);
    s.on("error", (e) => (clearTimeout(timer), reject(e)));
    s.on("connect", () => s.write(`POST /hooks/v2 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > MAX_RESPONSE) return clearTimeout(timer), s.destroy(), reject(new Error("size"));
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString("latin1");
      const len = Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? -1);
      if (len < 0) return clearTimeout(timer), s.destroy(), reject(new Error("length"));
      if (buf.length - end - 4 < len) return;
      clearTimeout(timer);
      s.destroy();
      resolve({ status: Number(head.slice(9, 12)), body: buf.subarray(end + 4, end + 4 + len).toString("utf8") });
    });
    s.on("close", () => (clearTimeout(timer), reject(new Error("closed"))));
  });
}

async function main() {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGPIPE"]) process.on(sig, quiet);
  process.on("uncaughtException", quiet);
  process.on("unhandledRejection", quiet);
  const keyFile = process.argv[2];
  const port = /^\d{2,5}$/.test(process.argv[3] ?? "") ? Number(process.argv[3]) : 4317;
  if (!keyFile) return quiet();
  const input = readStdin();
  if (input === null) return quiet();
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return quiet();
  }
  const name = event && typeof event === "object" ? event.hook_event_name : undefined;
  if (typeof name !== "string") return quiet();
  let key;
  try {
    key = readKey(keyFile);
  } catch {
    return quiet();
  }
  if (!key) return quiet();
  const k = keys(key);
  const id = randomBytes(16).toString("hex");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.req, iv);
  c.setAAD(Buffer.from(k.kid));
  const ct = Buffer.concat([c.update(JSON.stringify({ v: 1, id, ts: Date.now(), plugin: PLUGIN_VERSION, event })), c.final()]);
  // 대기 한도: 이벤트 timeout(PermissionRequest 600초, 그 밖 10초)보다 5초 짧게. 테스트만 env로 줄인다
  const waitMs = Number(process.env.CLAUDE_OFFICE_RELAY_WAIT_MS) || (name === "PermissionRequest" ? 595_000 : 5_000);
  let r;
  try {
    r = await post(port, JSON.stringify({ kid: k.kid, iv: iv.toString("hex"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("hex") }), waitMs);
  } catch {
    return quiet(); // 대시보드 꺼짐·시간 초과 — 로그 없이
  }
  if (r.status !== 200) return note(keyFile, `status-${r.status}`), quiet();
  let out;
  try {
    const o = JSON.parse(r.body);
    if (typeof o.iv !== "string" || !/^[0-9a-f]{24}$/.test(o.iv) || typeof o.tag !== "string" || !/^[0-9a-f]{32}$/.test(o.tag) || typeof o.ct !== "string") throw new Error("shape");
    const d = createDecipheriv("aes-256-gcm", k.res, Buffer.from(o.iv, "hex"));
    d.setAuthTag(Buffer.from(o.tag, "hex"));
    const p = JSON.parse(Buffer.concat([d.update(Buffer.from(o.ct, "base64")), d.final()]).toString("utf8"));
    if (!p || p.id !== id) throw new Error("id");
    out = p.out;
  } catch {
    return note(keyFile, "decrypt"), quiet();
  }
  if (SILENT.has(name) || !out || typeof out !== "object" || Array.isArray(out)) return quiet();
  if (Object.keys(out).some((x) => !ALLOWED.has(x))) return note(keyFile, "keys"), quiet();
  const hso = out.hookSpecificOutput;
  if (hso !== undefined && (!hso || typeof hso !== "object" || (hso.hookEventName !== undefined && hso.hookEventName !== name))) return note(keyFile, "event"), quiet();
  process.stdout.write(JSON.stringify(out), quiet);
}

module.exports = { C, PLUGIN_VERSION, SILENT, ALLOWED };
if (require.main === module) main().catch(quiet);
