// Claude Office channel 서버(Phase 4b 스펙 5장). 의존성 없는 stdio MCP(줄 단위 JSON-RPC).
// - 포트를 열지 않는다. 대시보드가 띄운 층에만 있는 CLAUDE_OFFICE_FLOOR_KEY_FILE(0600 열쇠 파일, B265 — 열쇠 원문은 프로세스 인자·환경에
//   싣지 않는다)을 읽을 수 있으면 대시보드(127.0.0.1)로 나가는 SSE 연결을 건다
// - 열쇠가 없는 세션(대시보드가 띄우지 않은 모든 세션)에서는 연결도, 안내 문구도, 알림도 내지 않는다
// - process.env에서 아래 세 이름만 읽는다. 그 밖의 값(세션 메시징 토큰 등)은 읽지도 보내지도 않는다
// - 열쇠 원문은 보내지 않는다(B257). 대시보드가 먼저 열쇠를 안다는 것을 증명해야 이쪽도 증명하고, 지시마다 연결 키의 MAC을 확인한다
// - 팀리더 프로세스에서만 연결한다(Phase 6b 스펙 12장 g ①). agent team의 팀원은 Claude Code가 `claude --agent-id … --agent-name …
//   --team-name …`로 띄우는 별 프로세스라(세 인자는 함께 와야 한다 — Claude Code 2.1.304 소스의 인자 검사), 조상 프로세스 명령줄에
//   --agent-id가 있으면 팀원 프로세스로 보고 연결도 도구도 내지 않는다. 같은 프로세스 안의 팀원·서브에이전트는 리드의 이 서버를 같이 쓴다
// - 도구 세 개(submit_report·submit_handover·ask_user, 스펙 3장)는 지금 연결의 세션 키로 MAC을 붙여 /channel/submit으로 낸다
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsc, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const KEY_FILE = process.env.CLAUDE_OFFICE_FLOOR_KEY_FILE;
const FLOOR_KEY = (() => {
  try {
    return KEY_FILE ? readFileSync(KEY_FILE, "utf8").trim() : undefined;
  } catch {
    return undefined; // 파일이 없거나 못 읽으면 열쇠 없는 세션과 같다(조용히)
  }
})();
const PORT = process.env.CLAUDE_OFFICE_PORT;
// 이 서버를 띄운 대화의 id(beta.23 설계 7.1). Claude Code가 MCP 서버 환경에 넣는다(2.1.311에서 확인, 문서에는 없음).
// 핸드셰이크에 밝히고 세 증명에 묶는다 — 대시보드는 층 열쇠마다 띄울 때 정한 대화만 받는다(데몬이 물려준 열쇠 경로로 다른 대화가 붙지 않게).
// 없거나 형식이 틀리면 밝히지 않는다(대시보드가 403 no-conv로 거절하고 층에 표시)
const CONV = /^[A-Za-z0-9_-]{1,128}$/.test(process.env.CLAUDE_CODE_SESSION_ID ?? "") ? process.env.CLAUDE_CODE_SESSION_ID : undefined;
const BASE = `http://127.0.0.1:${/^\d{2,5}$/.test(PORT ?? "") ? PORT : "4317"}`;
// 새 런타임이 2026-07-28로 협상하면 channel로 등록되지 않는다(스파이크 Q1 함정). 이 revision으로 고정한다
export const PROTOCOL = "2025-11-25";
/**
 * 이 서버를 띄운 claude가 agent team 팀원 프로세스인지(Phase 6b 스펙 12장 g ①). Claude Code 2.1.304에서 확인: 팀원은
 * `claude --agent-id … --agent-name … --team-name …`로 뜨는 별 프로세스이고 세 인자는 함께 와야 한다(그 버전의 인자 검사).
 * 세 인자가 모두 따로 된 인자로 있을 때만 팀원으로 본다(security Minor-8 — 첫 지시·이름 글자 속 "--agent-id" 한 낱말로는 오판하지 않게).
 * Linux는 /proc/<pid>/cmdline(NUL 구분)으로 인자 경계를 정확히 보고, 그 밖은 `ps -o args`(공백으로 이은 한 줄)를 낱말로 나눠 본다.
 * Claude Code는 MCP 서버를 직접 띄우므로 부모가 claude다. 부모가 셸이면 하나 위까지만 본다(더 위로 가면 팀원 세션 안에서 돌린
 * 테스트 아래의 서버까지 팀원으로 오판). 한계: 이 인자는 문서에 없는 Claude Code 내부 인자라 이름이 바뀌면 이 판별은 꺼지고
 * 대시보드의 "첫 연결 우선"(12장 g ②, 같은 층 두 번째 연결은 409)만 남는다. ps를 못 쓰면(Windows 등) 팀원이 아닌 것으로 본다
 */
