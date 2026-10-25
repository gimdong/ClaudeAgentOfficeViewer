import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/app";
import { ChannelHub } from "../../server/floors/channels";
import { QuestionBoard, STOP_REREAD_MS } from "../../server/floors/questions";
import { CHANNEL_TOOL_PREFIX } from "../../server/floors/control";
import { ReplayWindow, deriveKeys } from "../../server/hooks/v2";
import { readLastAssistantText, readLastAssistantTurn } from "../../server/lib/jsonlTail";
import { Logger, setLogger } from "../../server/log";
import { MAX_AWAIT_TEXT } from "../../server/events/askHeuristic";
import { makeSnapshot } from "../web/fixtures";

// Phase 6b 스펙 4장·11장 b c·12장 d e, qa #605 사례(CLEAR·KEEP·OWNER)
const LEAD = { name: "team-lead", sub: false };
const TESTER = { name: "tester", sub: false };
const ev = (name: string, agent: object = {}, extra: object = {}) => ({ hook_event_name: name, session_id: "c1", ...agent, ...extra });
const MATE = (n: string) => ({ agent_id: `a${n}-1a2b3c`, agent_type: n });
const SUB = { agent_id: "a0123456789abcdef", agent_type: "Explore" };
let pokes = 0;
beforeEach(() => {
  setLogger(new Logger({ dir: "" }));
  pokes = 0;
});
const board = (lastText?: string | null) => new QuestionBoard({ lastText: async () => lastText ?? null, onChange: () => void pokes++ });

describe("QuestionBoard — 해제(B308)와 주인(11장 b)", () => {
  it("CLEAR 1·2(스펙 12장 k): 팀리더 본인의 UserPromptSubmit은 모두 지우고, PreToolUse는 Stop 경로(답을 기다립니다)만 지운다 — ask_user는 남는다", async () => {
    const b = board("배포를 오늘 할까요?");
    b.ask("c1", TESTER, "팀원 질문", []);
    await b.onEvent(ev("Stop"));
    expect(b.list("c1").map((q) => q.source).sort()).toEqual(["ask", "await"]);
    await b.onEvent(ev("PreToolUse", {}, { tool_name: "Bash" }));
    expect(b.list("c1").map((q) => [q.source, q.owner])).toEqual([["ask", "tester"]]);
    b.ask("c1", LEAD, "리드 질문", []);
    await b.onEvent(ev("UserPromptSubmit"));
    expect(b.list("c1")).toEqual([]);
  });

  it("KEEP 1·2·3: 팀원·서브에이전트의 이벤트로는 지우지 않는다", async () => {
    const b = board();
    b.ask("c1", LEAD, "리드 질문", []);
    for (const e of [ev("PreToolUse", MATE("reviewer"), { tool_name: "Read" }), ev("PreToolUse", SUB, { tool_name: "Read" }), ev("SubagentStop", SUB), ev("UserPromptSubmit", MATE("designer"))]) await b.onEvent(e);
    expect(b.list("c1")).toHaveLength(1);
  });

  it("OWNER: 팀원이 부른 질문은 그 책상, 서브에이전트가 부른 것은 리드 책상(리드 본인 아님 표시). 같은 책상의 새 질문은 옛것을 대체", () => {
    const b = board();
    b.ask("c1", TESTER, "첫째", ["A"]);
    const second = b.ask("c1", TESTER, "둘째", []);
    b.ask("c1", { name: "team-lead", sub: true }, "서브의 질문", []);
    const list = b.list("c1");
    expect(list.map((q) => [q.owner, q.text, q.ownerIsLead])).toEqual([["tester", "둘째", false], ["team-lead", "서브의 질문", false]]);
    expect(list[0]).toMatchObject({ id: second, source: "ask", state: "open", since: expect.any(String) });
    expect(second).toMatch(/^q-[0-9a-f]{8}$/);
  });

  it("KEEP 4·B309: 보낸 답은 지우고, 휴업 중 보관한 답은 held — 보관한 답이 나가면 지우고 지우면 다시 open", () => {
    const b = board();
    const a = b.ask("c1", LEAD, "a", []);
    b.onReply(a, "sent");
    expect(b.list("c1")).toEqual([]);
    const q = b.ask("c1", LEAD, "b", []);
    b.onReply(q, "held");
    expect(b.list("c1")[0].state).toBe("held");
    b.heldGone(`lead:reply:${q}`, false);
    expect(b.list("c1")[0].state).toBe("open");
    b.onReply(q, "held");
    b.heldGone(`lead:reply:${q}`, true);
    expect(b.list("c1")).toEqual([]);
    b.heldGone("lead:report", true); // 답이 아닌 키는 무시
  });

  it("휴업 중 보관된(held) 질문은 리드 이벤트로도 지우지 않는다(실제로 보낼 때 지운다)", async () => {
    const b = board();
    const q = b.ask("c1", LEAD, "q", []);
    b.onReply(q, "held");
    await b.onEvent(ev("UserPromptSubmit"));
    expect(b.list("c1")[0].state).toBe("held");
  });
});

