import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, writeFile } from "node:fs/promises";
import { readLastEntry, readNewLines } from "../../server/lib/jsonlTail";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let h: FakeHome;
beforeEach(async () => { h = await makeHome(); });
afterEach(() => h.cleanup());

describe("readNewLines", () => {
  it("처음 읽으면 reset=true이고 모든 완전한 줄을 파싱한다", async () => {
    await h.append("a.jsonl", [{ n: 1 }, { n: 2 }]);
    const r = await readNewLines(h.path("a.jsonl"));
    expect(r.reset).toBe(true);
    expect(r.lines).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("다음 호출에서는 새로 추가된 줄만 읽는다", async () => {
    await h.append("a.jsonl", [{ n: 1 }]);
    const first = await readNewLines(h.path("a.jsonl"));
    await h.append("a.jsonl", [{ n: 2 }]);
    const second = await readNewLines(h.path("a.jsonl"), first.state);
    expect(second.reset).toBe(false);
    expect(second.lines).toEqual([{ n: 2 }]);
  });

  it("깨진 줄은 건너뛴다", async () => {
    await h.append("a.jsonl", ["{not json", { n: 1 }]);
    expect((await readNewLines(h.path("a.jsonl"))).lines).toEqual([{ n: 1 }]);
  });

  it("개행으로 끝나지 않은 마지막 줄은 다음 호출로 미룬다", async () => {
    await writeFile(h.path("a.jsonl"), '{"n":1}\n{"n":');
    const first = await readNewLines(h.path("a.jsonl"));
    expect(first.lines).toEqual([{ n: 1 }]);
    await appendFile(h.path("a.jsonl"), "2}\n");
    expect((await readNewLines(h.path("a.jsonl"), first.state)).lines).toEqual([{ n: 2 }]);
  });

  it("멀티바이트 문자가 잘린 채 끝나도 다음 호출에서 온전히 파싱한다", async () => {
    const full = Buffer.from(JSON.stringify({ text: "안녕하세요 감독관" }) + "\n", "utf8");
    const cut = full.indexOf(Buffer.from("세", "utf8")) + 1; // '세'의 첫 바이트만 쓴다
    await writeFile(h.path("k.jsonl"), full.subarray(0, cut));
    const first = await readNewLines(h.path("k.jsonl"));
    expect(first.lines).toEqual([]);
    await appendFile(h.path("k.jsonl"), full.subarray(cut));
    expect((await readNewLines(h.path("k.jsonl"), first.state)).lines).toEqual([{ text: "안녕하세요 감독관" }]);
  });

  it("파일이 줄어들면 reset=true로 처음부터 다시 읽는다", async () => {
    await h.append("a.jsonl", [{ n: 1 }, { n: 2 }, { n: 3 }]);
    const first = await readNewLines(h.path("a.jsonl"));
    await writeFile(h.path("a.jsonl"), '{"n":9}\n');
    const second = await readNewLines(h.path("a.jsonl"), first.state);
    expect(second.reset).toBe(true);
    expect(second.lines).toEqual([{ n: 9 }]);
  });
});

describe("readLastEntry", () => {
  it("마지막 완전한 JSON 줄을 반환한다", async () => {
    await writeFile(h.path("a.jsonl"), '{"n":1}\n{"n":2}\n{"broken');
    expect(await readLastEntry(h.path("a.jsonl"))).toEqual({ n: 2 });
  });

  it("빈 파일이면 undefined", async () => {
    await writeFile(h.path("e.jsonl"), "");
    expect(await readLastEntry(h.path("e.jsonl"))).toBeUndefined();
  });
});
