# Claude Agent Office Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `~/.claude` 로컬 데이터를 읽어 토큰 사용량·잔여량, 실행 중인 세션, agent team 팀원 상태를 네온 도트 사무실로 보여주는 로컬 웹 대시보드를 만든다.

**Architecture:**
- **서버:** Express 서버(`server/`)가 수집기(collector)들로 `~/.claude` 파일을 읽기 전용으로 파싱해 `Snapshot`을 만든다. `SnapshotHub`가 `fs.watch`와 3초 주기로 다시 만들어, 내용이 바뀌었을 때만 SSE로 보낸다.
- **클라이언트:** React 앱(`web/`)이 SSE를 구독해 상단 HUD와 사무실 타일을 그린다. 도트 캐릭터는 문자열 픽셀 맵을 SVG `rect`로 렌더링한다.
- **공유 타입:** 서버와 클라이언트가 `src/shared/`를 함께 쓴다.

**Tech Stack:** Node 24 (ESM), TypeScript, Express 5, React 19, Vite, Vitest, jsdom, @testing-library/react, tsx, concurrently

**Spec:** `docs/superpowers/specs/2026-09-28-claude-office-design.md`

## Global Constraints

- Node ≥ 24 (개발 환경 v24.8.0). `package.json`에 `"type": "module"`.
- 서버는 `127.0.0.1`에만 바인딩한다. 기본 포트 `4317`, `--port`로 변경.
- Claude 데이터 폴더: `--claude-home` > `CLAUDE_HOME` 환경변수 > `~/.claude`.
- 서버는 claude home 아래에 **아무것도 쓰지 않는다**. 쓰기는 사용자가 직접 실행하는 `npm run setup:statusline` / `remove:statusline`만 한다.
- 사용 토큰 `total = input + output + cacheWrite`. `cacheRead`는 따로 표시하고 합계에서 제외.
- 중복 제거 키: `requestId` → 없으면 `message.id` → 없으면 `파일경로:uuid`. 같은 키면 total이 더 큰 쪽을 남긴다.
- 구간: `last5h` = 지금부터 5시간 이내, `last7d` = 7일 이내(rolling). `today` = 로컬 자정부터. UI에 5H·WEEK 옆 "추정" 표시.
- 컨텍스트 창 기본값 `200000`. 설정에 없는 모델은 `estimated: true`.
- 네온 팔레트: 벽 `#1d1b33`, 바닥 `#2a2446`, 책상 `#3b3460`, 모니터 불빛 `#39ffb6`, 강조 `#ff5fa2` `#3fd0ff` `#b98cff` `#fff7a8`.
- HeartBar 색: 잔여 ≥ 50% 초록(ok), 20% 이상 50% 미만 노랑(warn), 20% 미만 분홍 깜빡임(danger).
- 대체 문구: 예산 없음 `-- 설정 필요`, 한도 데이터 없음 `-- 데이터 없음`.
- 종료된 세션 사무실: `opacity: 0.45`. 최근 24시간 안에 종료된 세션만 표시.
- 이미지 파일을 쓰지 않는다(도트는 모두 코드).
- UI 문구는 한국어.
- 범위 밖: 원격 접속/인증, DB 저장, 비용 환산, 알림, 캐릭터 커스터마이징, 대시보드에서의 조작.
- 테스트 fixture: 스펙은 `test/fixtures/claude-home/`을 언급하지만, 5시간·7일 구간이 "지금" 기준이라 고정 파일로는 시간이 지나면 깨진다. 그래서 **테스트 실행 시 임시 폴더에 생성**한다(`test/helpers/fakeHome.ts`).

## Review Focus

