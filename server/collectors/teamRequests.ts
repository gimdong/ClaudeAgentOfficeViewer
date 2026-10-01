import { open } from "node:fs/promises";
import { MAX_FIELD, redact, toGraphemes } from "../events/summarize";

/**
 * 팀원이 리드에게 보낸 "[결정 필요]" 메시지(Phase 2 스펙 6장). 보고서만 보여 주고 답은 터미널(리드 세션)에서 한다.
 * 리드 대화 기록의 user 항목 텍스트에 `<teammate-message teammate_id="이름" color="…" summary="요약">본문</teammate-message>`로
 * 들어 있다(2026-10-02 실제 기록의 구조로 확인). 리드가 그 팀원에게 SendMessage를 보내거나 30분이 지나면 풀린다.
 */
export const TEAM_REQUEST_TTL = 30 * 60_000;
/** 대화 기록은 끝부분만 읽는다 */
export const TAIL_BYTES = 256 * 1024;
const MARK = "[결정 필요]";
const TAG = /<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g;

export interface TeamRequest {
  from: string;
  at: number;
  /** redact 뒤 200자 */
  summary: string;
}

const ENTITIES: Record<string, string> = { "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
const unescape = (s: string) => s.replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => ENTITIES[m]);
const attr = (attrs: string, name: string) => {
  const v = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
  return v === undefined ? undefined : unescape(v);
};
const cut = (s: string) => toGraphemes(redact(s)).slice(0, MAX_FIELD).join("");

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((c) => (c as { type?: unknown } | null)?.type === "text" && typeof (c as { text?: unknown }).text === "string").map((c) => (c as { text: string }).text);
}

/** 순수 함수: 아직 풀리지 않은 요청을 팀원당 하나(가장 최근)씩 */
export function parseTeamRequests(entries: unknown[], now: number): TeamRequest[] {
  const waiting = new Map<string, TeamRequest>();
  for (const raw of entries) {
    const e = raw as { type?: unknown; timestamp?: unknown; message?: { content?: unknown } } | null;
    if (!e || typeof e !== "object") continue;
    if (e.type === "user") {
      const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
      if (Number.isNaN(at)) continue;
      for (const text of textsOf(e.message?.content)) {
        for (const m of text.matchAll(TAG)) {
          const from = attr(m[1], "teammate_id");
          if (!from || from === "team-lead") continue;
          const summary = attr(m[1], "summary");
          const firstLine = m[2].trimStart().split("\n")[0].trim();
          if (!summary?.startsWith(MARK) && !firstLine.startsWith(MARK)) continue;
          waiting.set(from, { from, at, summary: cut(summary ?? firstLine) });
        }
      }
    } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      // 리드가 그 팀원에게 답했으면 푼다(이 항목보다 앞선 요청만 — 순서대로 보므로 자연히 그렇다)
      for (const c of e.message.content as Array<{ type?: unknown; name?: unknown; input?: { to?: unknown } } | null>) {
        if (c?.type === "tool_use" && c.name === "SendMessage" && typeof c.input?.to === "string") waiting.delete(c.input.to);
      }
    }
  }
  return [...waiting.values()].filter((r) => now - r.at <= TEAM_REQUEST_TTL);
}

/** 리드 대화 기록의 끝부분(최대 256KB)만 읽는다. 읽기 실패는 던진다(부르는 쪽이 warnCaught 뒤 요청 없음으로 본다) */
export async function readTeamRequests(leadTranscript: string, now: number): Promise<TeamRequest[]> {
  const fh = await open(leadTranscript, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    let lines = buf.subarray(0, got).toString("utf8").split("\n");
    if (start > 0) lines = lines.slice(1); // 중간에서 잘린 첫 줄
    const entries: unknown[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        entries.push(JSON.parse(l));
      } catch {
        /* 깨진 줄 */
      }
    }
    return parseTeamRequests(entries, now);
  } finally {
    await fh.close();
  }
}
