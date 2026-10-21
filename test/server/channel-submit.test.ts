import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leadInstruct } from "../../server/floors/lead";
import { PairingBook } from "../../server/floors/pairing";
import { ReportStore } from "../../server/floors/reports";
import { handleSubmit } from "../../server/floors/submit";
import { Logger, setLogger } from "../../server/log";

// Phase 6b Task 2: /channel/submit 처리(스펙 3장·11장 b·12장 b). MAC은 ChannelHub.verifySubmit이 보고(channels.test·security), 여기서는 그 뒤 규칙
const TOKEN = "a".repeat(64);
const NONCE = () => Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
let reports: ReportStore;
let pairing: PairingBook;
let verified: string | null;
const hub = { verifySubmit: () => verified };
beforeEach(() => {
  setLogger(new Logger({ dir: "" }));
  reports = new ReportStore();
  pairing = new PairingBook();
  verified = "s1";
});
afterEach(() => undefined);
const submit = (kind: string, args: object, extra: object = {}) => handleSubmit({ hub, reports, pairing }, TOKEN, { kind, nonce: NONCE(), args, mac: "m", ...extra });
/** lead 지시를 보내 요청 id를 건다(실제 경로와 같게) */
function ask(body: object, floor = "s1"): string {
  const r = leadInstruct({ instruct: () => ({ ok: true, id: "i", state: "sent" }) }, floor, false, body, ["team-lead", "builder", "tester"], reports);
  expect(r.status).toBe(200);
  return (r.body as { requestId: string }).requestId;
}
const preToolUse = (tool: string, input: object, agent: object = {}) =>
  pairing.onPreToolUse({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: `mcp__plugin_claude-office_office-channel__${tool}`, tool_input: input, ...agent });
const TESTER = { agent_id: "atester-1a2b3c", agent_type: "tester" };

describe("handleSubmit — 인증·형식", () => {
  it("토큰 없음·mac·nonce 형식·모르는 kind·args 배열·MAC 실패(verifySubmit null)는 401", () => {
    expect(handleSubmit({ hub, reports, pairing }, undefined, { kind: "ask_user", nonce: NONCE(), args: { question: "q" }, mac: "m" }).status).toBe(401);
    for (const extra of [{ mac: 3 }, { nonce: "short" }, { kind: "shell" }, { args: [] }]) expect(submit("ask_user", { question: "q" }, extra).status, JSON.stringify(extra)).toBe(401);
    verified = null;
    expect(submit("ask_user", { question: "q" }).status).toBe(401);
  });

  it("상한·타입이 틀리면 400(이유 한 단어)", () => {
    const rid = ask({ kind: "report" });
    expect(submit("submit_report", { request_id: rid, title: "t".repeat(201), body: "b" })).toEqual({ status: 400, body: { error: "title" } });
    expect(submit("submit_report", { request_id: rid, title: "t", body: "가".repeat(22_000) })).toEqual({ status: 400, body: { error: "body" } }); // 64KB는 바이트
    expect(submit("ask_user", { question: "q", options: ["a", "b", "c", "d", "e", "f", "g"] })).toEqual({ status: 400, body: { error: "options" } });
    expect(submit("ask_user", { question: "q", extra: 1 })).toEqual({ status: 400, body: { error: "args" } });
  });
});

describe("handleSubmit — 보고서·인수인계", () => {
  it("보고서는 그 층에 건 report 요청 id로 한 번만: 수정 요청(revise)도 다시 보고할 id를 건다", () => {
    const rid = ask({ kind: "report" });
    expect(submit("submit_report", { request_id: rid, title: "t", body: "b" }).status).toBe(200);
    expect(submit("submit_report", { request_id: rid, title: "t", body: "b" })).toEqual({ status: 409, body: { error: "request" } });
    expect(reports.list("s1")).toMatchObject([{ id: rid, kind: "report", title: "t", state: "pending" }]);
    const again = ask({ kind: "revise", reportId: rid, text: "고쳐 주세요" });
    expect(submit("submit_report", { request_id: again, title: "t2", body: "b2" }).status).toBe(200);
    verified = "s2";
    expect(submit("submit_report", { request_id: ask({ kind: "report" }), title: "t", body: "b" }).status).toBe(409); // s1에 건 id를 s2 연결로
  });

  it("보고서는 팀리더 것만(짝짓기 B311) — 팀원이 낸 것은 403이고 요청 id는 그대로 남는다", () => {
    const rid = ask({ kind: "report" });
    const args = { request_id: rid, title: "t", body: "b" };
    preToolUse("submit_report", args, TESTER);
    expect(submit("submit_report", args)).toEqual({ status: 403, body: { error: "not-lead" } });
    expect(submit("submit_report", args).status).toBe(200); // 짝이 없으면 팀리더
  });

  it("인수인계는 retire 때 정한 이름으로만, 팀리더나 그 팀원이 낼 수 있고 먼저 온 것만 쓴다", () => {
    const rid = ask({ kind: "retire", member: "tester" });
    expect(submit("submit_handover", { request_id: rid, member: "builder", body: "m" })).toEqual({ status: 409, body: { error: "request" } });
    const mine = { request_id: rid, member: "tester", body: "내 메모" };
    preToolUse("submit_handover", mine, TESTER);
    expect(submit("submit_handover", mine).status).toBe(200);
    expect(submit("submit_handover", { request_id: rid, member: "tester", body: "리드가 대신" }).status).toBe(409);
    expect(reports.list("s1")).toMatchObject([{ kind: "handover", member: "tester", body: "내 메모" }]);
    const other = ask({ kind: "retire", member: "builder" });
    const args = { request_id: other, member: "builder", body: "x" };
    preToolUse("submit_handover", args, TESTER); // 다른 팀원이 남의 인수인계를 내면 거절
    expect(submit("submit_handover", args)).toEqual({ status: 403, body: { error: "not-allowed" } });
  });
});

describe("handleSubmit — ask_user", () => {
  it("질문 id q-8hex를 돌려주고 주인(짝짓기)과 함께 저장한다. 짝이 없으면 팀리더", () => {
    const args = { question: "어느 쪽?", options: ["A", "B"] };
    preToolUse("ask_user", args, TESTER);
    const r = submit("ask_user", args);
    expect(r.status).toBe(200);
    const id = (r.body as { questionId: string }).questionId;
    expect(id).toMatch(/^q-[0-9a-f]{8}$/);
    expect(reports.question(id)).toMatchObject({ floor: "s1", question: "어느 쪽?", options: ["A", "B"], owner: { name: "tester", sub: false } });
    const lead = submit("ask_user", { question: "다른 질문" });
    expect(reports.question((lead.body as { questionId: string }).questionId)!.owner).toEqual({ name: "team-lead", sub: false });
  });
});