1. **한글(멀티바이트) 문자가 JSONL 추가 쓰기 경계에서 잘릴 때**: 다음 수집에서 그 줄이 온전히 파싱되어야 한다. → Task 2 테스트 `멀티바이트 문자가 잘린 채 끝나도...`
2. **실행 중에 대화 기록 파일이 삭제·교체될 때**: 해당 토큰이 합계에서 빠지고 서버는 계속 동작해야 한다. → Task 3 테스트 `파일이 삭제되면...`, `파일이 교체되면...`
3. **처음 설치한 Mac처럼 `sessions/`, `teams/`, `projects/` 폴더가 아예 없을 때**: 오류 없이 빈 대시보드가 떠야 한다. → Task 8 테스트 `빈 claude home이면...`
4. **받은편지함이나 meta 파일이 깨졌거나 배열이 아닐 때**: 안 읽은 메시지 0으로 보고 팀원은 계속 표시해야 한다. → Task 6 테스트 `깨진 inbox와 meta는...`
5. **브라우저 탭을 닫아 SSE 연결이 끊길 때**: 구독이 해제되어 닫힌 소켓에 쓰지 않아야 한다. → Task 9 테스트 `클라이언트가 끊으면 구독이 해제된다`

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, index.html, .gitignore
claude-office.config.example.json          예산·컨텍스트 창 설정 예시
README.md
src/shared/types.ts                        Snapshot 등 공유 타입
src/shared/tokens.ts                       TokenSum 계산
server/lib/jsonlTail.ts                    증분 JSONL 읽기, 마지막 항목 읽기
server/collectors/usage.ts                 토큰 집계 (UsageCollector)
server/collectors/sessions.ts              sessions/<pid>.json
server/collectors/teams.ts                 teams/ config·inbox, 팀원 기록 찾기, memberState
server/collectors/context.ts               컨텍스트 사용률
server/collectors/limits.ts                statusline tap 결과 읽기
server/config.ts                           claude-office.config.json 로딩
server/snapshot.ts                         SnapshotBuilder (수집기 조합, 격리)
server/hub.ts                              SnapshotHub (감시·주기·변경 감지·구독)
server/app.ts                              Express 라우트 (/api/snapshot, /api/stream, 정적 파일)
server/index.ts                            CLI 진입점
scripts/statusline-tap.sh                  statusline JSON 사본 저장 + 원래 명령 실행
scripts/statusline-setup.mjs               install/remove
web/main.tsx, web/App.tsx, web/styles.css
web/useSnapshot.ts                         SSE 구독 훅
web/format.ts                              숫자·상태 문구
web/pixel/palette.ts, sprites.ts, PixelSprite.tsx
web/hud/Hud.tsx, HeartBar.tsx, TokenCounter.tsx
web/office/OfficeGrid.tsx, OfficeTile.tsx, Desk.tsx, StatusBubble.tsx
test/helpers/fakeHome.ts
test/shared/*.test.ts, test/server/*.test.ts, test/web/*.test.tsx, test/scripts/*.test.ts
```

---

### Task 1: 프로젝트 뼈대와 공유 토큰 계산

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`, `src/shared/types.ts`, `src/shared/tokens.ts`
- Test: `test/shared/tokens.test.ts`

**Interfaces:**
- Produces: `src/shared/types.ts`의 `MemberState`, `TokenSum`, `Member`, `ContextInfo`, `SessionView`, `Limits`, `UsageSummary`, `Snapshot`
- Produces: `emptySum(): TokenSum`, `usageToSum(u: unknown): TokenSum`, `addSum(a: TokenSum, b: TokenSum): TokenSum`

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "claude-agent-office-viewer",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "concurrently -k -n api,web \"tsx watch server/index.ts\" \"vite\"",
    "build": "vite build",
    "start": "tsx server/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "setup:statusline": "node scripts/statusline-setup.mjs install",
    "remove:statusline": "node scripts/statusline-setup.mjs remove"
  }
}
```

- [ ] **Step 2: 의존성 설치**

Run:
```bash
npm install express react react-dom
npm install -D typescript tsx vite @vitejs/plugin-react vitest jsdom @testing-library/react @types/express @types/react @types/react-dom @types/node concurrently
```
Expected: `node_modules/` 생성, `package-lock.json` 생성, 오류 없음.

- [ ] **Step 3: 설정 파일 작성**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["src", "server", "web", "test", "vite.config.ts"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4317" } },
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node", testTimeout: 20000 },
});
```

`index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Claude Agent Office</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/web/main.tsx"></script>
  </body>
</html>
```

`.gitignore`:
```
node_modules/
dist/
claude-office.config.json
.superpowers/
```

- [ ] **Step 4: 공유 타입 작성** — `src/shared/types.ts`

```ts
export type MemberState = "working" | "idle" | "mail" | "offline";

export interface TokenSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number; // input + output + cacheWrite (cacheRead 제외)
}

export interface Member {
  name: string;
  role: string;
  model?: string;
  color?: string;
  state: MemberState;
  unread: number;
  tokens: TokenSum;
  lastActivityAt?: string;
}

export interface ContextInfo {
  used: number;
  window: number;
  pct: number;
  estimated: boolean;
}

export interface SessionView {
  id: string;
  name: string;
  cwd: string;
  alive: boolean;
  isCurrent: boolean;
  status: MemberState;
  stale?: boolean;
  context: ContextInfo | null;
  members: Member[];
}

export interface Limits {
  fiveHourPct?: number;
  weeklyPct?: number;
  resetsAt?: string;
  source: string;
}

export interface UsageSummary {
  today: TokenSum;
  last5h: TokenSum;
  last7d: TokenSum;
  byModel: Array<{ model: string } & TokenSum>;
  hourly: number[]; // 길이 24, 마지막 칸이 현재 시간대
}

export interface Snapshot {
  generatedAt: string;
  error?: string;
  usage: UsageSummary;
  budget: { fiveHour?: number; weekly?: number };
  limits: Limits | null;
  sessions: SessionView[];
}
```

- [ ] **Step 5: 실패하는 테스트 작성** — `test/shared/tokens.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { addSum, emptySum, usageToSum } from "../../src/shared/tokens";

describe("tokens", () => {
  it("usage 객체를 TokenSum으로 바꾸고 total에서 cacheRead를 뺀다", () => {
    expect(
      usageToSum({ input_tokens: 2, output_tokens: 420, cache_read_input_tokens: 9000, cache_creation_input_tokens: 39359 }),
    ).toEqual({ input: 2, output: 420, cacheRead: 9000, cacheWrite: 39359, total: 39781 });
  });

  it("없거나 잘못된 값은 0으로 본다", () => {
    expect(usageToSum(undefined)).toEqual(emptySum());
    expect(usageToSum({ input_tokens: -5, output_tokens: "7", cache_read_input_tokens: NaN })).toEqual(emptySum());
  });

  it("addSum은 항목별로 더한다", () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 7 };
    expect(addSum(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 14 });
  });
});
```

- [ ] **Step 6: 실패 확인**

Run: `npx vitest run test/shared/tokens.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/shared/tokens"`

- [ ] **Step 7: 구현** — `src/shared/tokens.ts`

```ts
import type { TokenSum } from "./types";

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function emptySum(): TokenSum {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function usageToSum(u: unknown): TokenSum {
  const o = (u ?? {}) as Record<string, unknown>;
  const input = n(o.input_tokens);
  const output = n(o.output_tokens);
  const cacheRead = n(o.cache_read_input_tokens);
  const cacheWrite = n(o.cache_creation_input_tokens);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheWrite };
}

export function addSum(a: TokenSum, b: TokenSum): TokenSum {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}
```

- [ ] **Step 8: 통과 확인**

Run: `npx vitest run test/shared/tokens.test.ts && npx tsc --noEmit`
Expected: 3 passed, tsc 오류 없음

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts index.html .gitignore src test/shared
git commit -m "chore: scaffold project and shared token math"
```

---

### Task 2: 증분 JSONL 리더와 테스트 헬퍼

**Files:**
- Create: `server/lib/jsonlTail.ts`, `test/helpers/fakeHome.ts`
- Test: `test/server/jsonlTail.test.ts`

**Interfaces:**
- Produces: `interface TailState { offset: number }`
- Produces: `readNewLines(path: string, prev?: TailState): Promise<{ lines: unknown[]; reset: boolean; state: TailState }>`
  - `reset`은 처음 읽거나 파일이 줄어들어 처음부터 다시 읽을 때 `true`
- Produces: `readLastEntry(path: string, maxBytes?: number): Promise<unknown | undefined>`
- Produces (테스트용): `makeHome(): Promise<FakeHome>`, `assistant(o): object`

- [ ] **Step 1: 테스트 헬퍼 작성** — `test/helpers/fakeHome.ts`

```ts
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FakeHome {
  home: string;
  path(rel: string): string;
  write(rel: string, data: unknown): Promise<void>;
  append(rel: string, lines: unknown[]): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeHome(): Promise<FakeHome> {
  const home = await mkdtemp(join(tmpdir(), "claude-office-"));
  const path = (rel: string) => join(home, rel);
  const ensure = (rel: string) => mkdir(dirname(path(rel)), { recursive: true });
  return {
    home,
    path,
    async write(rel, data) {
      await ensure(rel);
      await writeFile(path(rel), typeof data === "string" ? data : JSON.stringify(data));
    },
    async append(rel, lines) {
      await ensure(rel);
      await appendFile(path(rel), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

export function assistant(o: {
  requestId?: string;
  ts: number;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  content?: unknown[];
}) {
  return {
    type: "assistant",
    requestId: o.requestId,
    timestamp: new Date(o.ts).toISOString(),
    message: {
      role: "assistant",
      model: o.model ?? "claude-opus-5-5",
      content: o.content ?? [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
        cache_creation_input_tokens: o.cacheWrite ?? 0,
      },
    },
  };
}
```

- [ ] **Step 2: 실패하는 테스트 작성** — `test/server/jsonlTail.test.ts`

```ts
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
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run test/server/jsonlTail.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/lib/jsonlTail"`

- [ ] **Step 4: 구현** — `server/lib/jsonlTail.ts`

```ts
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
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run test/server/jsonlTail.test.ts`
Expected: 8 passed

- [ ] **Step 6: Commit**

```bash
git add server/lib test/helpers test/server/jsonlTail.test.ts
git commit -m "feat(server): add incremental JSONL reader"
```

---

### Task 3: 토큰 사용량 수집기

**Files:**
- Create: `server/collectors/usage.ts`
- Test: `test/server/usage.test.ts`

**Interfaces:**
- Consumes: `readNewLines`, `TailState` (Task 2), `emptySum`, `addSum`, `usageToSum` (Task 1)
- Produces:
```ts
interface LastUsage { ts: number; model: string; sum: TokenSum }
class UsageCollector {
  constructor(projectsDir: string);
  refresh(): Promise<void>;                     // projectsDir 아래 모든 *.jsonl 증분 수집
  summary(now?: number): UsageSummary;
  fileTotal(file: string): TokenSum;            // 파일(절대경로)에 속한 레코드 합계
  lastUsage(file: string): LastUsage | undefined;
  mtime(file: string): number | undefined;      // 마지막 refresh 때의 mtimeMs
  findFile(pred: (path: string) => boolean): string | undefined;
}
```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/server/usage.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { UsageCollector } from "../../server/collectors/usage";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";

const HOUR = 3_600_000;
const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime(); // 로컬 시간 15:00
const F = "projects/-p/s1.jsonl";

let h: FakeHome;
let c: UsageCollector;
beforeEach(async () => {
  h = await makeHome();
  c = new UsageCollector(h.path("projects"));
});
afterEach(() => h.cleanup());

describe("UsageCollector", () => {
  it("같은 requestId는 한 번만 세고 total이 더 큰 줄을 남긴다", async () => {
    await h.append(F, [
      assistant({ requestId: "r1", ts: NOW - HOUR, input: 10, output: 5 }),
      assistant({ requestId: "r1", ts: NOW - HOUR, input: 10, output: 50 }),
      assistant({ requestId: "r2", ts: NOW - HOUR, input: 1, output: 1, cacheWrite: 3, cacheRead: 100 }),
    ]);
    await c.refresh();
    expect(c.summary(NOW).last5h).toEqual({ input: 11, output: 51, cacheRead: 100, cacheWrite: 3, total: 65 });
  });

  it("5시간·7일 경계를 지킨다", async () => {
    await h.append(F, [
      assistant({ requestId: "in5h", ts: NOW - 5 * HOUR + 60_000, output: 1 }),
      assistant({ requestId: "out5h", ts: NOW - 5 * HOUR - 60_000, output: 10 }),
      assistant({ requestId: "out7d", ts: NOW - 168 * HOUR - 60_000, output: 100 }),
    ]);
    await c.refresh();
    const s = c.summary(NOW);
    expect(s.last5h.total).toBe(1);
    expect(s.last7d.total).toBe(11);
  });

  it("today는 로컬 자정부터 센다", async () => {
    const midnight = new Date(2026, 8, 28, 0, 0, 0).getTime();
    await h.append(F, [
      assistant({ requestId: "before", ts: midnight - 60_000, output: 7 }),
      assistant({ requestId: "after", ts: midnight + 60_000, output: 3 }),
    ]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(3);
  });

  it("깨진 줄, 잘못된 timestamp, <synthetic> 모델, assistant가 아닌 줄은 건너뛴다", async () => {
    await h.append(F, [
      "{not json",
      { ...assistant({ requestId: "bad-ts", ts: NOW, output: 9 }), timestamp: "nope" },
      assistant({ requestId: "syn", ts: NOW - 1000, model: "<synthetic>", output: 9 }),
      { type: "user", message: { usage: { output_tokens: 9 } }, timestamp: new Date(NOW).toISOString() },
      assistant({ requestId: "ok", ts: NOW - 1000, output: 2 }),
    ]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(2);
  });

  it("추가된 줄만 읽어 중복으로 세지 않는다", async () => {
    await h.append(F, [assistant({ requestId: "a", ts: NOW - 1000, output: 1 })]);
    await c.refresh();
    await h.append(F, [assistant({ requestId: "b", ts: NOW - 500, output: 2 })]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(3);
  });

  it("파일이 삭제되면 합계에서 빠진다", async () => {
    await h.append(F, [assistant({ requestId: "a", ts: NOW - 1000, output: 5 })]);
    await c.refresh();
    await rm(h.path(F));
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(0);
    expect(c.findFile(() => true)).toBeUndefined();
  });

  it("파일이 교체(크기 감소)되면 처음부터 다시 읽는다", async () => {
    await h.append(F, [
      assistant({ requestId: "old1", ts: NOW - 1000, output: 50 }),
      assistant({ requestId: "old2", ts: NOW - 1000, output: 50 }),
    ]);
    await c.refresh();
    await writeFile(h.path(F), JSON.stringify(assistant({ requestId: "new", ts: NOW - 1000, output: 4 })) + "\n");
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(4);
  });

  it("hourly는 마지막 칸이 현재 시간대다", async () => {
    await h.append(F, [
      assistant({ requestId: "a", ts: NOW - 10 * 60_000, output: 1 }),
      assistant({ requestId: "b", ts: NOW - 2.5 * HOUR, output: 2 }),
    ]);
    await c.refresh();
    const { hourly } = c.summary(NOW);
    expect(hourly).toHaveLength(24);
    expect(hourly[23]).toBe(1);
    expect(hourly[21]).toBe(2);
  });

  it("byModel, fileTotal, lastUsage, mtime, findFile", async () => {
    await h.append(F, [
      assistant({ requestId: "a", ts: NOW - 2000, model: "claude-opus-5-5", input: 5, output: 1 }),
      assistant({ requestId: "b", ts: NOW - 1000, model: "claude-sonnet-5", input: 7, cacheRead: 3, output: 2 }),
    ]);
    await h.append("projects/-p/s1/subagents/agent-x.jsonl", [assistant({ requestId: "c", ts: NOW - 500, output: 4 })]);
    await c.refresh();
    const file = c.findFile((p) => p.endsWith("/s1.jsonl"))!;
    expect(file).toBe(h.path(F));
    expect(c.fileTotal(file).total).toBe(15);
    expect(c.lastUsage(file)).toMatchObject({ model: "claude-sonnet-5", sum: { input: 7, cacheRead: 3 } });
    expect(c.mtime(file)).toBeGreaterThan(0);
    const models = Object.fromEntries(c.summary(NOW).byModel.map((m) => [m.model, m.total]));
    expect(models).toEqual({ "claude-opus-5-5": 10, "claude-sonnet-5": 9 });
  });

  it("projects 폴더가 없으면 빈 결과", async () => {
    await c.refresh();
    expect(c.summary(NOW).last7d.total).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/server/usage.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/collectors/usage"`

- [ ] **Step 3: 구현** — `server/collectors/usage.ts`

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TokenSum, UsageSummary } from "../../src/shared/types";
import { addSum, emptySum, usageToSum } from "../../src/shared/tokens";
import { readNewLines, type TailState } from "../lib/jsonlTail";

export interface LastUsage {
  ts: number;
  model: string;
  sum: TokenSum;
}

interface UsageRecord extends LastUsage {
  key: string;
  file: string;
}

const HOUR = 3_600_000;

export class UsageCollector {
  private tails = new Map<string, TailState>();
  private records = new Map<string, UsageRecord>();
  private fileKeys = new Map<string, Set<string>>();
  private last = new Map<string, LastUsage>();
  private mtimes = new Map<string, number>();

  constructor(private readonly projectsDir: string) {}

  async refresh(): Promise<void> {
    let files: string[] = [];
    try {
      const entries = await readdir(this.projectsDir, { recursive: true });
      files = entries.filter((f) => f.endsWith(".jsonl")).map((f) => join(this.projectsDir, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const seen = new Set(files);
    for (const f of [...this.tails.keys()]) if (!seen.has(f)) this.dropFile(f);
    for (const f of files) {
      try {
        await this.readFile(f);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        this.dropFile(f);
      }
    }
  }

  summary(now = Date.now()): UsageSummary {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    let today = emptySum();
    let last5h = emptySum();
    let last7d = emptySum();
    const byModel = new Map<string, TokenSum>();
    const hourly = new Array<number>(24).fill(0);

    for (const r of this.records.values()) {
      const age = now - r.ts;
      if (r.ts >= midnight.getTime() && age >= 0) today = addSum(today, r.sum);
      if (age < 0) continue;
      if (age < 5 * HOUR) last5h = addSum(last5h, r.sum);
      if (age < 168 * HOUR) {
        last7d = addSum(last7d, r.sum);
        byModel.set(r.model, addSum(byModel.get(r.model) ?? emptySum(), r.sum));
      }
      const bucket = 23 - Math.floor(age / HOUR);
      if (bucket >= 0) hourly[bucket] += r.sum.total;
    }
    return {
      today,
      last5h,
      last7d,
      byModel: [...byModel].map(([model, sum]) => ({ model, ...sum })).sort((a, b) => b.total - a.total),
      hourly,
    };
  }

  fileTotal(file: string): TokenSum {
    let sum = emptySum();
    for (const k of this.fileKeys.get(file) ?? []) {
      const r = this.records.get(k);
      if (r && r.file === file) sum = addSum(sum, r.sum);
    }
    return sum;
  }

  lastUsage(file: string): LastUsage | undefined {
    return this.last.get(file);
  }

  mtime(file: string): number | undefined {
    return this.mtimes.get(file);
  }

  findFile(pred: (path: string) => boolean): string | undefined {
    for (const f of this.tails.keys()) if (pred(f)) return f;
    return undefined;
  }

  private async readFile(file: string): Promise<void> {
    const st = await stat(file);
    const prev = this.tails.get(file);
    const res = await readNewLines(file, prev);
    if (res.reset && prev) this.dropFile(file);
    this.mtimes.set(file, st.mtimeMs);
    this.tails.set(file, res.state);
    for (const line of res.lines) this.ingest(file, line);
  }

  private ingest(file: string, line: unknown): void {
    const l = line as { type?: string; requestId?: string; uuid?: string; timestamp?: string; message?: { id?: string; model?: unknown; usage?: unknown } };
    if (l?.type !== "assistant" || !l.message?.usage) return;
    const ts = Date.parse(l.timestamp ?? "");
    if (!Number.isFinite(ts)) return;
    const model = typeof l.message.model === "string" ? l.message.model : "unknown";
    if (model === "<synthetic>") return;
    const sum = usageToSum(l.message.usage);
    const key = l.requestId ?? l.message.id ?? `${file}:${l.uuid}`;

    const prev = this.records.get(key);
    if (!prev || sum.total > prev.sum.total) {
      this.records.set(key, { key, ts, model, sum, file });
      let keys = this.fileKeys.get(file);
      if (!keys) this.fileKeys.set(file, (keys = new Set()));
      keys.add(key);
    }
    const last = this.last.get(file);
    if (!last || ts >= last.ts) this.last.set(file, { ts, model, sum });
  }

  private dropFile(file: string): void {
    for (const k of this.fileKeys.get(file) ?? []) {
      if (this.records.get(k)?.file === file) this.records.delete(k);
    }
    this.fileKeys.delete(file);
    this.tails.delete(file);
    this.last.delete(file);
    this.mtimes.delete(file);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/server/usage.test.ts`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add server/collectors/usage.ts test/server/usage.test.ts
git commit -m "feat(server): add token usage collector with dedup and windows"
```

---

### Task 4: 세션 수집기

**Files:**
- Create: `server/collectors/sessions.ts`
- Test: `test/server/sessions.test.ts`

**Interfaces:**
- Produces:
```ts
interface SessionRecord { pid: number; sessionId: string; name: string; cwd: string; status: string; startedAt: number; updatedAt: number; alive: boolean }
function pidAlive(pid: number): boolean;
function readSessions(claudeHome: string, now?: number, isAlive?: (pid: number) => boolean): Promise<SessionRecord[]>;
```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/server/sessions.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { pidAlive, readSessions } from "../../server/collectors/sessions";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

const NOW = Date.now();
let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

describe("readSessions", () => {
  it("살아 있는 세션과 24시간 안에 끝난 세션만 반환하고, 잘못된 파일은 건너뛴다", async () => {
    await h.write("sessions/1.json", { pid: 1, sessionId: "alive", name: "alpha", cwd: "/a", status: "busy", startedAt: NOW - 5000, updatedAt: NOW - 1000 });
    await h.write("sessions/2.json", { pid: 2, sessionId: "recent", cwd: "/b", status: "idle", updatedAt: NOW - 3_600_000 });
    await h.write("sessions/3.json", { pid: 3, sessionId: "old", status: "idle", updatedAt: NOW - 25 * 3_600_000 });
    await h.write("sessions/4.abc.key", { peerToken: "x" });
    await h.write("sessions/5.json", "{broken");
    await h.write("sessions/6.json", { pid: 6 });

    const list = await readSessions(h.home, NOW, (pid) => pid === 1);
    const byId = Object.fromEntries(list.map((s) => [s.sessionId, s]));
    expect(Object.keys(byId).sort()).toEqual(["alive", "recent"]);
    expect(byId.alive).toMatchObject({ pid: 1, name: "alpha", cwd: "/a", status: "busy", alive: true, updatedAt: NOW - 1000 });
    expect(byId.recent).toMatchObject({ name: "recent", alive: false, status: "idle" });
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("sessions 폴더가 없으면 빈 배열", async () => {
    expect(await readSessions(h.home, NOW, () => true)).toEqual([]);
  });
});

describe("pidAlive", () => {
  it("현재 프로세스는 살아 있고, 끝난 프로세스는 죽었다", () => {
    expect(pidAlive(process.pid)).toBe(true);
    const done = spawnSync("true");
    expect(pidAlive(done.pid!)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/server/sessions.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/collectors/sessions"`

- [ ] **Step 3: 구현** — `server/collectors/sessions.ts`

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionRecord {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  alive: boolean;
}

const DAY = 86_400_000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readSessions(claudeHome: string, now = Date.now(), isAlive = pidAlive): Promise<SessionRecord[]> {
  const dir = join(claudeHome, "sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const out: SessionRecord[] = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(join(dir, n), "utf8"));
    } catch {
      console.warn(`[sessions] ${n}: JSON을 읽을 수 없어 건너뜁니다`);
      continue;
    }
    const pid = num(raw?.pid);
    const sessionId = str(raw?.sessionId);
    if (pid === undefined || !sessionId) {
      console.warn(`[sessions] ${n}: pid 또는 sessionId가 없어 건너뜁니다`);
      continue;
    }
    const alive = isAlive(pid);
    const updatedAt = num(raw.updatedAt) ?? num(raw.startedAt) ?? 0;
    if (!alive && now - updatedAt > DAY) continue;
    out.push({
      pid,
      sessionId,
      name: str(raw.name) ?? sessionId.slice(0, 8),
      cwd: str(raw.cwd) ?? "",
      status: str(raw.status) ?? "idle",
      startedAt: num(raw.startedAt) ?? 0,
      updatedAt,
      alive,
    });
  }
  return out;
}
```

Note: 테스트의 `recent` 세션은 `name`이 없으므로 `sessionId.slice(0, 8)` = `"recent"`이 된다.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/server/sessions.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add server/collectors/sessions.ts test/server/sessions.test.ts
git commit -m "feat(server): add session collector"
```

---

### Task 5: 설정 로딩과 컨텍스트 사용률

**Files:**
- Create: `server/config.ts`, `server/collectors/context.ts`, `claude-office.config.example.json`
- Test: `test/server/config.test.ts`

**Interfaces:**
- Consumes: `LastUsage` (Task 3)
- Produces:
```ts
interface OfficeConfig { budget: { fiveHour?: number; weekly?: number }; contextWindows: Record<string, number> }
const DEFAULT_CONTEXT_WINDOW = 200_000;
function loadConfig(path: string): Promise<OfficeConfig>;
function contextInfo(last: LastUsage | undefined, windows: Record<string, number>): ContextInfo | null;
```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/server/config.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, loadConfig } from "../../server/config";
import { contextInfo } from "../../server/collectors/context";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

describe("loadConfig", () => {
  it("파일이 없으면 기본값", async () => {
    expect(await loadConfig(h.path("none.json"))).toEqual({ budget: {}, contextWindows: {} });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("양수만 받아들인다", async () => {
    await h.write("c.json", { budget: { fiveHour: 500000, weekly: -1 }, contextWindows: { "claude-opus": 1000000, bad: "x" } });
    expect(await loadConfig(h.path("c.json"))).toEqual({ budget: { fiveHour: 500000, weekly: undefined }, contextWindows: { "claude-opus": 1000000 } });
  });

  it("깨진 JSON이면 경고 후 기본값", async () => {
    await h.write("c.json", "{oops");
    expect(await loadConfig(h.path("c.json"))).toEqual({ budget: {}, contextWindows: {} });
    expect(console.warn).toHaveBeenCalledOnce();
  });
});

describe("contextInfo", () => {
  const sum = { input: 1000, output: 500, cacheRead: 40000, cacheWrite: 9000, total: 10500 };

  it("used = input + cacheRead + cacheWrite, 가장 긴 접두어가 맞는 창 크기를 쓴다", () => {
    const info = contextInfo({ ts: 0, model: "claude-opus-5-5", sum }, { claude: 100000, "claude-opus": 1000000 });
    expect(info).toEqual({ used: 50000, window: 1000000, pct: 5, estimated: false });
  });

  it("모르는 모델은 기본 창으로 추정한다", () => {
    const info = contextInfo({ ts: 0, model: "mystery", sum }, {});
    expect(info).toEqual({ used: 50000, window: DEFAULT_CONTEXT_WINDOW, pct: 25, estimated: true });
  });

  it("사용률은 100을 넘지 않고, 기록이 없으면 null", () => {
    const big = { ...sum, cacheRead: 999999 };
    expect(contextInfo({ ts: 0, model: "x", sum: big }, {})!.pct).toBe(100);
    expect(contextInfo(undefined, {})).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/server/config.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/config"`

- [ ] **Step 3: 구현**

`server/config.ts`:
```ts
import { readFile } from "node:fs/promises";

export interface OfficeConfig {
  budget: { fiveHour?: number; weekly?: number };
  contextWindows: Record<string, number>;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;

const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export async function loadConfig(path: string): Promise<OfficeConfig> {
  let raw: { budget?: Record<string, unknown>; contextWindows?: Record<string, unknown> };
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[config] ${path}을 읽지 못해 기본값을 씁니다: ${(e as Error).message}`);
    }
    return { budget: {}, contextWindows: {} };
  }
  const contextWindows: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw?.contextWindows ?? {})) {
    const p = pos(v);
    if (p) contextWindows[k] = p;
  }
  return { budget: { fiveHour: pos(raw?.budget?.fiveHour), weekly: pos(raw?.budget?.weekly) }, contextWindows };
}
```

`server/collectors/context.ts`:
```ts
import type { ContextInfo } from "../../src/shared/types";
import { DEFAULT_CONTEXT_WINDOW } from "../config";
import type { LastUsage } from "./usage";

export function contextInfo(last: LastUsage | undefined, windows: Record<string, number>): ContextInfo | null {
  if (!last) return null;
  const used = last.sum.input + last.sum.cacheRead + last.sum.cacheWrite;
  const key = Object.keys(windows)
    .filter((k) => last.model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const window = key ? windows[key] : DEFAULT_CONTEXT_WINDOW;
  return { used, window, pct: Math.min(100, Math.round((used / window) * 1000) / 10), estimated: !key };
}
```

`claude-office.config.example.json`:
```json
{
  "budget": { "fiveHour": 2000000, "weekly": 20000000 },
  "contextWindows": { "claude-opus-5-5": 1000000, "claude-sonnet-5": 1000000, "claude-haiku-4-5": 200000 }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/server/config.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/collectors/context.ts claude-office.config.example.json test/server/config.test.ts
git commit -m "feat(server): add config loader and context usage"
```

---

### Task 6: 팀 수집기와 팀원 상태 판정

**Files:**
- Create: `server/collectors/teams.ts`
- Test: `test/server/teams.test.ts`

**Interfaces:**
- Produces:
```ts
interface TeamMemberRecord { name: string; agentType: string; model?: string; color?: string; transcript?: string; unread: number }
interface TeamRecord { name: string; leadSessionId: string; members: TeamMemberRecord[] } // team-lead 제외
const ACTIVE_WINDOW_MS = 10_000;
function readTeams(claudeHome: string): Promise<TeamRecord[]>;
function countUnread(inboxPath: string): Promise<number>;
function memberState(i: { sessionAlive: boolean; unread: number; transcriptMtime?: number; lastEntry?: unknown; now: number }): MemberState;
```
- 팀원 기록 찾기: `projects/*/<leadSessionId>/subagents/*.meta.json`의 `name`이 같은 것. 여러 개면 `.jsonl` mtime이 가장 최신인 것.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/server/teams.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { utimes } from "node:fs/promises";
import { ACTIVE_WINDOW_MS, countUnread, memberState, readTeams } from "../../server/collectors/teams";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let h: FakeHome;
beforeEach(async () => { h = await makeHome(); });
afterEach(() => h.cleanup());

const SUB = "projects/-p/s1/subagents";

async function seedTeam() {
  await h.write("teams/t1/config.json", {
    name: "t1",
    leadSessionId: "s1",
    members: [
      { name: "team-lead", agentType: "team-lead" },
      { name: "developer", agentType: "general-purpose", model: "sonnet", color: "green" },
      { name: "reviewer", agentType: "general-purpose", color: "blue" },
    ],
  });
  await h.write("teams/t1/inboxes/developer.json", [{ from: "director", text: "hi", read: false }, { from: "x", read: true }, { from: "y" }]);
  await h.write("teams/t1/inboxes/reviewer.json", "garbage");
  await h.write(`${SUB}/agent-adev-old.meta.json`, { name: "developer" });
  await h.append(`${SUB}/agent-adev-old.jsonl`, [{ n: 1 }]);
  await utimes(h.path(`${SUB}/agent-adev-old.jsonl`), new Date(2020, 0, 1), new Date(2020, 0, 1));
  await h.write(`${SUB}/agent-adev-new.meta.json`, { name: "developer" });
  await h.append(`${SUB}/agent-adev-new.jsonl`, [{ n: 2 }]);
  await h.write(`${SUB}/agent-bad.meta.json`, "{");
  await h.write("teams/t2/inboxes/x.json", []); // config 없는 팀
}

describe("readTeams", () => {
  it("config가 있는 팀만 읽고, 팀원 기록과 안 읽은 메시지를 붙인다", async () => {
    await seedTeam();
    const teams = await readTeams(h.home);
    expect(teams).toHaveLength(1);
    expect(teams[0]).toEqual({
      name: "t1",
      leadSessionId: "s1",
      members: [
        { name: "developer", agentType: "general-purpose", model: "sonnet", color: "green", transcript: h.path(`${SUB}/agent-adev-new.jsonl`), unread: 2 },
        { name: "reviewer", agentType: "general-purpose", model: undefined, color: "blue", transcript: undefined, unread: 0 },
      ],
    });
  });

  it("teams 폴더가 없으면 빈 배열", async () => {
    expect(await readTeams(h.home)).toEqual([]);
  });
});

describe("countUnread", () => {
  it("깨진 inbox와 meta는 안 읽은 메시지 0으로 보고 팀원은 유지한다", async () => {
    await h.write("i/a.json", "garbage");
    await h.write("i/b.json", { not: "array" });
    await h.write("i/c.json", [null, 3, { read: true }, { read: false }]);
    expect(await countUnread(h.path("i/a.json"))).toBe(0);
    expect(await countUnread(h.path("i/b.json"))).toBe(0);
    expect(await countUnread(h.path("i/missing.json"))).toBe(0);
    expect(await countUnread(h.path("i/c.json"))).toBe(3);
  });
});

describe("memberState", () => {
  const now = 1_000_000;
  const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } };
  const text = { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };

  it.each([
    [{ sessionAlive: false, unread: 3, transcriptMtime: now, lastEntry: toolUse }, "offline"],
    [{ sessionAlive: true, unread: 1, transcriptMtime: now, lastEntry: toolUse }, "mail"],
    [{ sessionAlive: true, unread: 0, transcriptMtime: now - ACTIVE_WINDOW_MS, lastEntry: text }, "working"],
    [{ sessionAlive: true, unread: 0, transcriptMtime: now - ACTIVE_WINDOW_MS - 1, lastEntry: toolUse }, "working"],
    [{ sessionAlive: true, unread: 0, transcriptMtime: now - 60_000, lastEntry: text }, "idle"],
    [{ sessionAlive: true, unread: 0 }, "idle"],
  ])("%o → %s", (input, expected) => {
    expect(memberState({ ...input, now })).toBe(expected);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/server/teams.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/collectors/teams"`

- [ ] **Step 3: 구현** — `server/collectors/teams.ts`

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemberState } from "../../src/shared/types";

export interface TeamMemberRecord {
  name: string;
  agentType: string;
  model?: string;
  color?: string;
  transcript?: string;
  unread: number;
}

export interface TeamRecord {
  name: string;
  leadSessionId: string;
  members: TeamMemberRecord[];
}

export const ACTIVE_WINDOW_MS = 10_000;

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

export async function countUnread(inboxPath: string): Promise<number> {
  try {
    const v: unknown = JSON.parse(await readFile(inboxPath, "utf8"));
    if (!Array.isArray(v)) return 0;
    return v.filter((m) => !(m && typeof m === "object" && (m as { read?: unknown }).read === true)).length;
  } catch {
    return 0;
  }
}

async function findTranscripts(projectsDir: string, sessionId: string): Promise<Map<string, string>> {
  const best = new Map<string, { path: string; mtime: number }>();
  for (const project of await readdirOrEmpty(projectsDir)) {
    const dir = join(projectsDir, project, sessionId, "subagents");
    for (const n of await readdirOrEmpty(dir)) {
      if (!n.endsWith(".meta.json")) continue;
      let name: string | undefined;
      try {
        name = str(JSON.parse(await readFile(join(dir, n), "utf8"))?.name);
      } catch {
        continue;
      }
      if (!name) continue;
      const path = join(dir, n.replace(/\.meta\.json$/, ".jsonl"));
      try {
        const { mtimeMs } = await stat(path);
        const cur = best.get(name);
        if (!cur || mtimeMs > cur.mtime) best.set(name, { path, mtime: mtimeMs });
      } catch {
        // meta만 있고 기록 파일이 없는 경우
      }
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.path]));
}

export async function readTeams(claudeHome: string): Promise<TeamRecord[]> {
  const teamsDir = join(claudeHome, "teams");
  let names: string[];
  try {
    names = await readdir(teamsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const out: TeamRecord[] = [];
  for (const dirName of names) {
    const teamDir = join(teamsDir, dirName);
    let config: { name?: unknown; leadSessionId?: unknown; members?: unknown };
    try {
      config = JSON.parse(await readFile(join(teamDir, "config.json"), "utf8"));
    } catch {
      continue; // config가 없으면 이 세션은 리드만 있는 1인 사무실이 된다
    }
    const leadSessionId = str(config.leadSessionId);
    if (!leadSessionId) continue;
    const transcripts = await findTranscripts(join(claudeHome, "projects"), leadSessionId);
    const members: TeamMemberRecord[] = [];
    for (const m of Array.isArray(config.members) ? config.members : []) {
      const name = str(m?.name);
      if (!name || name === "team-lead" || m?.agentType === "team-lead") continue;
      members.push({
        name,
        agentType: str(m.agentType) ?? "unknown",
        model: str(m.model),
        color: str(m.color),
        transcript: transcripts.get(name),
        unread: await countUnread(join(teamDir, "inboxes", `${name}.json`)),
      });
    }
    out.push({ name: str(config.name) ?? dirName, leadSessionId, members });
  }
  return out;
}

function hasPendingToolUse(entry: unknown): boolean {
  const e = entry as { type?: string; message?: { content?: unknown } } | undefined;
  const content = e?.type === "assistant" ? e.message?.content : undefined;
  return Array.isArray(content) && content.some((c) => (c as { type?: string } | null)?.type === "tool_use");
}

export function memberState(i: {
  sessionAlive: boolean;
  unread: number;
  transcriptMtime?: number;
  lastEntry?: unknown;
  now: number;
}): MemberState {
  if (!i.sessionAlive) return "offline";
  if (i.unread > 0) return "mail";
  if (i.transcriptMtime !== undefined && i.now - i.transcriptMtime <= ACTIVE_WINDOW_MS) return "working";
  if (hasPendingToolUse(i.lastEntry)) return "working";
  return "idle";
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/server/teams.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add server/collectors/teams.ts test/server/teams.test.ts
git commit -m "feat(server): add team collector and member state rules"
```

---

### Task 7: 요금제 한도 리더

**Files:**
- Create: `server/collectors/limits.ts`
- Test: `test/server/limits.test.ts`

**Interfaces:**
- Produces: `readLimits(claudeHome: string): Promise<Limits | null>`. 입력 파일은 `<claudeHome>/claude-office/limits.json`(Task 14의 tap이 기록).

- [ ] **Step 1: 실제 statusline JSON의 한도 필드 이름 확인**

Run(WebFetch 도구): `https://code.claude.com/docs/en/statusline`에서 statusline 입력 JSON 예시를 찾고, 한도 관련 필드(`rate_limits` 등)의 정확한 경로와 키를 기록한다.
- 문서의 필드명이 아래 구현이 받아들이는 이름(`rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`, `resets_at`)과 다르면, **Step 2 테스트와 Step 4 구현의 키 목록에 문서의 이름을 추가**한다.
- 문서에 한도 필드가 없으면 그대로 진행한다. 이때 이 기능은 tap이 기록한 파일에 해당 필드가 생길 때만 동작하고, 그 전에는 UI에 `-- 데이터 없음`이 표시된다.
- 확인 결과(URL, 필드 경로 또는 "없음")를 리뷰어가 볼 수 있게 커밋 메시지 본문에 한 줄로 남긴다.

- [ ] **Step 2: 실패하는 테스트 작성** — `test/server/limits.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLimits } from "../../server/collectors/limits";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let h: FakeHome;
beforeEach(async () => { h = await makeHome(); });
afterEach(() => h.cleanup());
const P = "claude-office/limits.json";

describe("readLimits", () => {
  it("파일이 없거나 깨졌으면 null", async () => {
    expect(await readLimits(h.home)).toBeNull();
    await h.write(P, "{");
    expect(await readLimits(h.home)).toBeNull();
  });

  it("rate_limits 필드가 없으면 null", async () => {
    await h.write(P, { model: { display_name: "Opus" } });
    expect(await readLimits(h.home)).toBeNull();
  });

  it("snake_case 필드를 읽고 0~100으로 자른다", async () => {
    await h.write(P, { rate_limits: { five_hour: { used_percentage: 42.5, resets_at: "2026-09-28T18:00:00Z" }, seven_day: { used_percentage: 130 } } });
    expect(await readLimits(h.home)).toEqual({ fiveHourPct: 42.5, weeklyPct: 100, resetsAt: "2026-09-28T18:00:00.000Z", source: "statusline" });
  });

  it("camelCase와 epoch 초 단위 resets_at도 받아들인다", async () => {
    await h.write(P, { rateLimits: { fiveHour: { usedPercentage: 10, resetsAt: 1790600000 } } });
    expect(await readLimits(h.home)).toEqual({ fiveHourPct: 10, weeklyPct: undefined, resetsAt: new Date(1790600000 * 1000).toISOString(), source: "statusline" });
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run test/server/limits.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/collectors/limits"`

- [ ] **Step 4: 구현** — `server/collectors/limits.ts`

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Limits } from "../../src/shared/types";

type Obj = Record<string, unknown> | undefined;

const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o && o[k] !== undefined) return o[k];
  return undefined;
};

const pct = (w: Obj): number | undefined => {
  const v = pick(w, "used_percentage", "usedPercentage", "utilization");
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;
};

const iso = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
};

export async function readLimits(claudeHome: string): Promise<Limits | null> {
  let raw: Obj;
  try {
    raw = JSON.parse(await readFile(join(claudeHome, "claude-office", "limits.json"), "utf8"));
  } catch {
    return null;
  }
  const rl = pick(raw, "rate_limits", "rateLimits") as Obj;
  const five = pick(rl, "five_hour", "fiveHour") as Obj;
  const week = pick(rl, "seven_day", "sevenDay", "weekly") as Obj;
  const fiveHourPct = pct(five);
  const weeklyPct = pct(week);
  if (fiveHourPct === undefined && weeklyPct === undefined) return null;
  const resetsAt = iso(pick(five, "resets_at", "resetsAt")) ?? iso(pick(week, "resets_at", "resetsAt"));
  return { fiveHourPct, weeklyPct, resetsAt, source: "statusline" };
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run test/server/limits.test.ts`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add server/collectors/limits.ts test/server/limits.test.ts
git commit -m "feat(server): add plan limits reader

statusline docs check: <Step 1 결과 한 줄>"
```

---

### Task 8: 스냅샷 빌더

**Files:**
- Create: `server/snapshot.ts`
- Test: `test/server/snapshot.test.ts`

**Interfaces:**
- Consumes: `UsageCollector` (Task 3), `readSessions`, `SessionRecord` (Task 4), `OfficeConfig`, `contextInfo` (Task 5), `readTeams`, `memberState`, `TeamRecord` (Task 6), `readLimits` (Task 7), `readLastEntry` (Task 2)
- Produces:
```ts
interface BuilderOptions { claudeHome: string; config: OfficeConfig; isAlive?: (pid: number) => boolean }
class SnapshotBuilder { constructor(opts: BuilderOptions); build(now?: number): Promise<Snapshot> }
```
- 리드 멤버: `name: "team-lead"`, `role: "lead"`, 상태는 세션 `status`(busy → working, 그 외 idle, 죽었으면 offline).
- 정렬: 현재 세션 → 살아 있는 세션 → `updatedAt` 최신순.
- 수집기 하나가 예외를 던지면 직전 결과를 쓰고 모든 세션에 `stale: true`를 붙인다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/server/snapshot.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { SnapshotBuilder } from "../../server/snapshot";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";

const NOW = Date.now();
let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

const config = { budget: { fiveHour: 1000 }, contextWindows: { "claude-opus-5-5": 1_000_000 } };

async function seed() {
  await h.write("sessions/100.json", { pid: 100, sessionId: "s1", name: "alpha", cwd: "/x", status: "busy", updatedAt: NOW - 1000 });
  await h.write("sessions/200.json", { pid: 200, sessionId: "s2", name: "beta", cwd: "/y", status: "idle", updatedAt: NOW - 2 * 3_600_000 });
  await h.append("projects/-p/s1.jsonl", [assistant({ requestId: "r1", ts: NOW - 5000, input: 1000, cacheRead: 9000, output: 50 })]);
  await h.write("teams/t/config.json", {
    name: "t",
    leadSessionId: "s1",
    members: [{ name: "team-lead", agentType: "team-lead" }, { name: "developer", agentType: "general-purpose", model: "sonnet" }, { name: "reviewer", agentType: "general-purpose" }],
  });
  const sub = "projects/-p/s1/subagents";
  await h.write(`${sub}/agent-adev.meta.json`, { name: "developer" });
  await h.append(`${sub}/agent-adev.jsonl`, [
    assistant({ requestId: "d1", ts: NOW - 60_000, output: 7, content: [{ type: "tool_use", name: "Bash" }] }),
  ]);
  const old = new Date(NOW - 60_000);
  await utimes(h.path(`${sub}/agent-adev.jsonl`), old, old);
}

describe("SnapshotBuilder", () => {
  it("세션·팀·토큰·컨텍스트를 합쳐 스냅샷을 만든다", async () => {
    await seed();
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: (pid) => pid === 100 }).build(NOW);

    expect(snap.error).toBeUndefined();
    expect(snap.budget).toEqual({ fiveHour: 1000 });
    expect(snap.limits).toBeNull();
    expect(snap.usage.last5h.total).toBe(1057);
    expect(snap.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);

    const [s1, s2] = snap.sessions;
    expect(s1).toMatchObject({ name: "alpha", alive: true, isCurrent: true, status: "working" });
    expect(s1.stale).toBeUndefined();
    expect(s1.context).toEqual({ used: 10000, window: 1_000_000, pct: 1, estimated: false });
    expect(s1.members.map((m) => [m.name, m.state])).toEqual([["team-lead", "working"], ["developer", "working"], ["reviewer", "idle"]]);
    expect(s1.members[0]).toMatchObject({ role: "lead", model: "claude-opus-5-5", tokens: { total: 1050 } });
    expect(s1.members[1]).toMatchObject({ model: "sonnet", tokens: { total: 7 } });
    expect(s1.members[1].lastActivityAt).toBeDefined();

    expect(s2).toMatchObject({ alive: false, isCurrent: false, status: "offline", context: null });
    expect(s2.members).toHaveLength(1);
    expect(s2.members[0].state).toBe("offline");
  });

  it("빈 claude home이면 오류 없이 빈 대시보드", async () => {
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} } }).build(NOW);
    expect(snap.error).toBeUndefined();
    expect(snap.sessions).toEqual([]);
    expect(snap.usage.today.total).toBe(0);
  });

  it("claude home에 접근할 수 없으면 error를 채운다", async () => {
    const missing = join(h.home, "nope");
    const snap = await new SnapshotBuilder({ claudeHome: missing, config: { budget: {}, contextWindows: {} } }).build(NOW);
    expect(snap.error).toContain(missing);
    expect(snap.sessions).toEqual([]);
    expect(snap.usage.hourly).toHaveLength(24);
  });

  it("수집기가 실패하면 직전 결과를 쓰고 stale을 표시한다", async () => {
    // teams 자리에 파일을 두면 readTeams가 ENOTDIR로 실패한다 → 직전 값(처음엔 빈 배열) 사용
    await h.write("sessions/1.json", { pid: 1, sessionId: "z", updatedAt: NOW });
    await h.write("teams", "not a directory");
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true }).build(NOW);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].stale).toBe(true);
    expect(snap.sessions[0].members.map((m) => m.name)).toEqual(["team-lead"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("teams"));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/server/snapshot.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/snapshot"`

- [ ] **Step 3: 구현** — `server/snapshot.ts`

```ts
import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Member, MemberState, SessionView, Snapshot } from "../src/shared/types";
import { emptySum } from "../src/shared/tokens";
import type { OfficeConfig } from "./config";
import { contextInfo } from "./collectors/context";
import { readLimits } from "./collectors/limits";
import { pidAlive, readSessions, type SessionRecord } from "./collectors/sessions";
import { memberState, readTeams, type TeamRecord } from "./collectors/teams";
import { UsageCollector } from "./collectors/usage";
import { readLastEntry } from "./lib/jsonlTail";

export interface BuilderOptions {
  claudeHome: string;
  config: OfficeConfig;
  isAlive?: (pid: number) => boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

function emptySnapshot(now: number, config: OfficeConfig, error?: string): Snapshot {
  return {
    generatedAt: iso(now),
    ...(error ? { error } : {}),
    usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: new Array(24).fill(0) },
    budget: config.budget,
    limits: null,
    sessions: [],
  };
}

export class SnapshotBuilder {
  private readonly usage: UsageCollector;
  private prevSessions: SessionRecord[] = [];
  private prevTeams: TeamRecord[] = [];

  constructor(private readonly opts: BuilderOptions) {
    this.usage = new UsageCollector(join(opts.claudeHome, "projects"));
  }

  async build(now = Date.now()): Promise<Snapshot> {
    const { claudeHome, config } = this.opts;
    try {
      await access(claudeHome);
    } catch {
      return emptySnapshot(now, config, `Claude 데이터 폴더를 읽을 수 없습니다: ${claudeHome}`);
    }

    let stale = false;
    const guard = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        console.warn(`[snapshot] ${label} 수집 실패, 직전 값을 씁니다: ${(e as Error).message}`);
        stale = true;
        return fallback;
      }
    };

    await guard("usage", () => this.usage.refresh(), undefined);
    const sessions = (this.prevSessions = await guard("sessions", () => readSessions(claudeHome, now, this.opts.isAlive ?? pidAlive), this.prevSessions));
    const teams = (this.prevTeams = await guard("teams", () => readTeams(claudeHome), this.prevTeams));
    const limits = await readLimits(claudeHome).catch(() => null);

    const ordered = [...sessions].sort((a, b) => Number(b.alive) - Number(a.alive) || b.updatedAt - a.updatedAt);
    const currentId = ordered.find((s) => s.alive)?.sessionId;
    const views = await Promise.all(
      ordered.map((s) => this.sessionView(s, teams.find((t) => t.leadSessionId === s.sessionId), now, s.sessionId === currentId, stale)),
    );

    return { ...emptySnapshot(now, config), usage: this.usage.summary(now), limits, sessions: views };
  }

  private async sessionView(s: SessionRecord, team: TeamRecord | undefined, now: number, isCurrent: boolean, stale: boolean): Promise<SessionView> {
    const leadFile = this.usage.findFile((p) => basename(p) === `${s.sessionId}.jsonl`);
    const last = leadFile ? this.usage.lastUsage(leadFile) : undefined;
    const status: MemberState = !s.alive ? "offline" : s.status === "busy" ? "working" : "idle";

    const members: Member[] = [
      {
        name: "team-lead",
        role: "lead",
        model: last?.model,
        state: status,
        unread: 0,
        tokens: leadFile ? this.usage.fileTotal(leadFile) : emptySum(),
        lastActivityAt: s.updatedAt ? iso(s.updatedAt) : undefined,
      },
    ];
    for (const m of team?.members ?? []) {
      const mtime = m.transcript ? this.usage.mtime(m.transcript) : undefined;
      const lastEntry = m.transcript ? await readLastEntry(m.transcript).catch(() => undefined) : undefined;
      members.push({
        name: m.name,
        role: m.name,
        model: m.model,
        color: m.color,
        state: memberState({ sessionAlive: s.alive, unread: m.unread, transcriptMtime: mtime, lastEntry, now }),
        unread: m.unread,
        tokens: m.transcript ? this.usage.fileTotal(m.transcript) : emptySum(),
        lastActivityAt: mtime ? iso(mtime) : undefined,
      });
    }

    return {
      id: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      alive: s.alive,
      isCurrent,
      status,
      ...(stale ? { stale: true } : {}),
      context: contextInfo(last, this.opts.config.contextWindows),
      members,
    };
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/server/snapshot.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add server/snapshot.ts test/server/snapshot.test.ts
git commit -m "feat(server): add snapshot builder combining collectors"
```

---

### Task 9: SnapshotHub, Express 앱, CLI

**Files:**
- Create: `server/hub.ts`, `server/app.ts`, `server/index.ts`
- Test: `test/server/hub.test.ts`, `test/server/app.test.ts`, `test/server/cli.test.ts`

**Interfaces:**
- Consumes: `SnapshotBuilder` (Task 8), `loadConfig` (Task 5)
- Produces:
```ts
class SnapshotHub {
  constructor(builder: { build(now?: number): Promise<Snapshot> }, opts?: { intervalMs?: number; debounceMs?: number; watchDir?: string });
  start(): Promise<void>; stop(): void; refresh(): Promise<void>;
  current(): Snapshot; subscribe(fn: (s: Snapshot) => void): () => void; listenerCount(): number;
}
function createApp(hub: Pick<SnapshotHub, "current" | "subscribe">, opts?: { staticDir?: string; heartbeatMs?: number }): Express;
function parseCliArgs(argv: string[], env?: NodeJS.ProcessEnv): { port: number; claudeHome: string; configPath: string };
```

- [ ] **Step 1: 실패하는 테스트 작성**

`test/server/hub.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotHub } from "../../server/hub";
import { SnapshotBuilder } from "../../server/snapshot";
import type { Snapshot } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";
import { makeHome } from "../helpers/fakeHome";

function snap(tag: string, n: number): Snapshot {
  return {
    generatedAt: String(n),
    usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: [] },
    budget: {},
    limits: null,
    sessions: [{ id: tag, name: tag, cwd: "", alive: true, isCurrent: true, status: "idle", context: null, members: [] }],
  };
}

let hub: SnapshotHub | undefined;
afterEach(() => hub?.stop());

describe("SnapshotHub", () => {
  it("start 후 current를 제공하고, 내용이 바뀔 때만 구독자에게 알린다", async () => {
    let tag = "a";
    let n = 0;
    hub = new SnapshotHub({ build: async () => snap(tag, n++) }, { intervalMs: 60_000 });
    await hub.start();
    expect(hub.current().sessions[0].id).toBe("a");

    const got: string[] = [];
    hub.subscribe((s) => got.push(s.sessions[0].id));
    await hub.refresh(); // generatedAt만 바뀜 → 알리지 않음
    tag = "b";
    await hub.refresh();
    expect(got).toEqual(["b"]);
    expect(hub.current().generatedAt).toBe("2");
  });

  it("실행 중에 들어온 refresh는 한 번으로 합친다", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    hub = new SnapshotHub({
      build: async () => {
        calls++;
        if (calls === 1) await gate;
        return snap("x", calls);
      },
    }, { intervalMs: 60_000 });
    const p1 = hub.refresh();
    const p2 = hub.refresh();
    const p3 = hub.refresh();
    release();
    await Promise.all([p1, p2, p3]);
    expect(calls).toBe(2);
  });

  it("unsubscribe 후에는 listenerCount가 줄어든다", async () => {
    hub = new SnapshotHub({ build: async () => snap("a", 0) }, { intervalMs: 60_000 });
    const off = hub.subscribe(() => {});
    expect(hub.listenerCount()).toBe(1);
    off();
    expect(hub.listenerCount()).toBe(0);
  });

  it("claude home 파일이 바뀌면 5초 안에 알린다 (fs.watch + debounce)", async () => {
    const h = await makeHome();
    try {
      await h.write("sessions/1.json", { pid: process.pid, sessionId: "w1", updatedAt: Date.now() });
      hub = new SnapshotHub(new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} } }), {
        intervalMs: 60_000, // 주기 갱신이 아니라 파일 감시로 알림이 오는지 본다
        debounceMs: 100,
        watchDir: h.home,
      });
      await hub.start();
      const seen = new Promise<Snapshot>((r) => hub!.subscribe(r));
      const t0 = Date.now();
      await h.write("sessions/2.json", { pid: process.pid, sessionId: "w2", updatedAt: Date.now() });
      const s = await seen;
      expect(s.sessions.map((x) => x.id).sort()).toEqual(["w1", "w2"]);
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      hub?.stop();
      await h.cleanup();
    }
  });
});
```

`test/server/app.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../server/app";
import type { Snapshot } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

const base: Snapshot = {
  generatedAt: "t0",
  usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: [] },
  budget: {},
  limits: null,
  sessions: [],
};

let current = base;
const listeners = new Set<(s: Snapshot) => void>();
const hub = {
  current: () => current,
  subscribe: (fn: (s: Snapshot) => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

let server: Server;
let url: string;
let h: FakeHome;

beforeEach(async () => {
  h = await makeHome();
  await h.write("web/index.html", "<!doctype html><title>office</title>");
  current = base;
  listeners.clear();
  server = createApp(hub, { staticDir: h.path("web"), heartbeatMs: 50 }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await h.cleanup();
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const dec = new TextDecoder();
  let acc = "";
  while (!acc.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before "${needle}"`);
    acc += dec.decode(value);
  }
  return acc;
}

describe("createApp", () => {
  it("GET /api/snapshot은 현재 스냅샷을 준다", async () => {
    const res = await fetch(`${url}/api/snapshot`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(base);
  });

  it("SSE: 연결 즉시 스냅샷, 변경 시 추가 이벤트, heartbeat", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    expect(await readUntil(reader, '"t0"')).toContain("event: snapshot");
    current = { ...base, generatedAt: "t1" };
    for (const l of listeners) l(current);
    expect(await readUntil(reader, '"t1"')).toContain("data: ");
    expect(await readUntil(reader, ": ping")).toContain(": ping");
    ctrl.abort();
  });

  it("클라이언트가 끊으면 구독이 해제된다", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/stream`, { signal: ctrl.signal });
    await readUntil(res.body!.getReader(), "event: snapshot");
    expect(listeners.size).toBe(1);
    ctrl.abort();
    const deadline = Date.now() + 2000;
    while (listeners.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(listeners.size).toBe(0);
  });

  it("정적 파일과 SPA fallback, 없는 API는 404", async () => {
    expect(await (await fetch(`${url}/`)).text()).toContain("office");
    expect(await (await fetch(`${url}/some/route`)).text()).toContain("office");
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
  });
});
```

`test/server/cli.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs } from "../../server/index";

describe("parseCliArgs", () => {
  it("옵션 > 환경변수 > 기본값 순서", () => {
    expect(parseCliArgs(["--port", "5000", "--claude-home", "/tmp/x"], {})).toEqual({ port: 5000, claudeHome: "/tmp/x", configPath: resolve("claude-office.config.json") });
    expect(parseCliArgs([], { CLAUDE_HOME: "/env/home" })).toMatchObject({ port: 4317, claudeHome: "/env/home" });
    expect(parseCliArgs([], {})).toMatchObject({ claudeHome: join(homedir(), ".claude") });
  });

  it("잘못된 포트는 오류", () => {
    expect(() => parseCliArgs(["--port", "abc"], {})).toThrow("잘못된 포트");
    expect(() => parseCliArgs(["--port", "70000"], {})).toThrow("잘못된 포트");
  });
});

describe("CLI", () => {
  it("포트가 이미 사용 중이면 안내 후 종료 코드 1", async () => {
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as { port: number }).port;
    const child = spawn(join("node_modules", ".bin", "tsx"), ["server/index.ts", "--port", String(port), "--claude-home", tmpdir()], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    blocker.close();
    expect(code).toBe(1);
    expect(stderr).toContain("이미 사용 중");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/server/hub.test.ts test/server/app.test.ts test/server/cli.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/hub"` (및 app, index)

- [ ] **Step 3: 구현**

`server/hub.ts`:
```ts
import { watch, type FSWatcher } from "node:fs";
import type { Snapshot } from "../src/shared/types";

export interface HubOptions {
  intervalMs?: number;
  debounceMs?: number;
  watchDir?: string;
}

const WATCHED = /^(projects|sessions|teams|claude-office)([\\/]|$)/;

export class SnapshotHub {
  private snapshot: Snapshot | undefined;
  private key = "";
  private listeners = new Set<(s: Snapshot) => void>();
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly builder: { build(now?: number): Promise<Snapshot> },
    private readonly opts: HubOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.intervalMs ?? 3000);
    if (!this.opts.watchDir) return;
    try {
      this.watcher = watch(this.opts.watchDir, { recursive: true }, (_event, file) => {
        if (WATCHED.test(String(file ?? ""))) this.schedule();
      });
      this.watcher.on("error", (e) => console.warn(`[hub] 파일 감시 오류, 주기 갱신은 계속됩니다: ${e.message}`));
    } catch (e) {
      console.warn(`[hub] 파일 감시를 시작하지 못해 주기 갱신만 씁니다: ${(e as Error).message}`);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.watcher?.close();
  }

  current(): Snapshot {
    if (!this.snapshot) throw new Error("SnapshotHub가 아직 시작되지 않았습니다");
    return this.snapshot;
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const s = await this.builder.build();
          const { generatedAt: _ignored, ...rest } = s;
          const key = JSON.stringify(rest);
          this.snapshot = s;
          if (key !== this.key) {
            this.key = key;
            for (const l of this.listeners) l(s);
          }
        } while (this.again);
      } catch (e) {
        console.error("[hub] 스냅샷 생성 실패:", e);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private schedule(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), this.opts.debounceMs ?? 500);
  }
}
```

`server/app.ts`:
```ts
import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../src/shared/types";
import type { SnapshotHub } from "./hub";

export function createApp(
  hub: Pick<SnapshotHub, "current" | "subscribe">,
  opts: { staticDir?: string; heartbeatMs?: number } = {},
): Express {
  const app = express();

  app.get("/api/snapshot", (_req, res) => {
    res.json(hub.current());
  });

  app.get("/api/stream", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (s: Snapshot) => res.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
    send(hub.current());
    const off = hub.subscribe(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), opts.heartbeatMs ?? 15_000);
    req.on("close", () => {
      off();
      clearInterval(heartbeat);
    });
  });

  const staticDir = opts.staticDir;
  if (staticDir && existsSync(join(staticDir, "index.html"))) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method === "GET" && !req.path.startsWith("/api/")) res.sendFile(join(staticDir, "index.html"));
      else next();
    });
  }
  return app;
}
```

`server/index.ts`:
```ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { SnapshotHub } from "./hub";
import { SnapshotBuilder } from "./snapshot";

export interface CliOptions {
  port: number;
  claudeHome: string;
  configPath: string;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, "claude-home": { type: "string" }, config: { type: "string" } },
  });
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`잘못된 포트: ${values.port}`);
  return {
    port,
    claudeHome: resolve(values["claude-home"] ?? env.CLAUDE_HOME ?? join(homedir(), ".claude")),
    configPath: resolve(values.config ?? "claude-office.config.json"),
  };
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const config = await loadConfig(opts.configPath);
  const hub = new SnapshotHub(new SnapshotBuilder({ claudeHome: opts.claudeHome, config }), { watchDir: opts.claudeHome });
  await hub.start();

  const staticDir = fileURLToPath(new URL("../dist/web", import.meta.url));
  const server = createApp(hub, { staticDir }).listen(opts.port, "127.0.0.1", () => {
    console.log(`Claude Agent Office: http://127.0.0.1:${opts.port}  (data: ${opts.claudeHome})`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(`포트 ${opts.port}가 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.`);
    else console.error(e);
    hub.stop();
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/server/hub.test.ts test/server/app.test.ts test/server/cli.test.ts && npx tsc --noEmit`
Expected: 11 passed, tsc 오류 없음

- [ ] **Step 5: Commit**

```bash
git add server/hub.ts server/app.ts server/index.ts test/server/hub.test.ts test/server/app.test.ts test/server/cli.test.ts
git commit -m "feat(server): add snapshot hub, SSE API and CLI"
```

---

### Task 10: 도트 스프라이트 시스템과 SSE 구독 훅

**Files:**
- Create: `web/pixel/palette.ts`, `web/pixel/sprites.ts`, `web/pixel/PixelSprite.tsx`, `web/useSnapshot.ts`, `web/format.ts`
- Test: `test/web/sprites.test.ts`, `test/web/useSnapshot.test.tsx`

**Interfaces:**
- Consumes: `Snapshot`, `MemberState` (Task 1)
- Produces:
```ts
const NEON: { wall; floor; desk; deskDark; monitor; screenOn; screenOff; skin; hair; eye; pants; glasses; ink; pink; cyan; violet; yellow; green: string };
type Role = "lead" | "dev" | "reviewer" | "generic";
function roleOf(name: string): Role;
function shirtColor(role: Role, color?: string): string;
interface Rect { x: number; y: number; c: string }
function characterRows(role: Role, frame: "a" | "b"): string[];   // 8×10
function spriteRects(rows: string[], colors: Record<string, string>): Rect[];
function PixelSprite(props: { rects: Rect[]; x?: number; y?: number; className?: string }): JSX.Element;
function useSnapshot(): { snapshot: Snapshot | null; live: boolean };
function formatTokens(n: number): string;          // 950 → "950", 12345 → "12.3k", 1240000 → "1.24M"
function remainingPct(used: number, budget: number): number; // 0~100
function stateLabel(s: MemberState): string;       // 작업 중 / 대기 / 메시지 수신 / 종료
```

- [ ] **Step 1: 실패하는 테스트 작성**

`test/web/sprites.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { NEON, roleOf, shirtColor } from "../../web/pixel/palette";
import { characterRows, spriteRects } from "../../web/pixel/sprites";
import { formatTokens, remainingPct, stateLabel } from "../../web/format";

describe("palette", () => {
  it.each([
    ["team-lead", "lead"], ["director", "lead"], ["supervisor", "lead"],
    ["developer", "dev"], ["implementer", "dev"],
    ["reviewer", "reviewer"], ["code-reviewer", "reviewer"],
    ["researcher", "generic"],
  ])("roleOf(%s) = %s", (name, role) => {
    expect(roleOf(name)).toBe(role);
  });

  it("역할 셔츠 색이 우선이고, generic은 config color를 쓴다", () => {
    expect(shirtColor("dev", "blue")).toBe(NEON.green);
    expect(shirtColor("generic", "blue")).toBe(NEON.cyan);
    expect(shirtColor("generic", "unknown")).toBe(NEON.yellow);
    expect(shirtColor("generic")).toBe(NEON.yellow);
  });
});

describe("sprites", () => {
  it("모든 프레임은 8×10이다", () => {
    for (const role of ["lead", "dev", "reviewer", "generic"] as const) {
      for (const frame of ["a", "b"] as const) {
        const rows = characterRows(role, frame);
        expect(rows).toHaveLength(10);
        rows.forEach((r) => expect(r).toHaveLength(8));
      }
    }
  });

  it("리뷰어는 안경(g), 리드는 넥타이(t), 타이핑 프레임은 손(s)이 올라간다", () => {
    expect(characterRows("reviewer", "a").join("")).toContain("g");
    expect(characterRows("lead", "a").join("")).toContain("t");
    expect(characterRows("dev", "a")).not.toEqual(characterRows("dev", "b"));
    expect(characterRows("dev", "b")[7]).toMatch(/^s.*s$/);
  });

  it("spriteRects는 팔레트에 있는 문자만 사각형으로 만든다", () => {
    const rects = spriteRects(["a.b", ".a."], { a: "#111", b: "#222" });
    expect(rects).toEqual([{ x: 0, y: 0, c: "#111" }, { x: 2, y: 0, c: "#222" }, { x: 1, y: 1, c: "#111" }]);
  });
});

describe("format", () => {
  it("formatTokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(1_240_000)).toBe("1.24M");
  });

  it("remainingPct는 0~100", () => {
    expect(remainingPct(250, 1000)).toBe(75);
    expect(remainingPct(2000, 1000)).toBe(0);
  });

  it("stateLabel", () => {
    expect(stateLabel("working")).toBe("작업 중");
    expect(stateLabel("idle")).toBe("대기");
    expect(stateLabel("mail")).toBe("메시지 수신");
    expect(stateLabel("offline")).toBe("종료");
  });
});
```

`test/web/useSnapshot.test.tsx`:
```tsx
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSnapshot } from "../../web/useSnapshot";

class FakeEventSource {
  static last: FakeEventSource;
  listeners = new Map<string, (e: MessageEvent) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ generatedAt: "initial" }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSnapshot", () => {
  it("초기 스냅샷을 받고, SSE 이벤트로 갱신하며, 오류 시 live=false", async () => {
    const { result, unmount } = renderHook(() => useSnapshot());
    await waitFor(() => expect(result.current.snapshot?.generatedAt).toBe("initial"));
    expect(FakeEventSource.last.url).toBe("/api/stream");

    act(() => FakeEventSource.last.emit("snapshot", { generatedAt: "sse" }));
    expect(result.current).toEqual({ snapshot: { generatedAt: "sse" }, live: true });

    act(() => FakeEventSource.last.onerror?.());
    expect(result.current.live).toBe(false);

    unmount();
    expect(FakeEventSource.last.closed).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/web/sprites.test.ts test/web/useSnapshot.test.tsx`
Expected: FAIL — `Failed to resolve import "../../web/pixel/palette"`

- [ ] **Step 3: 구현**

`web/pixel/palette.ts`:
```ts
export const NEON = {
  wall: "#1d1b33",
  floor: "#2a2446",
  desk: "#3b3460",
  deskDark: "#241f40",
  monitor: "#0e0d18",
  screenOn: "#39ffb6",
  screenOff: "#2c2a40",
  skin: "#f2c7a5",
  hair: "#2a1a3a",
  eye: "#111111",
  pants: "#241f40",
  glasses: "#3fd0ff",
  ink: "#e8e4ff",
  pink: "#ff5fa2",
  cyan: "#3fd0ff",
  violet: "#b98cff",
  yellow: "#fff7a8",
  green: "#39ffb6",
} as const;

export type Role = "lead" | "dev" | "reviewer" | "generic";

const ROLE_SHIRT: Record<Role, string> = { lead: NEON.violet, dev: NEON.green, reviewer: NEON.cyan, generic: NEON.yellow };

const COLOR_NAMES: Record<string, string> = {
  blue: NEON.cyan,
  cyan: NEON.cyan,
  green: NEON.green,
  yellow: NEON.yellow,
  purple: NEON.violet,
  pink: NEON.pink,
  red: "#ff6b6b",
  orange: "#ffb86b",
};

export function roleOf(name: string): Role {
  const n = name.toLowerCase();
  if (/(lead|director|supervisor|manager|감독)/.test(n)) return "lead";
  if (/review/.test(n)) return "reviewer";
  if (/(dev|implement|builder|coder|구현)/.test(n)) return "dev";
  return "generic";
}

export function shirtColor(role: Role, color?: string): string {
  if (role !== "generic") return ROLE_SHIRT[role];
  return (color && COLOR_NAMES[color]) || ROLE_SHIRT.generic;
}
```

`web/pixel/sprites.ts`:
```ts
import type { Role } from "./palette";

export interface Rect {
  x: number;
  y: number;
  c: string;
}

// h 머리카락, s 피부, e 눈, c 셔츠, p 바지, g 안경, t 넥타이
const BODY_A = [
  "..hhhh..",
  ".hhhhhh.",
  ".hsssss.",
  ".sesses.",
  ".ssssss.",
  "..ssss..",
  ".cccccc.",
  "cccccccc",
  "cc.cc.cc",
  ".pp..pp.",
];
// 타이핑 프레임: 손이 키보드 위로 올라간다
const BODY_B = [...BODY_A.slice(0, 7), "sccccccs", ".cccccc.", ".pp..pp."];

export function characterRows(role: Role, frame: "a" | "b"): string[] {
  const rows = [...(frame === "a" ? BODY_A : BODY_B)];
  if (role === "reviewer") rows[3] = ".geggeg.";
  if (role === "lead") {
    rows[6] = ".ccttcc.";
    rows[7] = frame === "a" ? "cccttccc" : "sccttccs";
  }
  return rows;
}

export function spriteRects(rows: string[], colors: Record<string, string>): Rect[] {
  const out: Rect[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = colors[ch];
      if (c) out.push({ x, y, c });
    });
  });
  return out;
}
```

`web/pixel/PixelSprite.tsx`:
```tsx
import type { Rect } from "./sprites";

export function PixelSprite({ rects, x = 0, y = 0, className }: { rects: Rect[]; x?: number; y?: number; className?: string }) {
  return (
    <g transform={`translate(${x},${y})`} className={className}>
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.c} />
      ))}
    </g>
  );
}
```

`web/format.ts`:
```ts
import type { MemberState } from "../src/shared/types";

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function remainingPct(used: number, budget: number): number {
  return Math.max(0, Math.min(100, 100 - (used / budget) * 100));
}

const LABELS: Record<MemberState, string> = { working: "작업 중", idle: "대기", mail: "메시지 수신", offline: "종료" };

export function stateLabel(s: MemberState): string {
  return LABELS[s];
}
```

`web/useSnapshot.ts`:
```ts
import { useEffect, useState } from "react";
import type { Snapshot } from "../src/shared/types";

export function useSnapshot(): { snapshot: Snapshot | null; live: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let closed = false;
    fetch("/api/snapshot")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Snapshot | null) => {
        if (!closed && s) setSnapshot((cur) => cur ?? s);
      })
      .catch(() => {});

    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (e) => {
      setSnapshot(JSON.parse((e as MessageEvent).data));
      setLive(true);
    });
    es.onerror = () => setLive(false);
    return () => {
      closed = true;
      es.close();
    };
  }, []);

  return { snapshot, live };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/web/sprites.test.ts test/web/useSnapshot.test.tsx`
Expected: 16 passed

- [ ] **Step 5: Commit**

```bash
git add web/pixel web/format.ts web/useSnapshot.ts test/web/sprites.test.ts test/web/useSnapshot.test.tsx
git commit -m "feat(web): add pixel sprite system and snapshot hook"
```

---

### Task 11: HUD (토큰 카운터와 HeartBar)

**Files:**
- Create: `web/hud/HeartBar.tsx`, `web/hud/TokenCounter.tsx`, `web/hud/Hud.tsx`
- Test: `test/web/hud.test.tsx`, `test/web/fixtures.ts`

**Interfaces:**
- Consumes: `formatTokens`, `remainingPct` (Task 10), `Snapshot` (Task 1)
- Produces:
```ts
type Level = "ok" | "warn" | "danger";
function barLevel(remaining: number): Level;
function HeartBar(props: { label: string; remaining: number | null; emptyText: string; hint?: string }): JSX.Element;
function TokenCounter(props: { label: string; value: number; hint?: string; sub?: string }): JSX.Element;
function Hud(props: { snapshot: Snapshot; live: boolean }): JSX.Element;
```
- 테스트용 `makeSnapshot(partial?)`, `makeMember(partial?)`, `makeSession(partial?)` (`test/web/fixtures.ts`) — Task 12, 13에서도 쓴다.

- [ ] **Step 1: 테스트 fixture 작성** — `test/web/fixtures.ts`

```ts
import type { Member, SessionView, Snapshot } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";

export function makeMember(p: Partial<Member> = {}): Member {
  return { name: "developer", role: "developer", state: "idle", unread: 0, tokens: emptySum(), ...p };
}

export function makeSession(p: Partial<SessionView> = {}): SessionView {
  return { id: "s1", name: "alpha", cwd: "/x", alive: true, isCurrent: false, status: "idle", context: null, members: [makeMember({ name: "team-lead", role: "lead" })], ...p };
}

export function makeSnapshot(p: Partial<Snapshot> = {}): Snapshot {
  return {
    generatedAt: "2026-09-28T00:00:00.000Z",
    usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: new Array(24).fill(0) },
    budget: {},
    limits: null,
    sessions: [],
    ...p,
  };
}
```

- [ ] **Step 2: 실패하는 테스트 작성** — `test/web/hud.test.tsx`

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { barLevel, HeartBar } from "../../web/hud/HeartBar";
import { Hud } from "../../web/hud/Hud";
import { emptySum } from "../../src/shared/tokens";
import { makeSnapshot } from "./fixtures";

afterEach(cleanup);

describe("barLevel", () => {
  it.each([[100, "ok"], [50, "ok"], [49.9, "warn"], [20, "warn"], [19.9, "danger"], [0, "danger"]] as const)("%d → %s", (r, level) => {
    expect(barLevel(r)).toBe(level);
  });
});

describe("HeartBar", () => {
  it("값이 있으면 meter와 레벨 클래스를 그린다", () => {
    render(<HeartBar label="5H" remaining={12.4} emptyText="-- 설정 필요" />);
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("12");
    expect(meter.className).toContain("level-danger");
  });

  it("값이 없으면 대체 문구", () => {
    render(<HeartBar label="PLAN" remaining={null} emptyText="-- 데이터 없음" />);
    expect(screen.getByText("-- 데이터 없음")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });
});

describe("Hud", () => {
  it("예산과 한도가 없으면 대체 문구를 보여준다", () => {
    render(<Hud snapshot={makeSnapshot()} live={false} />);
    expect(screen.getAllByText("-- 설정 필요")).toHaveLength(2);
    expect(screen.getByText("-- 데이터 없음")).toBeTruthy();
    expect(screen.getByText("○ 재연결 중")).toBeTruthy();
  });

  it("예산·한도로 잔여량을 계산하고 토큰·캐시 읽기를 표시한다", () => {
    const snap = makeSnapshot({
      usage: {
        today: { ...emptySum(), cacheRead: 5000, total: 1_240_000 },
        last5h: { ...emptySum(), total: 900 },
        last7d: { ...emptySum(), total: 2500 },
        byModel: [],
        hourly: [],
      },
      budget: { fiveHour: 1000, weekly: 10000 },
      limits: { fiveHourPct: 40, source: "statusline" },
    });
    render(<Hud snapshot={snap} live />);
    const meters = screen.getAllByRole("meter");
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual(["10", "75", "60"]);
    expect(screen.getByLabelText("TODAY 1240000")).toBeTruthy();
    expect(screen.getByText("1.24M")).toBeTruthy();
    expect(screen.getByText("캐시 읽기 5.0k")).toBeTruthy();
    expect(screen.getByText("● LIVE")).toBeTruthy();
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run test/web/hud.test.tsx`
Expected: FAIL — `Failed to resolve import "../../web/hud/HeartBar"`

- [ ] **Step 4: 구현**

`web/hud/HeartBar.tsx`:
```tsx
export type Level = "ok" | "warn" | "danger";

export function barLevel(remaining: number): Level {
  if (remaining >= 50) return "ok";
  if (remaining >= 20) return "warn";
  return "danger";
}

export function HeartBar({ label, remaining, emptyText, hint }: { label: string; remaining: number | null; emptyText: string; hint?: string }) {
  return (
    <div className="heartbar">
      <div className="heartbar-label">
        {label} ♥{hint && <span className="hint">{hint}</span>}
      </div>
      {remaining === null ? (
        <div className="heartbar-empty">{emptyText}</div>
      ) : (
        <div
          className={`heartbar-track level-${barLevel(remaining)}`}
          role="meter"
          aria-label={`${label} 잔여`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(remaining)}
        >
          <div className="heartbar-fill" style={{ width: `${remaining}%` }} />
          <span className="heartbar-value">{Math.round(remaining)}%</span>
        </div>
      )}
    </div>
  );
}
```

`web/hud/TokenCounter.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import { formatTokens } from "../format";

function useTweenedNumber(target: number, ms = 600): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const v = Math.round(origin + (target - origin) * k);
      from.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

export function TokenCounter({ label, value, hint, sub }: { label: string; value: number; hint?: string; sub?: string }) {
  const shown = useTweenedNumber(value);
  return (
    <div className="counter" aria-label={`${label} ${value}`}>
      <div className="label">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="value">{formatTokens(shown)}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
```

`web/hud/Hud.tsx`:
```tsx
import type { Snapshot } from "../../src/shared/types";
import { formatTokens, remainingPct } from "../format";
import { HeartBar } from "./HeartBar";
import { TokenCounter } from "./TokenCounter";

export function Hud({ snapshot, live }: { snapshot: Snapshot; live: boolean }) {
  const { usage, budget, limits } = snapshot;
  const five = budget.fiveHour ? remainingPct(usage.last5h.total, budget.fiveHour) : null;
  const week = budget.weekly ? remainingPct(usage.last7d.total, budget.weekly) : null;
  const planUsed = limits?.fiveHourPct ?? limits?.weeklyPct;
  const plan = planUsed === undefined ? null : 100 - planUsed;
  const planHint = limits?.fiveHourPct !== undefined ? "5H" : limits?.weeklyPct !== undefined ? "WEEK" : undefined;

  return (
    <header className="hud">
      <TokenCounter label="TODAY" value={usage.today.total} sub={`캐시 읽기 ${formatTokens(usage.today.cacheRead)}`} />
      <TokenCounter label="5H" value={usage.last5h.total} hint="추정" />
      <TokenCounter label="WEEK" value={usage.last7d.total} hint="추정" />
      <HeartBar label="5H" remaining={five} emptyText="-- 설정 필요" />
      <HeartBar label="WEEK" remaining={week} emptyText="-- 설정 필요" />
      <HeartBar label="PLAN" remaining={plan} emptyText="-- 데이터 없음" hint={planHint} />
      <span className={`live ${live ? "on" : "off"}`}>{live ? "● LIVE" : "○ 재연결 중"}</span>
    </header>
  );
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run test/web/hud.test.tsx`
Expected: 10 passed

- [ ] **Step 6: Commit**

```bash
git add web/hud test/web/hud.test.tsx test/web/fixtures.ts
git commit -m "feat(web): add HUD with token counters and heart bars"
```

---

### Task 12: 사무실 타일, 책상, 말풍선

**Files:**
- Create: `web/office/StatusBubble.tsx`, `web/office/Desk.tsx`, `web/office/OfficeTile.tsx`, `web/office/OfficeGrid.tsx`
- Test: `test/web/office.test.tsx`

**Interfaces:**
- Consumes: `NEON`, `roleOf`, `shirtColor`, `characterRows`, `spriteRects`, `PixelSprite`, `formatTokens`, `stateLabel` (Task 10), `HeartBar` (Task 11), fixtures (Task 11)
- Produces:
```ts
function StatusBubble(props: { state: MemberState; unread: number }): JSX.Element | null;
function Desk(props: { member: Member }): JSX.Element;        // data-testid="desk-<name>"
function OfficeTile(props: { session: SessionView }): JSX.Element; // data-testid="office"
function OfficeGrid(props: { sessions: SessionView[] }): JSX.Element;
```

- [ ] **Step 1: 실패하는 테스트 작성** — `test/web/office.test.tsx`

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Desk } from "../../web/office/Desk";
import { OfficeGrid } from "../../web/office/OfficeGrid";
import { OfficeTile } from "../../web/office/OfficeTile";
import { NEON } from "../../web/pixel/palette";
import { makeMember, makeSession } from "./fixtures";

afterEach(cleanup);

describe("Desk", () => {
  it("working: ⌨ 말풍선, 켜진 모니터, 타이핑 프레임", () => {
    render(<Desk member={makeMember({ state: "working" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.className).toContain("state-working");
    expect(within(desk).getByTestId("bubble").textContent).toBe("⌨");
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOn);
    expect(desk.querySelector(".frame-b")).not.toBeNull();
  });

  it("idle: z z 말풍선, 꺼진 모니터, 타이핑 프레임 없음", () => {
    render(<Desk member={makeMember({ state: "idle" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).getByTestId("bubble").textContent).toBe("z z");
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOff);
    expect(desk.querySelector(".frame-b")).toBeNull();
  });

  it("mail: ✉와 안 읽은 개수", () => {
    render(<Desk member={makeMember({ state: "mail", unread: 2 })} />);
    expect(within(screen.getByTestId("desk-developer")).getByTestId("bubble").textContent).toBe("✉2");
  });

  it("offline: 빈 의자, 말풍선 없음", () => {
    render(<Desk member={makeMember({ state: "offline" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(within(desk).getByTestId("empty-chair")).toBeTruthy();
  });

  it("popover에 모델·토큰을 보여준다", () => {
    render(<Desk member={makeMember({ model: "sonnet", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 12345 } })} />);
    const pop = screen.getByRole("tooltip");
    expect(pop.textContent).toContain("모델: sonnet");
    expect(pop.textContent).toContain("토큰: 12.3k");
  });
});

describe("OfficeTile", () => {
  it("현재 세션 별표, CTX 잔여 바, 추정 표시", () => {
    render(<OfficeTile session={makeSession({ isCurrent: true, context: { used: 60000, window: 200000, pct: 30, estimated: true } })} />);
    const tile = screen.getByTestId("office");
    expect(tile.textContent).toContain("★");
    expect(within(tile).getByRole("meter").getAttribute("aria-valuenow")).toBe("70");
    expect(tile.textContent).toContain("추정");
  });

  it("종료된 세션은 off 클래스, stale이면 경고, context가 없으면 --", () => {
    render(<OfficeTile session={makeSession({ alive: false, stale: true, context: null })} />);
    const tile = screen.getByTestId("office");
    expect(tile.className).toContain("off");
    expect(tile.textContent).toContain("갱신 지연");
    expect(tile.textContent).toContain("CTX --");
  });

  it("팀원 수만큼 책상을 그린다", () => {
    render(<OfficeTile session={makeSession({ members: [makeMember({ name: "team-lead" }), makeMember({ name: "developer" }), makeMember({ name: "reviewer" })] })} />);
    expect(screen.getAllByTestId(/^desk-/)).toHaveLength(3);
  });
});

describe("OfficeGrid", () => {
  it("세션이 없으면 안내 문구", () => {
    render(<OfficeGrid sessions={[]} />);
    expect(screen.getByText("실행 중인 Claude Code 세션이 없습니다")).toBeTruthy();
  });

  it("세션 순서대로 타일을 그린다", () => {
    render(<OfficeGrid sessions={[makeSession({ id: "a", name: "first" }), makeSession({ id: "b", name: "second" })]} />);
    expect(screen.getAllByTestId("office").map((t) => t.getAttribute("aria-label"))).toEqual(["first 사무실", "second 사무실"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/web/office.test.tsx`
Expected: FAIL — `Failed to resolve import "../../web/office/Desk"`

- [ ] **Step 3: 구현**

`web/office/StatusBubble.tsx`:
```tsx
import type { MemberState } from "../../src/shared/types";
import { NEON } from "../pixel/palette";

const ICON: Record<MemberState, string> = { working: "⌨", idle: "z z", mail: "✉", offline: "" };

export function StatusBubble({ state, unread }: { state: MemberState; unread: number }) {
  if (state === "offline") return null;
  const text = state === "mail" && unread > 0 ? `${ICON.mail}${unread}` : ICON[state];
  return (
    <g className={`bubble bubble-${state}`}>
      <rect x={0} y={0} width={12} height={7} fill={NEON.yellow} />
      <rect x={3} y={7} width={2} height={1} fill={NEON.yellow} />
      <text data-testid="bubble" x={6} y={5.3} fontSize={4.5} textAnchor="middle" fill={NEON.wall} fontFamily="monospace">
        {text}
      </text>
    </g>
  );
}
```

`web/office/Desk.tsx`:
```tsx
import type { Member } from "../../src/shared/types";
import { formatTokens, stateLabel } from "../format";
import { NEON, roleOf, shirtColor } from "../pixel/palette";
import { PixelSprite } from "../pixel/PixelSprite";
import { characterRows, spriteRects } from "../pixel/sprites";
import { StatusBubble } from "./StatusBubble";

export function Desk({ member }: { member: Member }) {
  const role = roleOf(member.name);
  const colors = { h: NEON.hair, s: NEON.skin, e: NEON.eye, c: shirtColor(role, member.color), p: NEON.pants, g: NEON.glasses, t: NEON.pink };
  const working = member.state === "working";
  const screenOn = working || member.state === "mail";

  return (
    <div className={`desk state-${member.state}`} data-testid={`desk-${member.name}`} tabIndex={0}>
      <svg className="desk-svg" viewBox="0 0 24 30" shapeRendering="crispEdges" role="img" aria-label={`${member.name}: ${stateLabel(member.state)}`}>
        <g transform="translate(1,0)">
          <StatusBubble state={member.state} unread={member.unread} />
        </g>
        {member.state === "offline" ? (
          <g data-testid="empty-chair">
            <rect x={3} y={13} width={6} height={6} fill={NEON.deskDark} />
            <rect x={4} y={19} width={1} height={2} fill={NEON.deskDark} />
            <rect x={7} y={19} width={1} height={2} fill={NEON.deskDark} />
          </g>
        ) : (
          <g className="char">
            <PixelSprite rects={spriteRects(characterRows(role, "a"), colors)} x={2} y={9} className="frame-a" />
            {working && <PixelSprite rects={spriteRects(characterRows(role, "b"), colors)} x={2} y={9} className="frame-b" />}
          </g>
        )}
        <rect x={12} y={11} width={8} height={6} fill={NEON.monitor} />
        <rect data-testid="screen" x={13} y={12} width={6} height={4} fill={screenOn ? NEON.screenOn : NEON.screenOff} />
        {working && (
          <g className="code">
            <rect x={14} y={13} width={3} height={1} fill={NEON.monitor} />
            <rect x={14} y={14} width={4} height={1} fill={NEON.monitor} />
          </g>
        )}
        <rect x={15} y={17} width={2} height={2} fill={NEON.monitor} />
        <rect x={0} y={19} width={24} height={2} fill={NEON.desk} />
        <rect x={1} y={21} width={2} height={8} fill={NEON.deskDark} />
        <rect x={21} y={21} width={2} height={8} fill={NEON.deskDark} />
      </svg>
      <div className="desk-name">{member.name}</div>
      <div className="popover" role="tooltip">
        <div>
          <b>{member.name}</b> · {stateLabel(member.state)}
        </div>
        <div>모델: {member.model ?? "-"}</div>
        <div>토큰: {formatTokens(member.tokens.total)}</div>
        <div>최근 활동: {member.lastActivityAt ? new Date(member.lastActivityAt).toLocaleTimeString("ko-KR") : "-"}</div>
      </div>
    </div>
  );
}
```

`web/office/OfficeTile.tsx`:
```tsx
import type { SessionView } from "../../src/shared/types";
import { HeartBar } from "../hud/HeartBar";
import { NEON } from "../pixel/palette";
import { Desk } from "./Desk";

function Backdrop() {
  return (
    <svg className="office-bg" viewBox="0 0 80 12" shapeRendering="crispEdges" aria-hidden="true">
      <rect x={4} y={1} width={14} height={9} fill={NEON.desk} />
      <rect x={5} y={2} width={12} height={7} fill="#0b0a1a" />
      <rect x={10} y={2} width={1} height={7} fill={NEON.desk} />
      <rect x={7} y={3} width={1} height={1} fill={NEON.yellow} />
      <rect x={14} y={6} width={1} height={1} fill={NEON.yellow} />
      <rect x={60} y={1} width={6} height={6} fill={NEON.desk} />
      <rect x={61} y={2} width={4} height={4} fill={NEON.yellow} />
      <rect x={63} y={3} width={1} height={2} fill={NEON.wall} />
      <rect x={72} y={4} width={3} height={2} fill={NEON.green} />
      <rect x={71} y={6} width={5} height={5} fill={NEON.pink} />
    </svg>
  );
}

export function OfficeTile({ session }: { session: SessionView }) {
  const ctx = session.context;
  return (
    <section className={`office${session.alive ? "" : " off"}`} data-testid="office" aria-label={`${session.name} 사무실`}>
      <div className="office-head">
        <span className="office-name" title={session.cwd}>
          {session.isCurrent && <span className="star">★</span>}
          {session.name}
        </span>
        {session.stale && <span className="stale">⚠ 갱신 지연</span>}
      </div>
      <Backdrop />
      <div className="desks">
        {session.members.map((m) => (
          <Desk key={m.name} member={m} />
        ))}
      </div>
      <div className="ctx">
        {ctx ? (
          <HeartBar label="CTX" remaining={100 - ctx.pct} emptyText="" hint={ctx.estimated ? "추정" : undefined} />
        ) : (
          <div className="heartbar-empty">CTX --</div>
        )}
      </div>
    </section>
  );
}
```

`web/office/OfficeGrid.tsx`:
```tsx
import type { SessionView } from "../../src/shared/types";
import { OfficeTile } from "./OfficeTile";

export function OfficeGrid({ sessions }: { sessions: SessionView[] }) {
  if (sessions.length === 0) return <div className="empty">실행 중인 Claude Code 세션이 없습니다</div>;
  return (
    <main className="grid">
      {sessions.map((s) => (
        <OfficeTile key={s.id} session={s} />
      ))}
    </main>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/web/office.test.tsx`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add web/office test/web/office.test.tsx
git commit -m "feat(web): add office tiles, desks and status bubbles"
```

---

### Task 13: 앱 조립, 스타일, README, 실사용 확인

**Files:**
- Create: `web/App.tsx`, `web/main.tsx`, `web/styles.css`, `README.md`
- Test: `test/web/app.test.tsx`

**Interfaces:**
- Consumes: `useSnapshot` (Task 10), `Hud` (Task 11), `OfficeGrid` (Task 12), 서버 전체(Task 9)
- Produces: `App` 컴포넌트, 빌드 가능한 프론트엔드

- [ ] **Step 1: 실패하는 테스트 작성** — `test/web/app.test.tsx`

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: false } }));
vi.mock("../../web/useSnapshot", () => ({ useSnapshot: () => state.value }));

import { App } from "../../web/App";

afterEach(cleanup);

describe("App", () => {
  it("스냅샷을 받기 전에는 로딩 문구", () => {
    state.value = { snapshot: null, live: false };
    render(<App />);
    expect(screen.getByText("사무실 불 켜는 중...")).toBeTruthy();
  });

  it("error가 있으면 배너를 띄우고 HUD와 사무실을 그린다", () => {
    state.value = { snapshot: makeSnapshot({ error: "Claude 데이터 폴더를 읽을 수 없습니다: /x", sessions: [makeSession()] }), live: true };
    render(<App />);
    expect(screen.getByRole("alert").textContent).toContain("/x");
    expect(screen.getByText("● LIVE")).toBeTruthy();
    expect(screen.getAllByTestId("office")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/web/app.test.tsx`
Expected: FAIL — `Failed to resolve import "../../web/App"`

- [ ] **Step 3: 구현**

`web/App.tsx`:
```tsx
import { Hud } from "./hud/Hud";
import { OfficeGrid } from "./office/OfficeGrid";
import { useSnapshot } from "./useSnapshot";

export function App() {
  const { snapshot, live } = useSnapshot();
  if (!snapshot) return <div className="loading">사무실 불 켜는 중...</div>;
  return (
    <div className="app">
      {snapshot.error && (
        <div className="banner" role="alert">
          {snapshot.error}
        </div>
      )}
      <Hud snapshot={snapshot} live={live} />
      <OfficeGrid sessions={snapshot.sessions} />
    </div>
  );
}
```

`web/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/styles.css`:
```css
:root {
  --bg: #12111f;
  --wall: #1d1b33;
  --floor: #2a2446;
  --desk: #3b3460;
  --panel: #0e0d18;
  --ink: #e8e4ff;
  --muted: #9d97c7;
  --green: #39ffb6;
  --pink: #ff5fa2;
  --cyan: #3fd0ff;
  --violet: #b98cff;
  --yellow: #fff7a8;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.app { max-width: 1200px; margin: 0 auto; padding: 16px; }
.loading { padding: 40px; text-align: center; color: var(--muted); }
.banner { background: var(--pink); color: var(--bg); padding: 8px 12px; margin-bottom: 12px; font-weight: bold; }

.hud { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; background: var(--panel); border: 2px solid var(--desk); padding: 10px 12px; margin-bottom: 16px; }
.counter .label, .heartbar-label { font-size: 11px; color: var(--muted); }
.counter .value { font-size: 20px; font-weight: bold; color: var(--green); }
.counter .sub { font-size: 10px; color: var(--muted); }
.hint { margin-left: 4px; font-size: 10px; color: var(--yellow); }
.heartbar { flex: 1; min-width: 140px; }
.heartbar-track { position: relative; height: 12px; background: #2c2a40; border: 2px solid var(--desk); }
.heartbar-fill { position: absolute; top: 0; bottom: 0; left: 0; }
.level-ok .heartbar-fill { background: var(--green); }
.level-warn .heartbar-fill { background: var(--yellow); }
.level-danger .heartbar-fill { background: var(--pink); animation: blink 1s steps(1) infinite; }
.heartbar-value { position: absolute; right: 4px; top: -2px; font-size: 10px; color: var(--ink); text-shadow: 0 0 2px var(--bg); }
.heartbar-empty { padding-top: 2px; font-size: 12px; color: var(--muted); }
.live { margin-left: auto; font-size: 12px; }
.live.on { color: var(--green); }
.live.off { color: var(--pink); }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.empty { padding: 40px; text-align: center; color: var(--muted); border: 2px dashed var(--desk); }
.office { background: linear-gradient(var(--wall) 0 72%, var(--floor) 72% 100%); border: 2px solid var(--desk); padding: 8px; }
.office.off { opacity: 0.45; filter: grayscale(0.6); }
.office-head { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 12px; }
.star { margin-right: 4px; color: var(--yellow); }
.stale { color: var(--pink); }
.office-bg { display: block; width: 100%; image-rendering: pixelated; }
.desks { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; }
.desk { position: relative; width: 96px; text-align: center; outline: none; }
.desk-svg { display: block; width: 96px; height: 120px; image-rendering: pixelated; overflow: visible; }
.desk-name { font-size: 11px; }
.popover { display: none; position: absolute; z-index: 10; left: 50%; top: 0; transform: translate(-50%, -100%); background: var(--panel); border: 2px solid var(--cyan); padding: 6px 8px; font-size: 11px; text-align: left; white-space: nowrap; }
.desk:hover .popover, .desk:focus .popover { display: block; }
.ctx { margin-top: 6px; }

.frame-b { opacity: 0; }
.state-working .frame-a { animation: frameA 0.5s steps(1) infinite; }
.state-working .frame-b { animation: frameB 0.5s steps(1) infinite; }
.state-working .code { animation: blink 0.4s steps(1) infinite; }
.state-idle .char, .bubble-idle { animation: nod 2s steps(1) infinite; }
@keyframes frameA { 0% { opacity: 1; } 50% { opacity: 0; } }
@keyframes frameB { 0% { opacity: 0; } 50% { opacity: 1; } }
@keyframes nod { 0% { transform: translateY(0); } 50% { transform: translateY(1px); } }
@keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; }
  .frame-b { opacity: 0 !important; }
}
```

`README.md`:
```markdown
# Claude Agent Office Viewer

Claude Code의 토큰 사용량·잔여량, 실행 중인 세션, agent team 팀원 상태를 네온 도트 사무실로 보여주는 로컬 대시보드입니다.
`~/.claude`를 읽기만 하며, 서버는 `127.0.0.1`에서만 열립니다.

## 실행

```bash
npm install
npm run build
npm start            # http://127.0.0.1:4317
```

개발 모드: `npm run dev` (Vite + API 서버 동시 실행)

옵션: `npm start -- --port 5000 --claude-home /path/to/.claude --config ./my.config.json`

## 예산과 컨텍스트 창 설정 (선택)

`claude-office.config.example.json`을 `claude-office.config.json`으로 복사해 값을 바꿉니다.
- `budget.fiveHour`, `budget.weekly`: HUD의 5H·WEEK 잔여량 기준(토큰 수). 없으면 `-- 설정 필요`.
- `contextWindows`: 모델 이름 접두어별 컨텍스트 창 크기. 없으면 200k로 추정.

## 요금제 한도 표시 (선택)

`npm run setup:statusline`을 실행하면 statusline 입력을 `~/.claude/claude-office/limits.json`에 복사하도록 설정합니다(기존 상태줄 모양은 유지, 설정은 백업).
되돌리기: `npm run remove:statusline`. Claude Code가 한도 정보를 넘겨주지 않는 버전에서는 PLAN 바가 `-- 데이터 없음`으로 표시됩니다.

## 테스트

`npm test`, 타입 검사 `npm run typecheck`
```

- [ ] **Step 4: 통과 확인 (전체)**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 전체 테스트 통과, tsc 오류 없음, `dist/web/index.html` 생성

- [ ] **Step 5: 실제 데이터로 실행 확인**

Run:
```bash
npm start > /tmp/claude-office.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:4317/api/snapshot | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("error:",s.error??"none");console.log("today:",s.usage.today.total);for(const x of s.sessions)console.log(x.isCurrent?"★":" ",x.name,x.status,x.members.map(m=>m.name+":"+m.state).join(", "))'
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4317/
```
Expected:
- `error: none`
- `today:` 0보다 큰 값
- 현재 세션 줄에 `★`와 팀원 목록(예: `team-lead:working, director:idle, developer:idle, reviewer:idle`)
- 마지막 줄 `200`

화면 캡처(Chrome이 있을 때):
```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] && "$CHROME" --headless=new --disable-gpu --window-size=1280,900 --virtual-time-budget=4000 --screenshot=/tmp/claude-office.png http://127.0.0.1:4317/ && echo saved
```
Read 도구로 `/tmp/claude-office.png`를 열어 확인한다.
- HUD가 보이는가
- 사무실 타일에 팀원 캐릭터가 그려지는가
- 빈 화면이나 오류 배너가 아닌가

Chrome이 없으면 캡처를 건너뛰고 그 사실을 보고한다.

마지막에 서버를 종료한다: `kill %1`

- [ ] **Step 6: Commit**

```bash
git add web/App.tsx web/main.tsx web/styles.css README.md test/web/app.test.tsx
git commit -m "feat(web): assemble app with neon office styles and README"
```

---

### Task 14: statusline tap과 설치/제거 스크립트

**Files:**
- Create: `scripts/statusline-tap.sh`, `scripts/statusline-setup.mjs`
- Test: `test/scripts/statusline.test.ts`

**Interfaces:**
- Consumes: 없음 (`readLimits`(Task 7)가 이 스크립트의 출력 파일을 읽는다)
- Produces:
  - `scripts/statusline-tap.sh`: stdin JSON을 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-office/limits.json`에 원자적으로 저장한다. 그 뒤 `original-statusline.sh`가 있으면 같은 입력으로 실행해 그 출력을 그대로 내보낸다.
  - `scripts/statusline-setup.mjs install|remove`: 대상은 `CLAUDE_CONFIG_DIR`, 없으면 `~/.claude`.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/scripts/statusline.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

const TAP = resolve("scripts/statusline-tap.sh");
const SETUP = resolve("scripts/statusline-setup.mjs");

let h: FakeHome;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  h = await makeHome();
  env = { ...process.env, CLAUDE_CONFIG_DIR: h.home };
});
afterEach(() => h.cleanup());

const json = async (rel: string) => JSON.parse(await readFile(h.path(rel), "utf8"));

describe("statusline-tap.sh", () => {
  it("입력을 limits.json에 저장하고 원래 명령의 출력을 그대로 낸다", async () => {
    await h.write("claude-office/original-statusline.sh", '#!/bin/sh\necho "ORIG:$(cat)"\n');
    execFileSync("chmod", ["755", h.path("claude-office/original-statusline.sh")]);
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } });
    const out = execFileSync("sh", [TAP], { input, env }).toString();
    expect(out.trim()).toBe(`ORIG:${input}`);
    expect(await json("claude-office/limits.json")).toEqual(JSON.parse(input));
  });

  it("원래 명령이 없어도 저장은 한다", async () => {
    const out = execFileSync("sh", [TAP], { input: '{"a":1}', env }).toString();
    expect(out).toBe("");
    expect(await json("claude-office/limits.json")).toEqual({ a: 1 });
  });
});

describe("statusline-setup.mjs", () => {
  it("install은 백업·원래 명령 저장 후 tap으로 교체하고, remove는 원래대로 되돌린다", async () => {
    await h.write("settings.json", { theme: "dark", statusLine: { type: "command", command: "echo hi" } });

    execFileSync("node", [SETUP, "install"], { env });
    const installed = await json("settings.json");
    expect(installed.theme).toBe("dark");
    expect(installed.statusLine.command).toContain("statusline-tap.sh");
    expect(await readFile(h.path("claude-office/original-statusline.sh"), "utf8")).toContain("echo hi");
    expect((await json("claude-office/settings.backup.json")).statusLine.command).toBe("echo hi");

    execFileSync("node", [SETUP, "install"], { env }); // 두 번 실행해도 백업을 덮어쓰지 않는다
    expect((await json("claude-office/settings.backup.json")).statusLine.command).toBe("echo hi");

    execFileSync("node", [SETUP, "remove"], { env });
    expect(await json("settings.json")).toEqual({ theme: "dark", statusLine: { type: "command", command: "echo hi" } });
  });

  it("statusLine이 없던 설정도 install/remove 할 수 있다", async () => {
    await h.write("settings.json", { theme: "dark" });
    execFileSync("node", [SETUP, "install"], { env });
    execFileSync("node", [SETUP, "remove"], { env });
    expect(await json("settings.json")).toEqual({ theme: "dark" });
  });

  it("백업 없이 remove하면 종료 코드 1", async () => {
    await h.write("settings.json", {});
    expect(() => execFileSync("node", [SETUP, "remove"], { env, stdio: "pipe" })).toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/scripts/statusline.test.ts`
Expected: FAIL — `sh: .../scripts/statusline-tap.sh: No such file or directory` 류의 오류

- [ ] **Step 3: 구현**

`scripts/statusline-tap.sh`:
```sh
#!/bin/sh
# Claude Code statusline 입력(JSON)을 claude-office/limits.json에 복사하고, 원래 statusline 명령을 그대로 실행한다.
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-office"
mkdir -p "$dir"
input=$(cat)
tmp="$dir/limits.json.$$"
printf '%s' "$input" > "$tmp" && mv "$tmp" "$dir/limits.json"
orig="$dir/original-statusline.sh"
if [ -x "$orig" ]; then
  printf '%s' "$input" | "$orig"
fi
```

`scripts/statusline-setup.mjs`:
```js
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const settingsPath = join(claudeDir, "settings.json");
const officeDir = join(claudeDir, "claude-office");
const backupPath = join(officeDir, "settings.backup.json");
const origPath = join(officeDir, "original-statusline.sh");
const tapPath = fileURLToPath(new URL("./statusline-tap.sh", import.meta.url));

async function readSettings() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n");

async function install() {
  const settings = await readSettings();
  if (settings.statusLine?.command?.includes("statusline-tap.sh")) {
    console.log("이미 설치되어 있습니다.");
    return;
  }
  await mkdir(officeDir, { recursive: true });
  if (!existsSync(backupPath)) await writeJson(backupPath, settings);
  const original = settings.statusLine?.type === "command" ? settings.statusLine.command : "";
  await writeFile(origPath, `#!/bin/sh\n${original}\n`);
  await chmod(origPath, 0o755);
  settings.statusLine = { ...(settings.statusLine ?? {}), type: "command", command: `sh '${tapPath}'` };
  await writeJson(settingsPath, settings);
  console.log(`statusline tap을 설치했습니다. 백업: ${backupPath}`);
}

async function remove() {
  if (!existsSync(backupPath)) {
    console.error(`백업(${backupPath})이 없어 되돌릴 수 없습니다.`);
    process.exit(1);
  }
  const backup = JSON.parse(await readFile(backupPath, "utf8"));
  const settings = await readSettings();
  if (backup.statusLine) settings.statusLine = backup.statusLine;
  else delete settings.statusLine;
  await writeJson(settingsPath, settings);
  console.log("statusline 설정을 원래대로 되돌렸습니다.");
}

const cmd = process.argv[2];
if (cmd === "install") await install();
else if (cmd === "remove") await remove();
else {
  console.error("사용법: node scripts/statusline-setup.mjs install|remove");
  process.exit(1);
}
```

Note: `remove`는 백업 파일을 지우지 않는다. 다시 `install`하면 기존 백업을 유지한다(최초 상태 보존).

- [ ] **Step 4: 통과 확인**

Run: `chmod +x scripts/statusline-tap.sh && npx vitest run test/scripts/statusline.test.ts && npx vitest run`
Expected: 5 passed, 전체 테스트 통과

- [ ] **Step 5: Commit**

```bash
git add scripts test/scripts
git commit -m "feat: add optional statusline tap for plan limits"
```
