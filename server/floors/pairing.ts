import { createHash } from "node:crypto";
import { agentOf, type AgentRef } from "../events/summarize";
import { CHANNEL_TOOL_PREFIX, CHANNEL_TOOLS } from "./control";

const LEAD: AgentRef = { name: "team-lead", sub: false };
/** PreToolUse와 제출 사이 창. 도구 호출은 PreToolUse 직후 channel 서버로 가므로 짧다 */
export const PAIR_WINDOW_MS = 10_000;
const MAX_ENTRIES = 200;

/** 키 순서와 무관한 JSON(같은 입력이면 같은 글) */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** 대화 키(정규화한 session_id)까지 넣는다 — 다른 층끼리 같은 입력으로 짝이 맞지 않게(B321 M2) */
const keyOf = (conv: string, tool: string, input: unknown) => `${conv}|${tool}|${createHash("sha256").update(canonical(input)).digest("hex")}`;

/**
 * channel 제출의 주인(Phase 6b 스펙 11장 b, B311): 이 플러그인 도구의 PreToolUse(/hooks/v2만, 12장 d)를 입력 해시와 짧은 창으로 적어 두고,
 * 제출이 오면 같은 입력의 것을 찾아 그 agent를 주인으로 한다. 한 PreToolUse는 한 번만 쓰고, 짝이 없거나 다른 주인끼리 같은 입력이면(모호) 팀리더
 */
export class PairingBook {
  private entries: Array<{ key: string; owner: AgentRef; at: number; used: boolean }> = [];
  constructor(private readonly o: { now?: () => number } = {}) {}
  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private prune(): void {
    const since = this.now() - PAIR_WINDOW_MS;
    this.entries = this.entries.filter((e) => !e.used && e.at >= since).slice(-MAX_ENTRIES);
  }
  onPreToolUse(input: Record<string, unknown>): void {
    const tool = input.tool_name;
    if (input.hook_event_name !== "PreToolUse" || typeof tool !== "string" || !CHANNEL_TOOLS.has(tool) || typeof input.session_id !== "string") return;
    this.prune();
    this.entries.push({ key: keyOf(input.session_id, tool.slice(CHANNEL_TOOL_PREFIX.length), input.tool_input), owner: agentOf(input) ?? LEAD, at: this.now(), used: false });
  }
  /** conv는 제출이 온 연결의 층을 대화 키로 바꾼 값, tool은 짧은 이름(ask_user 등), args는 도구 인자 */
  ownerOf(conv: string, tool: string, args: unknown): AgentRef {
    this.prune();
    const key = keyOf(conv, tool, args);
    const hits = this.entries.filter((e) => e.key === key);
    if (hits.length === 0) return LEAD;
    if (new Set(hits.map((e) => `${e.owner.name}|${e.owner.sub}`)).size > 1) return LEAD;
    hits[0].used = true;
    return hits[0].owner;
  }
}