describe("QuestionBoard — Stop 대체 경로(스펙 4장·12장 d e·h)", () => {
  it("팀리더 본인의 Stop에서 마지막 글이 물음이면 리드 책상에 await 질문(q-id, 선택지)", async () => {
    const b = board("둘 중 고를지 정해 주세요.\n1. 빠르게\n2. 안전하게");
    await b.onEvent(ev("Stop"));
    expect(b.list("c1")).toMatchObject([{ source: "await", owner: "team-lead", ownerIsLead: true, options: ["빠르게", "안전하게"], state: "open" }]);
    expect(b.list("c1")[0].id).toMatch(/^q-[0-9a-f]{8}$/);
  });

  it("물음이 아니거나 글이 없으면 표시하지 않고, 팀원·서브에이전트의 Stop은 판정하지 않는다", async () => {
    for (const [text, e] of [["다 했습니다.", ev("Stop")], [null, ev("Stop")], ["고칠까요?", ev("Stop", MATE("tester"))], ["고칠까요?", ev("SubagentStop", SUB)], ["고칠까요?", ev("TeammateIdle", {}, { teammate_name: "tester" })]] as const) {
      const b = board(text);
      await b.onEvent(e);
      expect(b.list("c1"), String(text)).toEqual([]);
    }
  });

  it(`긴 글은 뒤 ${MAX_AWAIT_TEXT}자를 남기고 앞에 …(B313)`, async () => {
    const b = board(`${"앞".repeat(5000)} 지금 고칠까요?`);
    await b.onEvent(ev("Stop"));
    const t = b.list("c1")[0].text;
    expect(t.startsWith("…")).toBe(true);
    expect(t.length).toBe(MAX_AWAIT_TEXT + 1);
    expect(t.endsWith("지금 고칠까요?")).toBe(true);
  });
});

