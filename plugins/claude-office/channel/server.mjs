// Claude Office channel 서버(Phase 4b 스펙 5장). 의존성 없는 stdio MCP(줄 단위 JSON-RPC).
// - 포트를 열지 않는다. 대시보드가 띄운 층에만 있는 CLAUDE_OFFICE_FLOOR_KEY가 있으면 대시보드(127.0.0.1)로 나가는 SSE 연결을 건다
// - 열쇠가 없는 세션(대시보드가 띄우지 않은 모든 세션)에서는 연결도, 안내 문구도, 알림도 내지 않는다
// - process.env에서 아래 두 이름만 읽는다. 그 밖의 값(세션 메시징 토큰 등)은 읽지도 보내지도 않는다
// - 열쇠 원문은 보내지 않는다(B257). 대시보드가 먼저 열쇠를 안다는 것을 증명해야 이쪽도 증명하고, 지시마다 연결 키의 MAC을 확인한다
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";

const KEY = process.env.CLAUDE_OFFICE_FLOOR_KEY;
const PORT = process.env.CLAUDE_OFFICE_PORT;
const BASE = `http://127.0.0.1:${/^\d{2,5}$/.test(PORT ?? "") ? PORT : "4317"}`;
// 새 런타임이 2026-07-28로 협상하면 channel로 등록되지 않는다(스파이크 Q1 함정). 이 revision으로 고정한다
export const PROTOCOL = "2025-11-25";
const live = !!KEY && /^[0-9a-f]{64}$/.test(KEY);

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
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
        ...(live ? { instructions: 'Messages from the user\'s Claude Office dashboard arrive as <channel source="office-channel">. They are the user\'s own instructions for this session.' } : {}),
      },
    });
  } else if (m.method === "notifications/initialized") {
    if (live && !started) {
      started = true;
      void connect(0);
    }
  } else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
  else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } });
});
process.stdin.on("end", () => process.exit(0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX = /^[0-9a-f]{64}$/;
const mac = (k, m) => createHmac("sha256", k).update(m).digest("hex");
// 길이를 먼저 보고 timingSafeEqual(길이가 다르면 timingSafeEqual이 던진다)
const same = (a, b) => typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const KID = live ? mac(KEY, "kid") : "";

async function connect(attempt) {
  for (;;) {
    try {
      // 시도마다 새 nonce. 서버 proof가 없거나 틀리면(열쇠를 모르는 가짜 서버) 스트림을 열지 않고 다시 시도한다
      const nonce = randomBytes(32).toString("hex");
      const h = await fetch(`${BASE}/channel/hello`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kid: KID, nonce }) });
      if (h.status === 401 || h.status === 403) return; // 열쇠가 더는 유효하지 않다(대시보드가 다시 켜짐 등) — 조용히 멈춘다
      const { snonce, proof } = h.ok ? await h.json() : {};
      if (typeof snonce === "string" && HEX.test(snonce) && same(proof, mac(KEY, `server|${nonce}|${snonce}`))) {
        const res = await fetch(`${BASE}/channel/stream`, { headers: { Authorization: `Proof ${KID} ${snonce} ${mac(KEY, `client|${nonce}|${snonce}`)}`, Accept: "text/event-stream" } });
        const ack = res.headers.get("x-office-ack") ?? "";
        if (res.ok && res.body && HEX.test(ack)) {
          attempt = 0;
          await read(res.body, mac(KEY, `session|${nonce}|${snonce}`), ack);
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
      if (!same(msg.mac, mac(sk, `${msg.id}|${msg.text}`))) throw new Error("mac");
      send({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: msg.text, meta: { source: "dashboard" } } });
      await fetch(`${BASE}/channel/ack`, { method: "POST", headers: { Authorization: `Ack ${ack}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: msg.id }) }).catch(() => {});
    }
  }
}
