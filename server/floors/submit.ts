import type { ChannelHub } from "./channels";
import { LEAD_ID } from "./leadText";
import type { PairingBook } from "./pairing";
import type { ReportStore } from "./reports";
import { getLogger } from "../log";

/** 도구 인자 상한(스펙 3장). channel 서버(server.mjs)도 같은 숫자로 먼저 거른다 */
export const SUBMIT_LIMITS = { title: 200, bodyBytes: 64 * 1024, question: 4_000, options: 6, option: 200 } as const;
const NONCE = /^[0-9a-f]{32}$/;
const MEMBER = /^(?!-)[\p{L}\p{N} ._-]{1,40}$/u;
const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");

type Out = { status: number; body: object };
const KINDS = ["submit_report", "submit_handover", "ask_user"] as const;
type Kind = (typeof KINDS)[number];

/** 도구 인자 형식 검사(크기는 글자 수, 본문만 바이트) — 맞으면 null, 아니면 이유 한 단어 */
export function argsError(kind: Kind, a: Record<string, unknown>): string | null {
  const keys = { submit_report: ["request_id", "title", "body"], submit_handover: ["request_id", "member", "body"], ask_user: ["question", "options"] }[kind];
  if (Object.keys(a).some((k) => !keys.includes(k))) return "args";
  if (kind === "ask_user") {
    if (!str(a.question, SUBMIT_LIMITS.question)) return "question";
    if (a.options !== undefined && (!Array.isArray(a.options) || a.options.length > SUBMIT_LIMITS.options || !a.options.every((o) => str(o, SUBMIT_LIMITS.option)))) return "options";
    return null;
  }
  if (typeof a.request_id !== "string" || !LEAD_ID.test(a.request_id)) return "request_id";
  if (kind === "submit_report" && !str(a.title, SUBMIT_LIMITS.title)) return "title";
  if (kind === "submit_handover" && (typeof a.member !== "string" || !MEMBER.test(a.member))) return "member";
  if (typeof a.body !== "string" || !a.body || Buffer.byteLength(a.body) > SUBMIT_LIMITS.bodyBytes || a.body.includes("\0")) return "body";
  return null;
}

/**
 * /channel/submit(Phase 6b 스펙 3장·11장 b): 본문 {kind, nonce, args, mac}. 인증은 연결의 ack 토큰 + 그 연결 키로 만든
 * mac = HMAC(sk, JSON.stringify(["submit", kind, nonce, args])). 층은 연결로만 정한다. 실패 이유는 응답의 한 단어뿐(본문을 싣지 않는다)
 * - submit_report: 그 층에 건 report 요청 id만 한 번, 팀리더 것만(짝짓기 B311)
 * - submit_handover: 그 층에 건 retire 요청 id만 한 번, member는 retire 때 정한 이름(12장 b), 팀리더나 그 팀원 것만. 먼저 온 것만 쓴다
 * - ask_user: 질문 id q-8hex를 만들고 주인(짝짓기)과 함께 저장
 */
export function handleSubmit(d: { hub: Pick<ChannelHub, "verifySubmit">; reports: ReportStore; pairing: PairingBook }, token: string | undefined, body: unknown): Out {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!token || !b || typeof b.mac !== "string" || typeof b.nonce !== "string" || !NONCE.test(b.nonce) || !(KINDS as readonly string[]).includes(b.kind as string) || !b.args || typeof b.args !== "object" || Array.isArray(b.args))
    return { status: 401, body: {} };
  const kind = b.kind as Kind;
  const args = b.args as Record<string, unknown>;
  const floor = d.hub.verifySubmit(token, JSON.stringify(["submit", kind, b.nonce, args]), b.mac, b.nonce);
  if (!floor) return { status: 401, body: {} };
  const bad = argsError(kind, args);
  if (bad) return { status: 400, body: { error: bad } };
  const owner = d.pairing.ownerOf(kind, args);
  const isLead = owner.name === "team-lead" && !owner.sub;
  if (kind === "ask_user") {
    const id = d.reports.addQuestion(floor, args.question as string, (args.options as string[] | undefined) ?? [], owner);
    getLogger().info("reports", "question", { owner: isLead ? "lead" : owner.sub ? "sub" : "member" });
    return { status: 200, body: { questionId: id } };
  }
  if (kind === "submit_report") {
    if (!isLead) return { status: 403, body: { error: "not-lead" } };
    if (!d.reports.take(args.request_id as string, floor, "report")) return { status: 409, body: { error: "request" } };
    d.reports.add(floor, { id: args.request_id as string, kind: "report", title: args.title as string, body: args.body as string });
    getLogger().info("reports", "report", {});
    return { status: 200, body: {} };
  }
  // submit_handover: 이름이 retire 때 정한 것과 같아야 하고, 보낸 쪽은 팀리더나 그 팀원(서브에이전트 아님)
  const member = args.member as string;
  if (!isLead && (owner.sub || owner.name !== member)) return { status: 403, body: { error: "not-allowed" } };
  const p = d.reports.peek(args.request_id as string, floor, "handover");
  if (!p || p.member !== member) return { status: 409, body: { error: "request" } };
  d.reports.take(args.request_id as string, floor, "handover");
  d.reports.add(floor, { id: args.request_id as string, kind: "handover", member, body: args.body as string });
  getLogger().info("reports", "handover", { by: isLead ? "lead" : "member" });
  return { status: 200, body: {} };
}