const TEAMMATE_FLAGS = ["--agent-id", "--agent-name", "--team-name"];
function procOf(pid) {
  if (process.platform === "linux") {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return { ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]), argv };
    } catch {
      return null;
    }
  }
  try {
    const line = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /^(\d+)\s+([\s\S]*)$/.exec(line);
    return m ? { ppid: Number(m[1]), argv: m[2].split(/\s+/) } : null;
  } catch {
    return null;
  }
}
function teammateProcess() {
  let pid = process.ppid;
  for (let i = 0; i < 2 && pid > 1; i++) {
    const p = procOf(pid);
    if (!p || p.argv.length === 0) return false;
    if (TEAMMATE_FLAGS.every((f) => p.argv.some((a) => a === f || a.startsWith(`${f}=`)))) return true;
    if (!/(^|\/)-?(sh|bash|zsh|dash)$/.test(p.argv[0])) return false;
    pid = p.ppid;
  }
  return false;
}
/**
 * 대안 A(beta.23 설계 7.4): 층 열쇠가 없으면 시작할 때 한 번 자기 대화 이름의 대화 열쇠를 찾는다. 사용자가 대시보드에서
 * [백그라운드로 연결 옮기기]를 확인한 뒤 이 세션에서 /mcp로 다시 연결하면 붙는다. 시작 뒤에 찾지 않는 이유: channel 능력은
 * initialize 때만 알릴 수 있다. 위치는 환경이 아닌 고정 기본값(~/.claude-office/floors — 데몬이 물려준 환경을 믿지 않는다, security 4·L2).
 * 부모가 claude 프로세스일 때만(대화 id를 물려받은 Bash 자식·테스트가 붙지 않게, M2). 열쇠 파일은 링크를 따라가지 않고
 * 자기 소유 일반 파일·0600/0400·64자 hex, 폴더는 자기 소유·그룹/남 쓰기 불가일 때만(대시보드 readKeyFile과 같은 수준)
 * 테스트 전용 인자(--floors-dir, --allow-any-parent)는 환경이 아니라 명령줄이라 자식에게 물려지지 않는다
 */
