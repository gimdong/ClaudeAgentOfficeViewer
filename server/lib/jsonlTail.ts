import { open, stat } from "node:fs/promises";

export interface TailState {
  offset: number;
  /** inode 번호. 제공되면 파일 교체(rename)를 감지해 reset한다. 이전 state에 없으면 검사를 건너뛴다(하위 호환). */
  ino?: number;
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

/**
 * prev 이후에 추가된 완전한 줄만 파싱한다. 개행 전 바이트는 다음 호출로 미룬다(멀티바이트 안전).
 * 파일이 offset 이상 크기를 유지한 채 다른 파일로 교체(rename)되면 크기만으로는 감지할 수 없으므로,
 * inode 변화를 함께 확인해 reset한다.
 */
export async function readNewLines(path: string, prev?: TailState): Promise<TailResult> {
  const st = await stat(path);
  const size = st.size;
  const inoChanged = prev?.ino !== undefined && st.ino !== prev.ino;
  const reset = !prev || inoChanged || size < prev.offset;
  const start = reset ? 0 : prev.offset;
  if (size === start) return { lines: [], reset, state: { offset: start, ino: st.ino } };

  const buf = await readRange(path, start, size);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { lines: [], reset, state: { offset: start, ino: st.ino } };

  const lines: unknown[] = [];
  for (const raw of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return { lines, reset, state: { offset: start + lastNl + 1, ino: st.ino } };
}

/** readLastEntry가 창을 넓혀가며 찾는 절대 상한. 파일 크기와 이 값 중 작은 쪽까지만 뒤진다. */
const MAX_LAST_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * 파일 끝 maxBytes 안에서 마지막으로 파싱되는 JSON 줄을 반환한다.
 * 마지막 줄 자체가 maxBytes보다 길어 창 안에 온전히 들어오지 않으면, 창을 두 배씩 넓혀
 * (파일 크기와 MAX_LAST_ENTRY_BYTES 중 작은 값까지) 다시 시도한다.
 */
export async function readLastEntry(path: string, maxBytes = 65536): Promise<unknown | undefined> {
  const { size } = await stat(path);
  if (size === 0) return undefined;

  const cap = Math.min(size, MAX_LAST_ENTRY_BYTES);
  let window = Math.min(maxBytes, cap);
  for (;;) {
    const start = Math.max(0, size - window);
    const buf = await readRange(path, start, size);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // 잘린 줄이면 이전 줄을 본다
      }
    }
    if (start === 0 || window >= cap) return undefined;
    window = Math.min(window * 2, cap);
  }
}
