import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAIL_BYTES, TEAM_REQUEST_TTL, parseTeamRequests, readTeamRequests } from "../../server/collectors/teamRequests";

// 끝부분만 읽는지 보려고 파일 핸들의 read가 읽은 바이트를 센다
const io = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return {
    ...m,
    open: async (...a: Parameters<typeof m.open>) => {
      const fh = await m.open(...a);
      const read = fh.read.bind(fh) as (...x: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
      (fh as unknown as { read: unknown }).read = async (...x: unknown[]) => {
        const r = await read(...x);
        io.bytes += r.bytesRead;
        return r;
      };
      return fh;
    },
  };
});

const NOW = Date.UTC(2026, 9, 2, 12);
const ts = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** 실제 리드 대화 기록과 같은 모양(키 이름·태그 모양만 맞춘 가짜 값) */
const tag = (id: string, body: string, summary?: string) =>
  `<teammate-message teammate_id="${id}" color="blue"${summary === undefined ? "" : ` summary="${summary}"`}>\n${body}\n</teammate-message>`;
const user = (text: string | string[], msAgo: number) => ({
  type: "user",
  timestamp: ts(msAgo),
  message: { role: "user", content: Array.isArray(text) ? text.map((t) => ({ type: "text", text: t })) : text },
});
const send = (to: string, msAgo: number) => ({
  type: "assistant",
  timestamp: ts(msAgo),
  message: { role: "assistant", content: [{ type: "tool_use", id: "tu", name: "SendMessage", input: { to, message: "fake", summary: "fake" } }] },
});

describe("parseTeamRequests", () => {
  it("summary가 [결정 필요]로 시작하면 감지한다", () => {
    expect(parseTeamRequests([user(tag("quill", "본문입니다", "[결정 필요] 포트 선택"), 60_000)], NOW)).toEqual([{ from: "quill", at: NOW - 60_000, summary: "[결정 필요] 포트 선택" }]);
  });

  it("본문 첫 줄이 [결정 필요]로 시작하면 감지한다", () => {
    const r = parseTeamRequests([user(tag("quill", "   [결정 필요] A와 B 중 무엇을 쓸까요?\n자세한 내용", "진행 보고"), 1000)], NOW);
    expect(r).toEqual([{ from: "quill", at: NOW - 1000, summary: "진행 보고" }]);
    // summary가 없으면 본문 첫 줄을 요약으로 쓴다
    expect(parseTeamRequests([user(tag("ember", "[결정 필요] 첫 줄\n둘째 줄"), 1000)], NOW)[0].summary).toBe("[결정 필요] 첫 줄");
  });

  it("본문 중간의 [결정 필요]는 감지하지 않는다", () => {
    expect(parseTeamRequests([user(tag("quill", "보고합니다\n[결정 필요] 아님", "보고"), 1000)], NOW)).toEqual([]);
    expect(parseTeamRequests([user(tag("quill", "본문", "요약 [결정 필요]"), 1000)], NOW)).toEqual([]);
  });

  it("team-lead가 보낸 것은 건너뛴다", () => {
    expect(parseTeamRequests([user(tag("team-lead", "x", "[결정 필요] y"), 1000)], NOW)).toEqual([]);
  });

  it("리드가 그 팀원에게 메시지를 보낸 뒤면 뺀다", () => {
    expect(parseTeamRequests([user(tag("quill", "b", "[결정 필요] s"), 5000), send("quill", 4000)], NOW)).toEqual([]);
  });

  it("다른 팀원에게 보낸 메시지로는 빼지 않는다", () => {
    expect(parseTeamRequests([user(tag("quill", "b", "[결정 필요] s"), 5000), send("ember", 4000)], NOW)).toHaveLength(1);
  });

  it("요청보다 앞선 메시지로는 빼지 않는다", () => {
    expect(parseTeamRequests([send("quill", 6000), user(tag("quill", "b", "[결정 필요] s"), 5000)], NOW)).toHaveLength(1);
  });

  it("30분이 지나면 뺀다(경계: 정확히 30분은 남긴다)", () => {
    expect(parseTeamRequests([user(tag("quill", "b", "[결정 필요] s"), TEAM_REQUEST_TTL)], NOW)).toHaveLength(1);
    expect(parseTeamRequests([user(tag("quill", "b", "[결정 필요] s"), TEAM_REQUEST_TTL + 1)], NOW)).toEqual([]);
  });

  it("같은 팀원의 요청이 여럿이면 가장 최근 하나", () => {
    const r = parseTeamRequests([user(tag("quill", "b", "[결정 필요] 첫째"), 5000), user(tag("quill", "b", "[결정 필요] 둘째"), 3000)], NOW);
    expect(r).toEqual([{ from: "quill", at: NOW - 3000, summary: "[결정 필요] 둘째" }]);
  });

  it("요약은 가린 뒤 200자까지", () => {
    const [r] = parseTeamRequests([user(tag("quill", "b", `[결정 필요] token=FAKE12345 ${"가".repeat(300)}`), 1000)], NOW);
    expect(r.summary).not.toContain("FAKE12345");
    expect([...r.summary].length).toBe(200);
  });

  it("속성의 HTML 엔티티를 푼다", () => {
    expect(parseTeamRequests([user(tag("quill", "b", "[결정 필요] &quot;A&quot; &amp; B"), 1000)], NOW)[0].summary).toBe('[결정 필요] "A" & B');
  });

  it("한 항목에 teammate-message가 여러 개여도 모두 본다", () => {
    const text = tag("quill", "b", "[결정 필요] q") + "\n\n" + tag("ember", "[결정 필요] e") + "\n" + tag("lynx", "그냥 보고", "보고");
    expect(parseTeamRequests([user(text, 1000)], NOW).map((r) => r.from).sort()).toEqual(["ember", "quill"]);
    // content가 text 배열인 모양도 본다
    expect(parseTeamRequests([user(["앞", tag("quill", "b", "[결정 필요] q")], 1000)], NOW)).toHaveLength(1);
  });

  it("깨진 줄과 모르는 모양은 건너뛴다", () => {
    const entries = [
      null, "x", 5, { type: "user" }, { type: "user", timestamp: "not-a-date", message: { content: tag("q", "b", "[결정 필요] s") } },
      { type: "user", timestamp: ts(1), message: { content: [null, { type: "image" }] } },
      { type: "assistant", timestamp: ts(1), message: { content: [{ type: "tool_use", name: "SendMessage" }] } },
      { type: "user", timestamp: ts(1), message: { content: '<teammate-message teammate_id="open">[결정 필요] 닫는 태그 없음' } },
      user(tag("quill", "b", "[결정 필요] ok"), 1000),
    ];
    expect(() => parseTeamRequests(entries, NOW)).not.toThrow();
    expect(parseTeamRequests(entries, NOW).map((r) => r.from)).toEqual(["quill"]);
  });
});