const CONV_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const own = (st) => typeof process.getuid !== "function" || st.uid === process.getuid();
function parentIsClaude() {
  if (process.argv.includes("--allow-any-parent")) return true;
  const p = procOf(process.ppid);
  // 설치된 claude 실행 파일(…/claude/versions/<버전>) 또는 이름이 claude인 프로세스(bg-spare)만 — 경로 중간의 claude 폴더는 받지 않는다(security #3-6)
  const a0 = p?.argv[0] ?? "";
  return /(^|\/)claude$/.test(a0) || /\/claude\/versions\/[^/]+$/.test(a0);
}
function readConvKey(conv) {
  const dir = argAfter("--floors-dir") ?? join(homedir(), ".claude-office", "floors");
  try {
    const d = lstatSync(dir);
    if (!d.isDirectory() || !own(d) || (d.mode & 0o022) !== 0) return undefined;
  } catch {
    return undefined;
  }
  let fd;
  try {
    fd = openSync(join(dir, `conv-${conv}.key`), fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !own(st) || ![0o600, 0o400].includes(st.mode & 0o777)) return undefined;
    const k = readFileSync(fd, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(k) ? k : undefined;
  } finally {
    closeSync(fd);
  }
}
// 대화 열쇠를 먼저 본다(리뷰 #3): bg 대화는 데몬이 물려준 층 열쇠 경로를 가질 수 있다 — 그 층 열쇠로는 대시보드가 거절한다(7.1).
// 대화 열쇠는 사람 확인 뒤에만 생기고 그 대화 하나만 받으므로 앞세워도 허용 범위가 넓어지지 않는다
const LINK_KEY = CONV && CONV_UUID.test(CONV) && parentIsClaude() ? readConvKey(CONV) : undefined;
/** 열쇠와 MAC 용도 접두사: 층 열쇠는 "", 대화 열쇠는 "conv-"(M5 — 층 자리로 붙지 못하게) */
const KEY = LINK_KEY ?? FLOOR_KEY;
const PRE = LINK_KEY ? "conv-" : "";
const live = !!KEY && /^[0-9a-f]{64}$/.test(KEY) && !teammateProcess();

/** 도구(스펙 3장). 크기는 대시보드(server/floors/submit.ts SUBMIT_LIMITS)와 같다 */
const LIMITS = { title: 200, bodyBytes: 64 * 1024, question: 4000, options: 6, option: 200 };
const REQ_ID = { type: "string", description: "대시보드 지시 머리말의 지시 id(r-xxxxxxxx)" };
const TOOLS = [
  {
    name: "submit_report",
    description: "사용자의 보고 요청([대시보드 지시 r-…])에 보고서를 제출합니다. 대시보드 서류철에 들어갑니다.",
    inputSchema: { type: "object", properties: { request_id: REQ_ID, title: { type: "string", maxLength: LIMITS.title }, body: { type: "string", description: "보고서 본문(64KB까지, 마크다운은 글자로 보입니다)" } }, required: ["request_id", "title", "body"], additionalProperties: false },
  },
  {
    name: "submit_handover",
    description: "퇴사 지시를 받은 팀원의 인수인계 메모를 제출합니다.",
    inputSchema: { type: "object", properties: { request_id: REQ_ID, member: { type: "string", description: "퇴사하는 팀원 이름" }, body: { type: "string", description: "인수인계 메모(64KB까지)" } }, required: ["request_id", "member", "body"], additionalProperties: false },
  },
  {
    name: "ask_user",
    description: "사용자의 결정이나 답이 필요할 때 대화 글 대신 부릅니다. 질문이 대시보드에 손들기로 뜨고, 이 도구는 바로 돌아옵니다. 답은 다음 대시보드 지시로 옵니다.",
    inputSchema: { type: "object", properties: { question: { type: "string", maxLength: LIMITS.question }, options: { type: "array", maxItems: LIMITS.options, items: { type: "string", maxLength: LIMITS.option } } }, required: ["question"], additionalProperties: false },
  },
];
const TEXT = {
  ok: "대시보드에 전달했습니다.",
  offline: "대시보드에 연결되지 않았습니다 — 사용자에게 터미널에서 물어 주세요.",
  refused: "대시보드가 받지 않았습니다(요청 id가 없거나, 이미 제출했거나, 이 층의 것이 아닙니다).",
  notLead: "이 제출은 팀리더만 할 수 있습니다.",
  format: (why) => `형식이 맞지 않습니다(${why}).`,
};
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
function argsError(name, a) {
  const keys = { submit_report: ["request_id", "title", "body"], submit_handover: ["request_id", "member", "body"], ask_user: ["question", "options"] }[name];
  if (!keys) return "tool";
  if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((k) => !keys.includes(k))) return "args";
  if (name === "ask_user") {
    if (!str(a.question, LIMITS.question)) return "question";
    if (a.options !== undefined && (!Array.isArray(a.options) || a.options.length > LIMITS.options || !a.options.every((o) => str(o, LIMITS.option)))) return "options";
    return null;
  }
  if (typeof a.request_id !== "string" || !/^r-[0-9a-f]{8}$/.test(a.request_id)) return "request_id";
  if (name === "submit_report" && !str(a.title, LIMITS.title)) return "title";
  if (name === "submit_handover" && !str(a.member, 40)) return "member";
  if (typeof a.body !== "string" || !a.body || Buffer.byteLength(a.body) > LIMITS.bodyBytes) return "body";
  return null;
}
/** 지금 연결의 세션 키와 ack 토큰(스트림이 열려 있는 동안만) */
let session = null;
async function callTool(name, a) {
  const why = argsError(name, a);
  if (why) return { text: TEXT.format(why), isError: true };
  const s = session;
  if (!s) return { text: TEXT.offline, isError: true };
  const nonce = randomBytes(16).toString("hex");
  let r;
  try {
    r = await fetch(`${BASE}/channel/submit`, { method: "POST", headers: { Authorization: `Ack ${s.ack}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: name, nonce, args: a, mac: mac(s.sk, JSON.stringify(["submit", name, nonce, a])) }), signal: AbortSignal.timeout(5000) });
  } catch {
    return { text: TEXT.offline, isError: true };
  }
  if (r.status === 200) {
    const b = await r.json().catch(() => ({}));
    if (name === "ask_user" && /^q-[0-9a-f]{8}$/.test(b.questionId ?? "")) return { text: `${TEXT.ok} 질문 id: ${b.questionId} — 사용자의 답은 다음 대시보드 지시로 옵니다.`, isError: false };
    return { text: TEXT.ok, isError: false };
  }
  if (r.status === 403) return { text: TEXT.notLead, isError: true };
  if (r.status === 400) return { text: TEXT.format((await r.json().catch(() => ({}))).error ?? "args"), isError: true };
  if (r.status === 409) return { text: TEXT.refused, isError: true };
  return { text: TEXT.offline, isError: true };
}

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
// stdout이 닫히면(EPIPE — /mcp 재연결 뒤 옛 서버) 끝낸다. 연결을 쥐고 남아 새 서버가 409를 받지 않게(설계 7.4)
process.stdout.on("error", () => process.exit(0));
let started = false;

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: PROTOCOL,
        capabilities: live ? { experimental: { "claude/channel": {} }, tools: {} } : { tools: {} },
        serverInfo: { name: "office-channel", version: "1" },
        ...(live
          ? {
              instructions:
                'Messages from the user\'s Claude Office dashboard arrive as <channel source="office-channel">. They are the user\'s own instructions for this session. ' +
                "When you need the user's decision or answer, call the ask_user tool instead of asking in chat text (the user may not be watching the terminal). " +
                "Answer a report request ([대시보드 지시 r-…]) with submit_report, and a handover request with submit_handover, using that request id.",
            }
          : {}),
      },
    });
  } else if (m.method === "notifications/initialized") {
    if (live && !started) {
      started = true;
      void connect(0);
    }
  } else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: live ? TOOLS : [] } });
  else if (m.method === "tools/call") {
    const name = m.params?.name;
    if (!live || !TOOLS.some((t) => t.name === name)) send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown tool" } });
    else void callTool(name, m.params?.arguments).then(({ text, isError }) => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError } }));
  }
  else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } });
});
process.stdin.on("end", () => process.exit(0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX = /^[0-9a-f]{64}$/;
const mac = (k, m) => createHmac("sha256", k).update(m).digest("hex");
// 길이를 먼저 보고 timingSafeEqual(길이가 다르면 timingSafeEqual이 던진다)
const same = (a, b) => typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const KID = live ? mac(KEY, `${PRE}kid`) : "";

async function connect(attempt) {
  let busy = 0; // 409(같은 층에 리드 연결이 있음) 다시 시도 횟수 — 2초에서 두 배씩, 최대 60초(B321 M4)
  for (;;) {
    try {
      // 시도마다 새 nonce. 서버 proof가 없거나 틀리면(열쇠를 모르는 가짜 서버) 스트림을 열지 않고 다시 시도한다
      const nonce = randomBytes(32).toString("hex");
      const h = await fetch(`${BASE}/channel/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kid: KID, nonce, ...(CONV ? { conv: CONV } : {}) }) });
      // 403 + reason(beta.23 설계 7.2): 이 열쇠는 이 대화의 것이 아니다(또는 대화 id가 없다) — 다시 시도하지 않는다.
      // reason이 없는 403(Host 검사·같은 계정 검사 등)은 지금처럼 아래에서 다시 시도한다(리뷰 #3-6)
      if (h.status === 403 && (await h.json().catch(() => null))?.reason) return;
      // 모르는 열쇠: 대시보드가 층을 정리했으면 열쇠 파일도 지웠다 — 그때만 조용히 멈춘다. 파일이 있으면(재시작 직후 등록 누락 등)
      // 아래 백오프(최대 30초)로 다시 시도한다(스펙 12장 n)
      if (h.status === 401 && !(KEY_FILE && existsSync(KEY_FILE))) return;
      const { snonce, proof } = h.ok ? await h.json() : {};
      if (typeof snonce === "string" && HEX.test(snonce) && same(proof, mac(KEY, `${PRE}server|${nonce}|${snonce}|${CONV}`))) {
        const res = await fetch(`${BASE}/channel/stream`, { headers: { Authorization: `Proof ${KID} ${snonce} ${mac(KEY, `${PRE}client|${nonce}|${snonce}|${CONV}`)}`, Accept: "text/event-stream" } });
        const ack = res.headers.get("x-office-ack") ?? "";
        if (res.ok && res.body && HEX.test(ack)) {
          attempt = 0;
          busy = 0;
          const sk = mac(KEY, `${PRE}session|${nonce}|${snonce}|${CONV}`);
          session = { sk, ack };
          try {
            await read(res.body, sk, ack);
          } finally {
            session = null;
          }
        } else if (res.status === 409) {
          // 같은 층에 다른 연결(리드)이 살아 있다(스펙 12장 g ②) — 멈추지 않고 기다렸다 다시(리드가 끝나면 이어받는다)
          await sleep(Math.min(60_000, 2000 * 2 ** Math.min(busy++, 5)));
          continue;
        }
      }
    } catch {
      // 대시보드가 꺼졌거나 아직 안 켜짐, 또는 MAC이 틀려 끊음 — 다시 잇는다
    }
    await sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)));
  }
}

async function read(body, sk, ack) {
  const dec = new TextDecoder();
  const seen = new Set(); // 이 연결에서 넣은 지시 id(B268 — 같은 지시를 다시 보내는 재전송은 넣지 않는다)
  let buf = "";
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev !== "instruction" || !data) continue;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        continue;
      }
      if (typeof msg?.id !== "string" || typeof msg?.text !== "string") continue;
      // 글을 바꾼 중계(B264): 넣지 않고 연결을 끊는다(던지면 스트림을 닫고 connect가 다시 잇는다)
      if (!same(msg.mac, mac(sk, JSON.stringify([msg.id, msg.text])))) throw new Error("mac");
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value); // 오래 붙어 있는 연결에서도 기억은 1000개(넣은 순서로 오래된 것부터)
      send({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: msg.text, meta: { source: "dashboard" } } });
      await fetch(`${BASE}/channel/ack`, { method: "POST", headers: { Authorization: `Ack ${ack}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: msg.id }) }).catch(() => {});
    }
  }
}