describe("B324 I-B: Stop 순간 앞 턴 글로 다시 뜨지 않는다", () => {
  it("지운(또는 답한) 질문과 같은 글이 Stop에 다시 오면 띄우지 않고, 다른 글이면 띄운다", async () => {
    let text = "배포를 오늘 할까요?";
    const b = new QuestionBoard({ lastText: async () => text });
    await b.onEvent(ev("Stop"));
    expect(b.list("c1")).toHaveLength(1);
    await b.onEvent(ev("UserPromptSubmit"));
    await b.onEvent(ev("Stop"));
    expect(b.list("c1")).toEqual([]);
    text = "테스트도 돌릴까요?";
    await b.onEvent(ev("Stop"));
    const [q] = b.list("c1");
    expect(q.text).toBe(text);
    b.onReply(q.id, "sent");
    await b.onEvent(ev("Stop"));
    expect(b.list("c1")).toEqual([]);
  });

  it(`읽은 마지막 assistant가 Stop보다 앞(뒤에 user 항목)이면 ${STOP_REREAD_MS}ms 뒤 한 번만 더 읽고, 그래도 앞이면 띄우지 않는다`, async () => {
    vi.useFakeTimers();
    try {
      for (const [seq, shown] of [[[{ behind: true }, "새 질문 할까요?"], 1], [[{ behind: true }, { behind: true }], 0]] as const) {
        const reads = [...seq];
        let n = 0;
        const b = new QuestionBoard({ lastText: async () => (n++, reads.shift() ?? null) });
        const p = b.onEvent(ev("Stop"));
        await vi.advanceTimersByTimeAsync(STOP_REREAD_MS - 1);
        expect(n).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(n).toBe(2);
        expect(b.list("c1")).toHaveLength(shown);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("B335 ③: 리드가 그 턴에 submit_report를 냈으면 그 Stop은 '답을 기다립니다'를 만들지 않는다", () => {
  const submit = { tool_name: `${CHANNEL_TOOL_PREFIX}submit_report`, tool_input: { request_id: "r-11111111", title: "t", body: "b" } };
  it("UserPromptSubmit 뒤 리드 본인의 submit_report가 있으면 그 턴의 Stop은 건너뛰고, 다음 턴(UserPromptSubmit 뒤)에는 다시 판정한다", async () => {
    const b = board("보고서를 제출했습니다. 검토 후 승인해 주시겠어요?");
    await b.onEvent(ev("UserPromptSubmit"));
    await b.onEvent(ev("PreToolUse", {}, submit));
    await b.onEvent(ev("Stop"));
    expect(b.list("c1")).toEqual([]);
    await b.onEvent(ev("Stop")); // 같은 턴 안의 두 번째 Stop도
    expect(b.list("c1")).toEqual([]);
    await b.onEvent(ev("UserPromptSubmit"));
    await b.onEvent(ev("Stop"));
    expect(b.list("c1")).toHaveLength(1);
  });

  it("팀원·서브에이전트의 submit_report, 다른 도구, 다른 대화는 리드의 Stop 판정을 막지 않는다", async () => {
    for (const [agent, extra, conv] of [[MATE("reviewer"), submit, "c1"], [SUB, submit, "c1"], [{}, { tool_name: `${CHANNEL_TOOL_PREFIX}ask_user`, tool_input: {} }, "c1"], [{}, submit, "c2"]] as const) {
      const b = board("다음으로 진행할까요?");
      await b.onEvent(ev("UserPromptSubmit"));
      await b.onEvent({ ...ev("PreToolUse", agent, extra), session_id: conv });
      await b.onEvent(ev("Stop"));
      expect(b.list("c1"), JSON.stringify([agent, extra.tool_name, conv])).toHaveLength(1);
    }
  });
});

describe("readLastAssistantText — 대화 기록 끝의 마지막 assistant 글", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "co-q-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const line = (o: object) => JSON.stringify(o) + "\n";
  it("마지막 assistant 항목의 text 블록만 잇고, 도구 호출뿐이면 null, 빈 파일도 null", async () => {
    const f = join(dir, "c1.jsonl");
    writeFileSync(f, line({ type: "assistant", message: { content: [{ type: "text", text: "옛 글" }] } }) + line({ type: "user", message: { content: "x" } }) + line({ type: "assistant", message: { content: [{ type: "text", text: "첫 줄" }, { type: "tool_use", name: "x" }, { type: "text", text: "고칠까요?" }] } }));
    expect(await readLastAssistantText(f)).toBe("첫 줄\n고칠까요?");
    writeFileSync(f, line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }));
    expect(await readLastAssistantText(f)).toBeNull();
    writeFileSync(f, "");
    expect(await readLastAssistantText(f)).toBeNull();
  });

  it("B324: 마지막 assistant 뒤에 user 항목(사용자 글·도구 결과)이 있으면 behind — isMeta user는 보지 않는다", async () => {
    const f = join(dir, "c1.jsonl");
    const a = line({ type: "assistant", message: { content: [{ type: "text", text: "옛 질문 할까요?" }] } });
    writeFileSync(f, a + line({ type: "user", message: { content: "다음 일" } }));
    expect(await readLastAssistantTurn(f)).toEqual({ text: "옛 질문 할까요?", behind: true });
    writeFileSync(f, line({ type: "user", message: { content: "처음" } }));
    expect(await readLastAssistantTurn(f)).toEqual({ text: null, behind: true });
    writeFileSync(f, a + line({ type: "user", isMeta: true, message: { content: "caveat" } }) + line({ type: "system", content: "x" }));
    expect(await readLastAssistantTurn(f)).toEqual({ text: "옛 질문 할까요?", behind: false });
  });
});

// ───────── app: 해제·Stop 판정은 /hooks/v2만(12장 d) ─────────
const KEY = Buffer.from("ef".repeat(32), "hex");
const hk = (info: string) => Buffer.from(hkdfSync("sha256", KEY, Buffer.alloc(0), info, 32));
const KID = createHash("sha256").update(KEY).digest("hex").slice(0, 16);
function sealed(event: object) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", hk("claude-office hook req v1"), iv);
  c.setAAD(Buffer.from(KID));
  const ct = Buffer.concat([c.update(JSON.stringify({ v: 1, id: randomBytes(16).toString("hex"), ts: Date.now(), plugin: "t", event })), c.final()]);
  return JSON.stringify({ kid: KID, iv: iv.toString("hex"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("hex") });
}
describe("app — 옛 /hooks/event로 온 팀리더 이벤트는 질문을 지우지 않고, /hooks/v2는 지운다(KEEP 6)", () => {
  let server: Server;
  let port: number;
  let tmp: string;
  let b: QuestionBoard;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "co-qapp-"));
    b = board();
    const hub = new ChannelHub({ file: join(tmp, "e.json"), available: { ok: true } });
    server = createApp({ current: () => makeSnapshot({}), subscribe: () => () => {}, poke: () => {} }, { hookV2: { keys: () => deriveKeys(KEY), seen: new ReplayWindow() }, channels: { hub, launch: async () => ({ ok: false, error: "tmux" }), questions: b } }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });
  const post = (path: string, body: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(body);
    });
  it("같은 팀리더 UserPromptSubmit이라도 옛 입구는 그대로, v2는 지운다(ask_user는 PreToolUse로 지우지 않음, 12장 k)", async () => {
    b.ask("c1", LEAD, "q", []);
    const pre = { hook_event_name: "UserPromptSubmit", session_id: "c1", prompt: "다음" };
    expect(await post("/hooks/event", JSON.stringify(pre))).toBe(200);
    expect(b.list("c1")).toHaveLength(1);
    expect(await post("/hooks/v2", sealed(pre))).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(b.list("c1")).toEqual([]);
  });
});