describe("readTeamRequests", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "co-team-"));
    io.bytes = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("256KB보다 큰 파일도 끝부분만 읽는다", async () => {
    const file = join(dir, "lead.jsonl");
    const filler = JSON.stringify({ type: "assistant", timestamp: ts(10_000), message: { content: [{ type: "text", text: "x".repeat(1000) }] } });
    const lines: string[] = [];
    // 앞부분의 요청은 끝 256KB 밖이라 보이지 않는다
    lines.push(JSON.stringify(user(tag("early", "b", "[결정 필요] 앞"), 9000)));
    while (lines.join("\n").length < 2 * 1024 * 1024) lines.push(filler);
    lines.push(JSON.stringify(user(tag("quill", "b", "[결정 필요] 끝"), 1000)));
    writeFileSync(file, lines.join("\n") + "\n");
    const r = await readTeamRequests(file, NOW);
    expect(r.map((x) => x.from)).toEqual(["quill"]);
    expect(io.bytes).toBeGreaterThan(0);
    expect(io.bytes).toBeLessThanOrEqual(TAIL_BYTES);
  });

  it("작은 파일은 전부 읽고, 없는 파일은 던진다", async () => {
    const file = join(dir, "small.jsonl");
    writeFileSync(file, [user(tag("quill", "b", "[결정 필요] s"), 1000), send("ember", 500)].map((e) => JSON.stringify(e)).join("\n"));
    expect(await readTeamRequests(file, NOW)).toHaveLength(1);
    await expect(readTeamRequests(join(dir, "nope.jsonl"), NOW)).rejects.toThrow();
  });
});
