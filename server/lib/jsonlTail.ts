import { open, stat } from "node:fs/promises";

export interface TailState {
  offset: number;
}

export interface TailResult {
  lines: unknown[];
  reset: boolean;
  state: TailState;
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(end - start);
    await fh.read(buf, 0, buf.length, start);
    return buf;
  } finally {
    await fh.close();
  }
}

/** prev 이후에 추가된 완전한 줄만 파싱한다. 개행 전 바이트는 다음 호출로 미룬다(멀티바이트 안전). */
export async function readNewLines(path: string, prev?: TailState): Promise<TailResult> {
  const { size } = await stat(path);
  const reset = !prev || size < prev.offset;
  const start = reset ? 0 : prev.offset;
  if (size === start) return { lines: [], reset, state: { offset: start } };

  const buf = await readRange(path, start, size);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { lines: [], reset, state: { offset: start } };

  const lines: unknown[] = [];
  for (const raw of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return { lines, reset, state: { offset: start + lastNl + 1 } };
}

/** 파일 끝 maxBytes 안에서 마지막으로 파싱되는 JSON 줄을 반환한다. */
export async function readLastEntry(path: string, maxBytes = 65536): Promise<unknown | undefined> {
  const { size } = await stat(path);
  if (size === 0) return undefined;
  const buf = await readRange(path, Math.max(0, size - maxBytes), size);
  const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // 잘린 줄이면 이전 줄을 본다
    }
  }
  return undefined;
}
