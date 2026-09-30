# v2.0.0-beta.1 베타 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 버전을 엔터프라이즈 베타 고객에게 설치 스크립트 하나로 배포하고, 문제가 생기면 고객이 진단 파일 하나를 만들어 보내 QA가 분석할 수 있게 한다.

**Architecture:**
- **서버 보강:** `server/log.ts`(JSON Lines 로거, 가림·보관·반복 억제), `server/paths.ts`(설치·개발 경로), `server/events/stats.ts`(hook 수신 통계), 견고성 수정(Node 검사, 빌드 없음, 첫 스냅샷 실패).
- **진단:** `server/diag/doctor.ts`(환경 점검 항목), `server/diag/bundle.ts`(진단 파일 JSON 하나). CLI(`doctor`, `diag`)와 API(`GET /api/diagnostics`, `POST /api/diagnostics/bundle`)가 같은 모듈을 쓴다.
- **배포:** `vite build --ssr`로 서버를 `server.mjs` 하나로 묶고, 운영 의존성(express 계열)을 로컬 `node_modules`에서 복사해 `release/`에 tar.gz·zip을 만든다. 설치 스크립트(`install.sh`, `install.ps1`)가 `~/.claude-office/`에 풀고 `claude-office` 명령을 만든다.
- **화면:** HUD에 "진단" 칩과 패널(designer 디자인).
- **QA:** `npm run qa:analyze`가 진단 파일을 Markdown 요약과 `[QA 인폼]` 초안으로 바꾼다. 사용설명서는 오프라인 HTML 하나.

**Tech Stack:** Node 24 (ESM), TypeScript, Express 5, React 19, Vite(SSR 빌드 포함), Vitest, POSIX sh/bash, PowerShell 5+

**Spec:** `docs/superpowers/specs/2026-10-01-beta-release-design.md` (커밋 cdbcb3f, 사용자 승인)
**선행:** v2 Phase 1 계획 `docs/superpowers/plans/2026-10-01-v2-phase1.md`, 디자인 `docs/design/phase1/SPEC.md`

## Global Constraints

- 버전은 `2.0.0-beta.1`. `package.json`, `plugins/claude-office/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, 패키지의 `VERSION`이 모두 같다. git 태그 `v2.0.0-beta.1`은 로컬에만 만든다(push 금지).
- 설치 위치 `~/.claude-office/`(Windows `%USERPROFILE%\.claude-office\`): `app/`(재설치 때 교체), `bin/`, `logs/`, `diagnostics/`(재설치해도 유지).
- 고객 PC에서 **npm·인터넷·tsx 없이** `node`만으로 서버가 켜진다. Node 24 미만이면 쉬운 말 안내 후 종료 코드 1.
- 로그: `logs/office-YYYY-MM-DD.log`, 한 줄에 JSON 하나 `{"t","level","src","msg","data"}`. 7일 지난 파일은 시작 때 삭제, 파일 하나 5MB에 닿으면 `"log cap reached"` 한 줄 후 그날은 더 쓰지 않음, 같은 `src`+`msg`의 warn은 10분에 한 번(억제 건수를 다음 기록에 붙임). 모든 문자열은 Phase 1 `redact()`를 거치고 홈 경로는 `~`로 바꾼다. 요청 본문·대화 내용·프롬프트·설정 값·환경변수 값은 기록하지 않는다.
- doctor 결과 항목은 `{id, status: "ok"|"warn"|"fail", title, detail, fix}`. `detail`에는 **있음/없음과 숫자만**. 설정 파일에서는 스펙 7장의 키만 읽는다. 자격 증명 파일(`.credentials.json`, `*.key`, 키체인)은 읽지 않는다.
- 진단 파일: `diagnostics/claude-office-diag-<시각>.json` JSON 하나, 5MB 이내(오래된 로그부터 버림), 쓰기 직전 전체를 `redact()`, 이름·폴더명·세션명·홈 경로 없음.
- `POST /api/diagnostics/bundle`: Host 검사, Origin 규칙(Ruling B1), `Content-Type: application/json` 강제. 파일 경로는 요청이 정하지 않는다.
- 플러그인 hook 주소는 4317 고정. 서버를 다른 포트로 켜면 warn 로그와 doctor ⚠️.
- **테스트 안전:** 설치 테스트는 항상 `HOME=<임시>`와 `--no-path`(PATH 단계를 시험할 때만 `HOME=<임시>`에서 `--no-path` 없이), `--no-open`. 플러그인 실제 설치는 임시 `CLAUDE_CONFIG_DIR`에만. 테스트 로그는 임시 `--log-dir`. 이 Mac 사용자의 `~/.zshrc`, `~/.bashrc`, `~/.claude`는 고치지 않는다. `~/.claude/settings.json` 기준값 `84b304dd4c5092f8e8f026998415b6ce7a407552`. 포트 4317은 쓰지도 끄지도 않는다.
- 가짜 비밀값만 쓴다. 진단 파일(고객 데이터)은 커밋하지 않는다. `.gitignore`: `.logs/`, `release/`, `beta-feedback/`.
- 코드 서명·로그 자동 전송·자동 시작·Phase 2 기능·Windows PLAN 바는 범위 밖.
- 병렬 작업 규칙: qa와 developer는 서로 다른 파일 집합만 만진다. 커밋은 `git add <경로>`로 자기 파일만(`git add -A`, `commit -a` 금지).
- UI 문구는 한국어. 사용설명서는 비개발자용 쉬운 말.

## Review Focus

1. **설치 스크립트가 실제 홈을 건드리는 경우:** `HOME`이 임시여도 스크립트가 `~`를 하드코딩하거나 `--no-path`를 무시하면 사용자의 셸 설정이 바뀐다. → Task 7 테스트 `--no-path면 HOME의 셸 설정 파일을 만들지도 고치지도 않는다`
2. **로그·진단 파일로 비밀값과 이름이 새는 경우:** 오류 메시지에 명령이나 경로가 섞여 들어오면 파일에 남는다. → Task 1 테스트 `msg와 data의 가짜 비밀값과 홈 경로를 가린다`, Task 5 테스트 `진단 파일에 가짜 비밀값·홈 경로·세션·팀원 이름이 없다`
3. **로그 폭주:** 수집기가 3초마다 같은 경고를 내면 파일이 금방 5MB에 닿는다. → Task 1 테스트 `같은 warn은 10분에 한 번, 억제 건수를 붙인다`, `5MB에 닿으면 그날은 더 쓰지 않는다`
4. **첫 스냅샷 전·실패 중의 요청:** 서버가 막 켜졌거나 데이터 폴더를 못 읽을 때 화면·API가 500이 되면 고객은 "안 켜진다"고만 말한다. → Task 2 테스트 `첫 빌드가 실패해도 /api/snapshot은 200과 error`
5. **진단 파일 API 남용:** 다른 웹페이지가 POST로 파일을 계속 만들게 하거나 경로를 조작하는 경우. → Task 5 테스트 `다른 출처 Origin·JSON 아닌 요청·경로 조작을 거부한다`

## 계획서 판정

- **Ruling B1:** 스펙 8장은 bundle API에 "hook과 같은 Origin 검사"를 요구하지만, hook 규칙(Origin이 있으면 403)을 그대로 쓰면 브라우저의 같은 출처 POST(버튼)에도 Origin이 붙어 항상 403이 된다. 그래서 bundle API는 **Origin이 없거나, Origin의 호스트:포트가 요청 Host와 같고 호스트가 127.0.0.1/localhost/[::1]일 때만** 허용한다. 다른 출처는 403. — 틀리면: 버튼이 동작하지 않거나(너무 엄격), 다른 출처가 파일을 만들 수 있음(너무 느슨).
- **Ruling B2:** 설치본에서 로그·진단 폴더는 실행 명령이 넘기는 환경변수 `CLAUDE_OFFICE_PREFIX`로 정한다(`<prefix>/logs`, `<prefix>/diagnostics`). 없으면 개발 모드로 보고 저장소의 `.logs/`와 `.logs/diagnostics/`를 쓴다. `--log-dir`가 있으면 로그 폴더만 바꾼다. — 틀리면: 고객이 서버를 직접 `node`로 켜면 로그가 저장소 규칙을 따라 app 폴더 옆에 생김(doctor가 경로를 보여 줌).
- **Ruling B3:** 설치 스크립트에 `--no-open`(사용설명서·브라우저를 열지 않음)을 더한다. 스펙에 없지만 테스트가 브라우저를 열지 않게 하기 위함. — 틀리면: 없음.
- **Ruling B4:** 운영 의존성은 `npm ls --omit=dev --all --parseable`로 로컬 `node_modules`의 경로 목록을 얻어 복사한다(네트워크 없음). — 틀리면: 로컬 node_modules가 불완전하면 패키지가 깨짐(Task 6 테스트가 패키지만으로 서버를 켜서 확인).
- **Ruling B5:** CLI `doctor`의 hooks 항목은 서버가 켜져 있으면 `GET http://127.0.0.1:<port>/api/diagnostics`의 hooks 결과를 쓰고, 꺼져 있으면 warn "서버가 꺼져 있어 확인하지 못했습니다". — 틀리면: 없음.
- **Ruling B6(작업 분담):** 팀 제안 순서를 따르되, `server/collectors/sessions.ts`의 빈 catch 로그 전환은 Task 3(developer, 같은 파일의 ps 분기)에서 한다. `server/index.ts`는 qa만(Task 1·2·4·5), `package.json`은 Task 6(developer) 뒤 Task 11(qa) 순서로만 만진다.

---

## File Structure

```
.gitignore                                   .logs/ release/ beta-feedback/ (Task 1)
server/log.ts                                로거 (Task 1)
server/paths.ts                              설치·개발 경로 (Task 1)
server/index.ts                              로거 연결, Node 검사, 포트 경고, doctor·diag 하위 명령 (Task 1·2·4·5, qa)
server/app.ts                                빌드 없음 안내, hook 통계, 진단 API (Task 2·5, qa)
server/hub.ts, server/snapshot.ts            첫 스냅샷 실패 (Task 2)
server/events/stats.ts                       hook 수신 통계 (Task 2)
server/collectors/{teams,usage,limits}.ts, server/config.ts   빈 catch → 로그 (Task 2)
server/collectors/sessions.ts                Windows 분기, 빈 catch → 로그 (Task 3, developer)
scripts/statusline-setup.mjs                 Windows 안내 (Task 3)
server/diag/doctor.ts                        doctor (Task 4)
server/diag/bundle.ts                        진단 파일 (Task 5)
vite.server.config.ts, scripts/package-beta.mjs, package.json(스크립트·버전), plugin.json·marketplace.json 버전 (Task 6)
packaging/install.sh, packaging/claude-office.sh (Task 7)
packaging/install.ps1, packaging/claude-office.cmd, packaging/claude-office.ps1 (Task 8)
docs/design/beta/diagnostics.md (Task 9, designer)
web/diag/DiagnosticsChip.tsx, web/diag/DiagnosticsPanel.tsx, web/diag/useDiagnostics.ts, web/hud/Hud.tsx, web/styles.css (Task 10)
scripts/qa-analyze.ts, package.json("qa:analyze") (Task 11, qa)
docs/manual/index.html (Task 12, qa + designer 그림)
test/server/{log,paths,stats,robust,doctor,bundle,diag-api}.test.ts, test/scripts/{package,install,qa-analyze}.test.ts, test/web/diag.test.tsx
```

## 병렬 트랙

| 트랙 | 순서 | 파일 집합 |
|---|---|---|
| qa | T1 → T2 → T4 → T5 → T11 → T12 | server/(sessions.ts 제외), .gitignore, scripts/qa-analyze.ts, docs/manual |
| developer | T3(T1 뒤) → T6 → T7 → T8 → T10(T5·T9 뒤) | server/collectors/sessions.ts, scripts/statusline-setup.mjs, vite.server.config.ts, scripts/package-beta.mjs, package.json, plugin·marketplace json, packaging/, web/diag, web/hud/Hud.tsx, web/styles.css |
| designer | T9 (언제든) | docs/design/beta/ |

T11은 T6이 끝난 뒤 package.json을 만진다. T13은 모두 끝난 뒤.

---
### Task 1: 로거·경로와 .gitignore (qa)

**Files:**
- Create: `server/log.ts`, `server/paths.ts`
- Modify: `server/index.ts`(로거 초기화, 시작·종료 로그, `--log-dir`, 정적 폴더를 `resolvePaths`로), `server/app.ts`·`server/hub.ts`·`server/snapshot.ts`의 `console.*`를 로거로, `.gitignore`
- Test: `test/server/log.test.ts`, `test/server/paths.test.ts`, `test/server/cli.test.ts`(`--log-dir`)

**Interfaces:**
- Produces:
  ```ts
  // server/log.ts
  export type Level = "info" | "warn" | "error";
  export interface LogLine { t: string; level: Level; src: string; msg: string; data?: Record<string, unknown> }
  export interface LoggerOptions { dir: string; now?: () => number; home?: string; maxBytes?: number; retainDays?: number; dedupeMs?: number }
  export class Logger {
    constructor(opts: LoggerOptions);
    info(src: string, msg: string, data?: Record<string, unknown>): void;
    warn(src: string, msg: string, data?: Record<string, unknown>): void;   // src+msg 기준 dedupeMs(기본 10분) 억제
    error(src: string, msg: string, data?: Record<string, unknown>): void;
    cleanup(): void;                      // retainDays(기본 7) 지난 office-*.log 삭제
    readonly dir: string;
    errorsSince(ms: number): number;      // 이 프로세스가 ms 이후 쓴 error 수(칩의 빨간 점, doctor)
  }
  export function scrub(v: unknown, home: string): unknown;  // 문자열마다 redact() + home→"~", 객체·배열 재귀
  export function getLogger(): Logger;     // setLogger 전에는 기록하지 않는 NullLogger(테스트 기본)
  export function setLogger(l: Logger): void;
  // server/paths.ts
  export interface OfficePaths { mode: "installed" | "dev"; prefix: string | null; logDir: string; diagDir: string; staticDir: string }
  export function resolvePaths(opts: { moduleUrl: string; env: NodeJS.ProcessEnv; logDir?: string }): OfficePaths;
  ```
- `CliOptions`에 `logDir?: string` 추가.

- [ ] **Step 1: 실패하는 테스트**

`test/server/log.test.ts`(임시 폴더에 쓰고 파일을 읽어 JSON.parse로 확인):
- `한 줄에 JSON 하나, t·level·src·msg·data 필드` — `new Logger({dir, now: () => Date.UTC(2026,9,1,3)})`, `info("server","start",{port:4318})` → `office-2026-10-01.log`의 줄 1개, `{t:"2026-10-01T03:00:00.000Z",level:"info",src:"server",msg:"start",data:{port:4318}}`.
- `msg와 data의 가짜 비밀값과 홈 경로를 가린다` — home `/Users/fakeuser`, `error("collect","read /Users/fakeuser/.claude/x failed", {cmd:"curl -H 'Authorization: Bearer FAKE-TOKEN-abc123'", nested:["api_key=FAKEKEY123"]})` → 파일 전체 문자열에 `fakeuser`, `FAKE-TOKEN-abc123`, `FAKEKEY123`이 없고 `~/.claude/x`가 있다.
- `같은 warn은 10분에 한 번, 억제 건수를 붙인다` — 시계를 조작해 같은 warn 5번(0~9분) → 1줄, 10분 1초 뒤 한 번 더 → 2번째 줄 `data.suppressed === 4`. 다른 msg의 warn은 억제되지 않는다. error는 억제하지 않는다.
- `5MB에 닿으면 그날은 더 쓰지 않는다` — `maxBytes: 300`, 긴 info 20번 → 마지막 줄이 `msg:"log cap reached"`이고 그 뒤 기록 없음, 파일 크기 ≤ 300 + 마지막 줄 길이. 다음 날짜(시계 +1일)에는 새 파일에 다시 쓴다.
- `7일 지난 로그를 지운다` — `office-2026-09-23.log`, `office-2026-09-25.log`, `other.txt`를 만들고 now=10-01 `cleanup()` → 09-23만 삭제(8일 전), 09-25·other.txt 유지.
- `폴더가 없으면 만든다, 쓰기 실패는 던지지 않는다` — dir에 일반 파일 경로를 주면 `info` 호출이 예외 없이 끝난다.
- `getLogger 기본값은 아무 것도 쓰지 않는다`.

`test/server/paths.test.ts`:
- `CLAUDE_OFFICE_PREFIX가 있으면 installed` — `resolvePaths({moduleUrl:"file:///x/app/app/server.mjs", env:{CLAUDE_OFFICE_PREFIX:"/p"}})` → `{mode:"installed", prefix:"/p", logDir:"/p/logs", diagDir:"/p/diagnostics", staticDir:"/x/app/app/web"}`.
- `없으면 dev, 저장소 .logs` — moduleUrl `file:///repo/server/paths.ts` → `logDir:"/repo/.logs"`, `diagDir:"/repo/.logs/diagnostics"`, `staticDir:"/repo/dist/web"`.
- `--log-dir는 로그 폴더만 바꾼다`.

`test/server/cli.test.ts`에 `--log-dir ~/x`가 `logDir`(홈 전개)로 들어오는 케이스 추가.

- [ ] **Step 2: 실패 확인** — `npx vitest run test/server/log.test.ts test/server/paths.test.ts test/server/cli.test.ts` → FAIL(모듈 없음)

- [ ] **Step 3: 구현**

`server/log.ts` 뼈대(동기 파일 API — 로거는 종료 직전에도 불리므로 `appendFileSync`):
```ts
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./events/summarize";

export type Level = "info" | "warn" | "error";
export interface LogLine { t: string; level: Level; src: string; msg: string; data?: Record<string, unknown> }
export interface LoggerOptions { dir: string; now?: () => number; home?: string; maxBytes?: number; retainDays?: number; dedupeMs?: number }

const DAY = 86_400_000;
const FILE = /^office-(\d{4}-\d{2}-\d{2})\.log$/;

export function scrub(v: unknown, home: string): unknown {
  if (typeof v === "string") return redact(home ? v.split(home).join("~") : v);
  if (Array.isArray(v)) return v.map((x) => scrub(x, home));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, home)]));
  return v;
}

export class Logger {
  readonly dir: string;
  private readonly now: () => number;
  private readonly home: string;
  private readonly maxBytes: number;
  private readonly retainDays: number;
  private readonly dedupeMs: number;
  private capped = "";                       // 한도에 닿은 날짜
  private warned = new Map<string, { at: number; suppressed: number }>();
  private errors: number[] = [];

  constructor(o: LoggerOptions) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
    this.home = o.home ?? homedir();
    this.maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
    this.retainDays = o.retainDays ?? 7;
    this.dedupeMs = o.dedupeMs ?? 10 * 60_000;
  }
  info(src: string, msg: string, data?: Record<string, unknown>) { this.write("info", src, msg, data); }
  error(src: string, msg: string, data?: Record<string, unknown>) { this.errors.push(this.now()); this.write("error", src, msg, data); }
  warn(src: string, msg: string, data?: Record<string, unknown>) {
    const key = `${src}\u0000${msg}`;
    const w = this.warned.get(key);
    const now = this.now();
    if (w && now - w.at < this.dedupeMs) { w.suppressed++; return; }
    this.warned.set(key, { at: now, suppressed: 0 });
    this.write("warn", src, msg, w?.suppressed ? { ...data, suppressed: w.suppressed } : data);
  }
  errorsSince(ms: number) { return this.errors.filter((t) => t >= ms).length; }
  cleanup() {
    try {
      const cutoff = this.now() - this.retainDays * DAY;
      for (const f of readdirSync(this.dir)) {
        const m = FILE.exec(f);
        if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) unlinkSync(join(this.dir, f));
      }
    } catch { /* 폴더가 없으면 지울 것도 없다 */ }
  }
  private write(level: Level, src: string, msg: string, data?: Record<string, unknown>) {
    const t = new Date(this.now()).toISOString();
    const day = t.slice(0, 10);
    if (this.capped === day) return;
    const file = join(this.dir, `office-${day}.log`);
    const line: LogLine = { t, level, src, msg: scrub(msg, this.home) as string, ...(data ? { data: scrub(data, this.home) as Record<string, unknown> } : {}) };
    try {
      mkdirSync(this.dir, { recursive: true });
      let size = 0;
      try { size = statSync(file).size; } catch { /* 새 파일 */ }
      const text = JSON.stringify(line) + "\n";
      if (size + text.length > this.maxBytes) {
        this.capped = day;
        appendFileSync(file, JSON.stringify({ t, level: "warn", src: "log", msg: "log cap reached" }) + "\n");
        return;
      }
      appendFileSync(file, text);
    } catch { /* 로그 실패로 서버를 멈추지 않는다 */ }
  }
}

// dir이 ""이면 write 첫 줄에서 return한다(`if (!this.dir) return;`) — setLogger 전 기본값과 테스트용
let current: Logger | undefined;
export const setLogger = (l: Logger) => { current = l; };
export const getLogger = (): Logger => (current ??= new Logger({ dir: "" }));
```

`server/paths.ts`:
```ts
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface OfficePaths { mode: "installed" | "dev"; prefix: string | null; logDir: string; diagDir: string; staticDir: string }

export function resolvePaths(o: { moduleUrl: string; env: NodeJS.ProcessEnv; logDir?: string }): OfficePaths {
  const here = dirname(fileURLToPath(o.moduleUrl));
  // 묶음(server.mjs) 옆에는 web/, 저장소에서는 server/../dist/web
  const staticDir = basename(fileURLToPath(o.moduleUrl)) === "server.mjs" ? join(here, "web") : resolve(here, "../dist/web");
  const prefix = o.env.CLAUDE_OFFICE_PREFIX || null;
  const base = prefix ? { logDir: join(prefix, "logs"), diagDir: join(prefix, "diagnostics") }
    : { logDir: resolve(here, "../.logs"), diagDir: resolve(here, "../.logs/diagnostics") };
  return { mode: prefix ? "installed" : "dev", prefix, staticDir, ...base, ...(o.logDir ? { logDir: resolve(o.logDir) } : {}) };
}
```
주의: 묶음에서는 `import.meta.url`이 `server.mjs`이므로 `index.ts`가 `resolvePaths({moduleUrl: import.meta.url, …})`를 부르면 된다. dev에서는 `server/index.ts`의 URL이라 `here`가 `server/`다(paths.ts의 URL이 아니라 **index.ts의 URL**을 넘긴다).

`server/index.ts`: `parseArgs`에 `"log-dir": { type: "string" }`(expandHome), `main()` 첫머리에서 `resolvePaths` → `const log = new Logger({ dir: paths.logDir }); setLogger(log); log.cleanup();` → `log.info("server","start",{version, node: process.version, platform: process.platform, port, mode})`(version은 `package.json`을 `import pkg from "../package.json" with { type: "json" }`로), `process.on("exit")`/`SIGINT`/`SIGTERM`에서 `log.info("server","exit",{code})`. EADDRINUSE는 `console.error` 유지 + `log.error("server","port in use",{port})`. 콘솔 출력은 사람이 보는 것이라 남기고, 로그에는 같은 사건을 따로 기록한다.

`server/app.ts`의 hook 처리 실패, `server/hub.ts`의 감시 오류·스냅샷 실패, `server/snapshot.ts` guard의 `console.warn`을 `getLogger().warn|error(src, msg, {error: (e as Error).message})`로 바꾼다(콘솔 출력은 지운다 — 3초마다 반복되므로). src 이름: `hooks`, `hub`, `snapshot`.

`.gitignore`에 세 줄 추가:
```
.logs/
release/
beta-feedback/
```

- [ ] **Step 4: 통과 확인** — 위 테스트 + `npm test`, `npm run typecheck` 통과.
- [ ] **Step 5: 커밋** — `git add server/log.ts server/paths.ts server/index.ts server/app.ts server/hub.ts server/snapshot.ts .gitignore test/server/log.test.ts test/server/paths.test.ts test/server/cli.test.ts && git commit -m "feat(beta): JSON Lines logger with redaction, retention, cap and warn dedupe; install/dev paths"`

---

### Task 2: 견고성 수정과 hook 통계 (qa)

**Files:**
- Create: `server/events/stats.ts`
- Modify: `server/index.ts`(Node 검사, 포트 경고, stats 연결), `server/app.ts`(빌드 없음 안내, 통계 기록 지점), `server/hub.ts`(첫 빌드 실패), `server/snapshot.ts`(`emptySnapshot` export, `.catch(() => null)` 3곳 로그), `server/collectors/teams.ts`, `server/collectors/usage.ts`, `server/collectors/limits.ts`, `server/config.ts`의 빈 catch
- Test: `test/server/stats.test.ts`, `test/server/robust.test.ts`, `test/server/hooks-route.test.ts`(통계 케이스)

**Interfaces:**
- Consumes: `getLogger()` (Task 1)
- Produces:
  ```ts
  // server/events/stats.ts
  export type Rejected = "403" | "415" | "413" | "400";
  export interface HookStatsView { total: number; byEvent: Record<string, number>; lastAt: string | null; rejected: Record<Rejected, number>; last10min: number }
  export class HookStats {
    constructor(now?: () => number);
    accept(eventName: string): void;
    reject(kind: Rejected): void;
    view(): HookStatsView;
    summarize(): void;          // 직전 요약 이후 바뀌었을 때만 getLogger().info("hooks","summary",view)
  }
  // server/app.ts
  createApp(hub, opts: { staticDir?; heartbeatMs?; onHookEvent?; stats?: HookStats; diagnostics?: DiagnosticsDeps /* Task 5 */ })
  // server/snapshot.ts
  export function emptySnapshot(now: number, config: OfficeConfig, error?: string): Snapshot;
  // server/hub.ts
  export interface HubOptions { …; fallback?: (e: unknown) => Snapshot }   // 첫 빌드 실패 때 쓸 스냅샷
  export function checkNode(version: string): string | null;   // server/index.ts, 24 미만이면 안내 문구
  ```

- [ ] **Step 1: 실패하는 테스트**

`test/server/stats.test.ts`:
- `이벤트별 수, 마지막 시각, 거부 수` — accept("PreToolUse")×2, accept("Stop"), reject("403"), reject("413") → `{total:3, byEvent:{PreToolUse:2,Stop:1}, rejected:{403:1,415:0,413:1,400:0}, lastAt:<ISO>}`.
- `last10min은 10분 안의 수신만` — 시계 조작.
- `summarize는 바뀌었을 때만 로그` — 임시 폴더 Logger를 `setLogger`, summarize 2번(변화 없음) → 줄 1개, accept 뒤 summarize → 줄 2개.

`test/server/hooks-route.test.ts`에 `stats`를 넘겨: 정상 200 → accept(이벤트명), Origin 있음 → rejected 403, text/plain → 415, 2MB → 413, 잘못된 JSON·검증 실패 → 400이 각각 1씩 는다.

`test/server/robust.test.ts`:
- `checkNode` — `"v22.1.0"` → 문자열에 `Node.js 24` 포함, `"v24.0.0"`·`"v26.1.0"` → null.
- `빌드 파일이 없으면 안내 HTML과 error 로그` — `createApp(hub, {staticDir: <빈 임시 폴더>})`에 `GET /` → 200(또는 503), `text/html`, 본문에 `화면 파일이 없습니다 — 다시 설치해 주세요`. 로그 파일에 `level:"error"`, `msg:"static files missing"` 한 줄. `GET /api/snapshot`은 그대로 JSON.
- `첫 빌드가 실패해도 /api/snapshot은 200과 error` — builder.build가 throw하는 hub에 `fallback: (e) => emptySnapshot(Date.now(), {budget:{}} as OfficeConfig, "데이터를 읽지 못했습니다")`, `start()` 뒤 `current()`가 throw하지 않고 `error`를 가진다. createApp에 물려 `GET /api/snapshot` → 200, `error` 필드 있음.
- `빈 catch 대신 warn 로그` — 대표로 `readTeams`에 깨진 config.json(fakeHome) → 결과는 기존과 같고(건너뜀) 로그에 `src:"teams"` warn 한 줄. `loadConfig`에 깨진 JSON 파일 → 기본값 + `src:"config"` warn.

- [ ] **Step 2: 실패 확인** — `npx vitest run test/server/stats.test.ts test/server/robust.test.ts test/server/hooks-route.test.ts` → FAIL

- [ ] **Step 3: 구현**

`server/events/stats.ts`:
```ts
import { getLogger } from "../log";

export type Rejected = "403" | "415" | "413" | "400";
export interface HookStatsView { total: number; byEvent: Record<string, number>; lastAt: string | null; rejected: Record<Rejected, number>; last10min: number }

const TEN_MIN = 10 * 60_000;

export class HookStats {
  private byEvent: Record<string, number> = {};
  private rejected: Record<Rejected, number> = { "403": 0, "415": 0, "413": 0, "400": 0 };
  private times: number[] = [];   // 최근 10분 수신 시각
  private total = 0;
  private lastAt: number | null = null;
  private lastSummary = "";
  constructor(private readonly now: () => number = Date.now) {}
  accept(name: string) {
    const t = this.now();
    this.byEvent[name] = (this.byEvent[name] ?? 0) + 1;
    this.total++;
    this.lastAt = t;
    this.times.push(t);
    while (this.times.length && this.times[0] < t - TEN_MIN) this.times.shift();
  }
  reject(kind: Rejected) { this.rejected[kind]++; }
  view(): HookStatsView {
    const since = this.now() - TEN_MIN;
    return { total: this.total, byEvent: { ...this.byEvent }, lastAt: this.lastAt === null ? null : new Date(this.lastAt).toISOString(),
      rejected: { ...this.rejected }, last10min: this.times.filter((t) => t >= since).length };
  }
  summarize() {
    const v = this.view();
    const key = JSON.stringify([v.total, v.rejected]);
    if (key === this.lastSummary) return;
    this.lastSummary = key;
    getLogger().info("hooks", "summary", { ...v });
  }
}
```
`index.ts`에서 `setInterval(() => stats.summarize(), 60_000).unref()`.

`server/app.ts`: `/hooks/event` 403·415·400 분기와 오류 미들웨어(413/400)에서 `opts.stats?.reject(...)`, 성공 시 `opts.stats?.accept(body.hook_event_name)`. 정적 폴더:
```ts
if (staticDir && existsSync(join(staticDir, "index.html"))) { /* 기존 */ }
else if (staticDir) {
  getLogger().error("server", "static files missing", { staticDir });
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.status(503).type("html").send('<!doctype html><meta charset="utf-8"><title>Claude Agent Office</title><p>화면 파일이 없습니다 — 다시 설치해 주세요</p>');
  });
}
```
(staticDir를 안 넘기는 기존 테스트는 영향 없음.)

`server/hub.ts`: `refresh()`의 catch에서 `getLogger().error("hub","snapshot build failed",{error})`, 그리고 `if (!this.snapshot && this.opts.fallback) { this.snapshot = this.opts.fallback(e); for (const l of this.listeners) l(this.snapshot); }`. `index.ts`가 `fallback: () => emptySnapshot(Date.now(), config, "데이터를 읽지 못했습니다 — 진단 패널을 확인해 주세요")`를 넘긴다.

`server/index.ts`:
```ts
export function checkNode(version: string): string | null {
  const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
  return major >= 24 ? null : `Claude Agent Office는 Node.js 24 이상이 필요합니다(지금 ${version}). https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행해 주세요.`;
}
```
`main()` 첫 줄에서 검사 → 메시지 `console.error` + (로거가 있으면) error 로그 + `process.exit(1)`. 포트가 4317이 아니면 `log.warn("server","port is not 4317; plugin hooks go to 4317",{port})`와 콘솔 한 줄.

빈 catch → warn(한 곳에 한 줄, `{error: (e as Error).message}` 또는 `{file: basename(path)}` — **파일 이름만, 폴더 경로·세션명·팀 이름은 넣지 않는다**): teams.ts 31,41,55,64,96,115,126 / usage.ts 24,45,60 / limits.ts 49 / config.ts 16 / snapshot.ts `.catch(() => null)` 3곳. 의도적으로 "없으면 건너뜀"인 ENOENT는 warn하지 않는다(`(e as NodeJS.ErrnoException).code === "ENOENT"`면 조용히). sessions.ts는 Task 3(developer)이 맡는다.

- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`, `npm run typecheck`.
- [ ] **Step 5: 커밋** — `git add server/events/stats.ts server/index.ts server/app.ts server/hub.ts server/snapshot.ts server/collectors/teams.ts server/collectors/usage.ts server/collectors/limits.ts server/config.ts test/server/stats.test.ts test/server/robust.test.ts test/server/hooks-route.test.ts && git commit -m "feat(beta): hook stats, Node check, missing-build page, first-snapshot fallback, logged catches"`

---

### Task 3: Windows와 Linux 호환 (developer, Task 1 뒤)

**Files:**
- Modify: `server/collectors/sessions.ts`, `scripts/statusline-setup.mjs`
- Test: `test/server/sessions.test.ts`, `test/scripts/statusline.test.ts`

**Interfaces:**
- Consumes: `getLogger()` (Task 1)
- Produces: `readSessions(claudeHome, now, isAlive, platform?: NodeJS.Platform)` — 마지막 인자는 테스트용(기본 `process.platform`). 기존 호출 그대로 동작.

- [ ] **Step 1: 실패하는 테스트**
- `sessions.test.ts`: `platform "win32"이면 ps를 부르지 않고 pid 생존만으로 판정` — `execFile`를 `vi.mock("node:child_process")`로 감시, win32 → 호출 0회, 살아 있는 pid 세션은 alive. 기존 darwin/linux 케이스는 그대로 통과.
- `sessions.test.ts`: `읽을 수 없는 세션 파일은 건너뛰고 warn 한 줄` — 깨진 JSON → 결과에서 빠지고 임시 로그에 `src:"sessions"` warn. 로그에 세션 파일의 폴더 경로가 없다(파일 이름만).
- `statusline.test.ts`: `Windows에서는 지원하지 않는다고 알리고 설정을 바꾸지 않는다` — `STATUSLINE_PLATFORM=win32`(테스트용 환경변수, 기본 `process.platform`)와 임시 `CLAUDE_CONFIG_DIR`로 `install` 실행 → 종료 코드 0, 출력에 `Windows에서는 아직 지원하지 않습니다`, settings.json 변화 없음.

- [ ] **Step 2: 실패 확인** — `npx vitest run test/server/sessions.test.ts test/scripts/statusline.test.ts` → FAIL
- [ ] **Step 3: 구현**
  - `sessions.ts`의 `ps -o lstart=` 경로(51행 근처): `if (platform === "win32") return undefined;` 판단 불가로 돌려 호출자가 pid 생존(`process.kill(pid, 0)`)만 쓰게 한다. 해당 줄에 `// ponytail: Windows에는 ps가 없어 pid 재사용을 못 가린다 — 필요하면 wmic/Get-Process로 시작 시각 비교` 주석.
  - 빈 catch(27, 56, 90, 101, 119)를 Task 2와 같은 규칙으로: ENOENT는 조용히, 나머지는 `getLogger().warn("sessions", "<무엇> 실패", { file: basename(p), error: (e as Error).message })`. 56행(ps 실패)은 "판단 불가"가 정상 경로이므로 로그하지 않는다.
  - `statusline-setup.mjs`: 맨 아래 dispatch 앞에 `if ((process.env.STATUSLINE_PLATFORM || process.platform) === "win32") { console.log("PLAN 바(statusline 연동)는 Windows에서는 아직 지원하지 않습니다."); process.exit(0); }`.
  - 경로 조합이 `path.join`/`os.homedir()`만 쓰는지 `grep -rn "'/'\|\"/\"\|\`/" server scripts`로 확인하고 문자열 `/` 결합이 있으면 `join`으로.
- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`, `npm run typecheck`.
- [ ] **Step 5: 커밋** — `git add server/collectors/sessions.ts scripts/statusline-setup.mjs test/server/sessions.test.ts test/scripts/statusline.test.ts && git commit -m "feat(beta): Windows-safe session liveness, statusline unsupported notice, logged session catches"`

---

### Task 4: doctor (qa)

**Files:**
- Create: `server/diag/doctor.ts`
- Modify: `server/index.ts`(하위 명령 `doctor [--json]`)
- Test: `test/server/doctor.test.ts`

**Interfaces:**
- Consumes: `resolvePaths` (Task 1), `HookStatsView` (Task 2)
- Produces:
  ```ts
  export type Status = "ok" | "warn" | "fail";
  export interface DoctorItem { id: string; status: Status; title: string; detail: string; fix: string }
  export interface DoctorDeps {
    claudeHome: string; paths: OfficePaths; port: number;
    nodeVersion?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
    managedPath?: string;                                   // 기본: 플랫폼별 경로
    which?: (cmd: string) => string | null;                 // 기본: PATH 탐색
    probePort?: (port: number) => Promise<"ours" | "other" | "free">;  // 기본: GET /api/snapshot
    hooks?: () => Promise<HookStatsView | null>;            // 서버 안: stats.view(), CLI: /api/diagnostics 조회(Ruling B5)
    now?: () => number;
  }
  export async function runDoctor(d: DoctorDeps): Promise<DoctorItem[]>;
  export function formatDoctor(items: DoctorItem[]): string;   // ✅/⚠️/❌ 줄 + 고칠 방법
  export const MANAGED_PATHS: Record<"darwin" | "linux" | "win32", string>;
  ```
  항목 id 순서: `node, app, port, claude_home, claude_cli, plugin, managed, proxy, hooks, statusline`.

- [ ] **Step 1: 실패하는 테스트** (`test/server/doctor.test.ts`, fakeHome + 의존성 주입, 실제 네트워크·실제 `~/.claude` 없음)
  - `node` — `v22.0.0` → fail, `v24.1.0` → ok.
  - `app` — staticDir에 index.html 없음 → fail("다시 설치").
  - `port` — probe `ours` → ok, `other` → fail("다른 프로그램이 4317을 쓰고 있습니다"), `free` → warn("서버가 꺼져 있습니다"). port≠4317 → warn(hook은 4317로 감).
  - `claude_home` — 폴더 없음 → fail, `sessions/`·`projects/` 있음 → ok, detail에 **개수만**(`세션 2개, 프로젝트 3개`).
  - `claude_cli` — which null → warn, 경로 → ok. detail에 경로를 넣지 않는다(`있음`).
  - `plugin` — settings.json `enabledPlugins`에 `"claude-office@claude-office": true` → ok, 없음 → warn(설치 명령을 fix에). **settings.json의 다른 키 값이 결과 어디에도 나오지 않는다**(가짜 `env: {ANTHROPIC_API_KEY: "FAKE-sk-ant-xxx"}`를 넣고 JSON.stringify(items)에 없음 확인).
  - `managed` — 파일 없음 → ok("없음"), `allowManagedHooksOnly: true`이고 enabledPlugins에 claude-office 없음 → fail, `allowedHttpHookUrls`에 `http://127.0.0.1:4317/*` 계열이 없으면 fail, 있으면 ok. 다른 키(가짜 비밀값) 미노출.
  - `proxy` — `HTTP_PROXY` 있고 `NO_PROXY`에 127.0.0.1/localhost 없음 → warn, 있으면 ok, 프록시 없음 → ok. detail에 프록시 **주소를 넣지 않는다**.
  - `hooks` — `hooks()` null → warn("서버가 꺼져 있어 확인하지 못했습니다"), last10min 0이고 total 0 → warn(플러그인 안내), >0 → ok(`최근 10분 N건`), rejected 합>0 → warn.
  - `statusline` — `claude-office/rate-limits.json` 없음 → warn(선택 기능), 1시간 안 → ok, 오래됨 → warn.
  - `자격 증명 파일을 열지 않는다` — `fs.readFile`/`readFileSync`를 감시해 `.credentials.json`, `.key`로 끝나는 경로 호출 0.
  - `formatDoctor` — ok/warn/fail이 `✅`/`⚠️`/`❌`로 시작하고, warn·fail 줄 아래에 `  → <fix>`.

- [ ] **Step 2: 실패 확인** — `npx vitest run test/server/doctor.test.ts` → FAIL
- [ ] **Step 3: 구현** — 항목별 작은 함수(`async (d) => DoctorItem`)의 배열을 `Promise.all`. 설정 파일은 `JSON.parse` 뒤 **필요한 키만 꺼낸다**(`const { enabledPlugins } = parsed`). `MANAGED_PATHS`:
  ```ts
  export const MANAGED_PATHS = {
    darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
    linux: "/etc/claude-code/managed-settings.json",
    win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
  };
  ```
  기본 `probePort`: `fetch(\`http://127.0.0.1:${port}/api/snapshot\`, { signal: AbortSignal.timeout(1500) })` → JSON에 `generatedAt`이 있으면 `ours`, 응답은 있는데 아니면 `other`, 연결 거부면 `free`. 기본 `which`: `env.PATH`를 `path.delimiter`로 나눠 `claude`(win32는 `claude.cmd`·`claude.exe`)가 있는지 `existsSync`.
  `index.ts`: `argv[0] === "doctor"`이면 `runDoctor`(hooks는 `fetch /api/diagnostics`의 `.hooks`, 실패 시 null) → `--json`이면 `JSON.stringify(items, null, 2)`, 아니면 `formatDoctor`. 종료 코드: fail이 있으면 1, 아니면 0. 서버는 켜지 않는다.
- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`, `npm run typecheck`, 그리고 `npx tsx server/index.ts doctor --claude-home <fakeHome> --port 4399`가 예외 없이 표를 출력(4317 조회는 probe로 읽기만 — 4317 서버를 끄거나 쓰지 않는다. 테스트에서는 `--port 4399` 사용).
- [ ] **Step 5: 커밋** — `git add server/diag/doctor.ts server/index.ts test/server/doctor.test.ts && git commit -m "feat(beta): doctor checks shared by CLI"`

---

### Task 5: 진단 파일과 진단 API (qa)

**Files:**
- Create: `server/diag/bundle.ts`
- Modify: `server/app.ts`(`GET /api/diagnostics`, `POST /api/diagnostics/bundle`, `GET /api/diagnostics/files/:name`), `server/index.ts`(하위 명령 `diag`, deps 연결)
- Test: `test/server/bundle.test.ts`, `test/server/diag-api.test.ts`

**Interfaces:**
- Consumes: `Logger`, `scrub`, `OfficePaths` (Task 1), `HookStats` (Task 2), `runDoctor` (Task 4)
- Produces:
  ```ts
  // server/diag/bundle.ts
  export interface DiagBundle {
    kind: "claude-office-diag"; format: 1; createdAt: string;
    versions: { app: string; node: string; platform: string; arch: string; claude: string | null };
    doctor: DoctorItem[]; hooks: HookStatsView;
    snapshot: { sessions: number; members: number; teams: number; decisions: number; error: boolean };
    logs: Array<{ file: string; lines: string[] }>;   // 최근 7일, 새 파일이 앞
    truncated: boolean;
  }
  export async function buildBundle(d: { doctor: () => Promise<DoctorItem[]>; hooks: HookStatsView; snapshot: Snapshot; logDir: string; home?: string; now?: () => number; appVersion: string; claudeVersion?: string | null; maxBytes?: number }): Promise<DiagBundle>;
  export async function writeBundle(dir: string, b: DiagBundle): Promise<string>;   // 반환: 파일 이름(경로 아님)
  // server/app.ts
  export interface DiagnosticsDeps { summary(): Promise<DiagnosticsSummary>; makeBundle(): Promise<string>; diagDir: string }
  export interface DiagnosticsSummary { doctor: DoctorItem[]; hooks: HookStatsView; errorsLastHour: number; logDir: string /* "~" 치환 */ }
  export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean;   // Ruling B1
  ```
  API:
  - `GET /api/diagnostics` → `DiagnosticsSummary` JSON (Task 10 화면이 소비).
  - `POST /api/diagnostics/bundle` → `201 {file: "claude-office-diag-20261001-123456.json"}`. 요청 본문은 읽지 않는다(빈 `{}` 허용).
  - `GET /api/diagnostics/files/:name` → 이름이 `^claude-office-diag-\d{8}-\d{6}\.json$`일 때만 `diagDir`에서 `res.download`, 아니면 404.

- [ ] **Step 1: 실패하는 테스트**

`test/server/bundle.test.ts`:
- `진단 파일에 가짜 비밀값·홈 경로·세션·팀원 이름이 없다` — 임시 logDir에 가짜 비밀값·`/Users/fakeuser` 경로가 섞인 로그 줄(로거를 거치지 않고 직접 쓴 줄 포함), snapshot에 세션명 `secret-project-x`·팀원 `alice-fake`·cwd `/Users/fakeuser/work` → `JSON.stringify(bundle)`에 `FAKE`, `fakeuser`, `secret-project-x`, `alice-fake`가 없다. snapshot 부분은 숫자만.
- `5MB를 넘으면 오래된 로그부터 버린다` — `maxBytes: 2000`, 로그 3일치 → 가장 오래된 날짜 파일이 빠지고 `truncated: true`, 결과 JSON 크기 ≤ 2000.
- `7일 넘은 로그는 넣지 않는다`.
- `writeBundle은 dir 안에만 쓰고 이름만 돌려준다` — 반환값에 `/`·`\\`가 없고 파일이 dir에 존재.

`test/server/diag-api.test.ts`(createApp에 가짜 `DiagnosticsDeps`):
- `GET /api/diagnostics`는 요약 JSON.
- `같은 출처 버튼 요청은 201` — Host `127.0.0.1:PORT`, Origin `http://127.0.0.1:PORT`, `Content-Type: application/json` → 201과 `{file}`.
- `Origin이 없어도 201`(CLI·curl).
- `다른 출처 Origin·JSON 아닌 요청·경로 조작을 거부한다` — Origin `http://evil.example` → 403, Origin `http://localhost:5173`와 Host `127.0.0.1:PORT`(포트 다름) → 403, `text/plain` → 415, Host `evil.example` → 403(기존 미들웨어), `GET /api/diagnostics/files/..%2F..%2Fetc%2Fpasswd` → 404, `GET /api/diagnostics/files/other.json` → 404. 거부된 요청마다 `makeBundle` 호출 0.
- `isSameOrigin` 단위: `("http://127.0.0.1:4317","127.0.0.1:4317")` true, `("http://localhost:4317","localhost:4317")` true, `("http://[::1]:4317","[::1]:4317")` true, `(undefined, …)` true, `("null", …)` false, `("http://evil.example:4317","evil.example:4317")` false, 잘못된 URL false.

- [ ] **Step 2: 실패 확인** — `npx vitest run test/server/bundle.test.ts test/server/diag-api.test.ts` → FAIL
- [ ] **Step 3: 구현**

`isSameOrigin`(app.ts, Ruling B1):
```ts
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;              // CLI·curl — Host 검사는 앞 미들웨어가 이미 했다
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && !!host && u.host.toLowerCase() === host.trim().toLowerCase() && isAllowedHost(u.host);
  } catch {
    return false;
  }
}
```
라우트:
```ts
if (opts.diagnostics) {
  const diag = opts.diagnostics;
  app.get("/api/diagnostics", async (_req, res) => res.json(await diag.summary()));
  app.post("/api/diagnostics/bundle", async (req, res) => {
    if (!isSameOrigin(req.headers.origin, req.headers.host)) return void res.status(403).end();
    if (!req.is("application/json")) return void res.status(415).end();
    try { res.status(201).json({ file: await diag.makeBundle() }); }
    catch (e) { getLogger().error("diag", "bundle failed", { error: (e as Error).message }); res.status(500).json({ error: "진단 파일을 만들지 못했습니다" }); }
  });
  app.get("/api/diagnostics/files/:name", (req, res) => {
    const name = req.params.name;
    if (!/^claude-office-diag-\d{8}-\d{6}\.json$/.test(name)) return void res.status(404).end();
    res.download(join(diag.diagDir, name), name, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });
}
```
(`POST` 라우트는 SPA fallback보다 앞에 둔다. 본문을 파싱하지 않으므로 `express.json`을 붙이지 않는다.)

`buildBundle`: logDir의 `office-YYYY-MM-DD.log` 중 7일 안의 파일을 새것부터 읽어 줄 배열로(각 줄을 `scrub`), snapshot은 `sessions.length`, `members` 합, 팀 있는 세션 수, `decisionCount`, `!!error`만. 마지막에 `const out = scrub(bundle, home)` 후 `JSON.stringify(out).length`가 maxBytes(기본 5MB)를 넘으면 `logs`의 마지막(가장 오래된) 원소를 빼며 반복, `truncated = true`. `writeBundle`: 이름 `claude-office-diag-${yyyymmdd}-${hhmmss}.json`(로컬 시각), `mkdir(dir,{recursive:true})`, `writeFile(join(dir, name), JSON.stringify(out, null, 2), { flag: "wx" })`(같은 초에 두 번이면 `-2` 접미 대신 1초 뒤 재시도 없이 `EEXIST` → 500 — Ruling 가능).

`index.ts`: deps를 조립해 `createApp(hub, {…, stats, diagnostics})`. 하위 명령 `diag`: 서버가 켜져 있으면 `POST /api/diagnostics/bundle`(Origin 없이) 결과 파일 이름을, 꺼져 있으면 직접 `buildBundle`(snapshot은 `SnapshotBuilder.build()` 한 번, hooks는 빈 통계) → `writeBundle(paths.diagDir)` 후 **전체 경로를 콘솔에** 출력(사용자 자신의 PC 화면이라 경로 표시는 괜찮다. 파일 안에는 없음).

- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`, `npm run typecheck`. 수동: `CLAUDE_OFFICE_PREFIX=$CLAUDE_JOB_DIR/tmp/p npx tsx server/index.ts diag --claude-home <fakeHome> --port 4399` → `<prefix>/diagnostics/`에 파일, 저장소에 새 파일 없음(`git status`).
- [ ] **Step 5: 커밋** — `git add server/diag/bundle.ts server/app.ts server/index.ts test/server/bundle.test.ts test/server/diag-api.test.ts && git commit -m "feat(beta): diagnostics summary API and redacted diagnostic bundle (API + CLI)"`

---

### Task 6: 서버 번들과 package:beta (developer)

**Files:**
- Create: `vite.server.config.ts`, `scripts/package-beta.mjs`
- Modify: `package.json`(version, scripts `build:server`, `package:beta`), `plugins/claude-office/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`(version), `tsconfig.json`(include에 `vite.server.config.ts`)
- Test: `test/scripts/package.test.ts`

**Interfaces:**
- Consumes: `resolvePaths`(Task 1 — `server.mjs` 이름으로 설치 모드 staticDir 판별)
- Produces: `release/claude-office-2.0.0-beta.1/` 폴더와 `release/claude-office-2.0.0-beta.1.tar.gz`, `.zip`. 폴더 구조(스펙 4장):
  ```
  claude-office-2.0.0-beta.1/
    app/server.mjs  app/web/  app/node_modules/  app/package.json
    plugin/.claude-plugin/marketplace.json  plugin/plugins/claude-office/…
    install.sh  install.ps1  사용설명서.html  LICENSE  THIRD_PARTY_NOTICES.md  VERSION
  ```
  `package-beta.mjs`는 `packaging/install.sh`, `packaging/install.ps1`, `packaging/claude-office.*`, `docs/manual/index.html`이 **있으면** 복사하고 없으면 경고만(Task 7·8·12가 나중에 채움). Task 13에서 전부 있는지 확인한다.

- [ ] **Step 1: 실패하는 테스트** (`test/scripts/package.test.ts`, 느린 테스트 — `testTimeout` 120초. `npm run package:beta`를 `execFileSync`로 한 번 돌리고 결과를 검사)
  - `버전 네 곳이 2.0.0-beta.1` — package.json, plugin.json, marketplace.json(플러그인 항목), 패키지 `VERSION`.
  - `폴더 구조` — 위 목록의 필수 파일(`app/server.mjs`, `app/web/index.html`, `app/node_modules/express/package.json`, `app/package.json`, `plugin/.claude-plugin/marketplace.json`, `plugin/plugins/claude-office/hooks/hooks.json`, LICENSE, THIRD_PARTY_NOTICES.md, VERSION).
  - `app/node_modules에 개발 의존성이 없다` — `vite`, `vitest`, `tsx`, `typescript`, `react` 폴더 없음(react는 웹 번들에 포함되므로 서버 런타임에 불필요).
  - `패키지만으로 서버가 켜진다` — 풀린 폴더를 임시 디렉터리로 복사, `node app/server.mjs --port <빈 포트> --claude-home <fakeHome> --log-dir <임시>`를 `env: { PATH: <node 폴더만>, HOME: <임시> }`로 실행(tsx·npm이 PATH에 없음) → `GET /`가 200 HTML, `GET /api/snapshot` 200 JSON. 끝나면 프로세스 kill.
  - `zip 안의 .ps1·.cmd는 CRLF, .sh는 LF` — zip을 풀어(`unzip -o`) 확인. install.ps1이 아직 없으면 건너뛴다(`it.skipIf`).
  - `tar.gz 안에 .map·.test.·.env 파일이 없다`.

- [ ] **Step 2: 실패 확인** — `npx vitest run test/scripts/package.test.ts` → FAIL
- [ ] **Step 3: 구현**

`vite.server.config.ts`:
```ts
import { defineConfig } from "vite";
export default defineConfig({
  build: {
    ssr: "server/index.ts",
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node24",
    rollupOptions: { output: { entryFileNames: "server.mjs", format: "es" } },
  },
  // 모두 묶되 express만 밖에 둔다(목록에 적은 external이 noExternal: true보다 우선한다)
  ssr: { noExternal: true, external: ["express"] },
});
```
(express만 외부로 두고 나머지 서버 코드는 한 파일로. `import.meta.url` 비교(`process.argv[1]`)가 번들에서도 성립하는지 확인 — 성립하지 않으면 `server/index.ts` 끝의 main 가드를 `basename(process.argv[1]) === "server.mjs"`까지 허용하게 qa에게 요청하지 말고 **Ruling으로 기록하고 developer가 한 줄 고친다**(Task 6 파일 집합에 `server/index.ts` 끝 줄 한정 추가).)

`scripts/package-beta.mjs` 단계:
1. `const v = pkg.version`; 버전 네 곳 불일치면 오류 종료.
2. `npm run build`(웹) → `npx vite build -c vite.server.config.ts`.
3. `release/claude-office-<v>/` 비우고 만든다. `dist/server/server.mjs` → `app/server.mjs`, `dist/web` → `app/web`.
4. 운영 의존성(Ruling B4): `execFileSync("npm", ["ls","--omit=dev","--all","--parseable"])`의 각 경로 중 `node_modules/` 아래이고 express 의존 트리에 속하는 것만 복사. 간단한 방법: `npm ls express --all --parseable --omit=dev`로 express와 하위 의존 경로를 얻어 `cp -R`(`fs.cpSync`). react·galmuri는 복사하지 않는다(웹 번들에 포함).
5. `app/package.json`: `{ "name":"claude-office-app", "version": v, "private": true, "type":"module", "engines":{"node":">=24"}, "dependencies":{"express": pkg.dependencies.express} }`.
6. `plugin/`: `.claude-plugin/marketplace.json`과 `plugins/claude-office/` 복사(마켓플레이스의 `source`가 `./plugins/claude-office`인지 확인).
7. 있으면 복사: `packaging/install.sh`(0755), `packaging/install.ps1`, `packaging/claude-office.sh`, `packaging/claude-office.cmd`, `packaging/claude-office.ps1`, `docs/manual/index.html` → `사용설명서.html`. LICENSE, THIRD_PARTY_NOTICES.md, `VERSION`(v + "\n").
8. `tar -czf release/claude-office-<v>.tar.gz -C release claude-office-<v>`.
9. zip: 임시 복사본에서 `*.ps1`, `*.cmd`를 CRLF로 바꾼 뒤 `zip -qr`(macOS·Linux 기본 `zip`. 없으면 오류 메시지).

`package.json`: `"version": "2.0.0-beta.1"`, `"build:server": "vite build -c vite.server.config.ts"`, `"package:beta": "node scripts/package-beta.mjs"`.

- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`, `npm run typecheck`, `npm run build`. `git status`에 `release/`가 안 보인다(.gitignore, Task 1).
- [ ] **Step 5: 커밋** — `git add vite.server.config.ts scripts/package-beta.mjs package.json package-lock.json plugins/claude-office/.claude-plugin/plugin.json .claude-plugin/marketplace.json tsconfig.json test/scripts/package.test.ts && git commit -m "feat(beta): single-file server bundle and package:beta (tar.gz/zip)"`

---

### Task 7: install.sh와 claude-office 명령 (developer)

**Files:**
- Create: `packaging/install.sh`, `packaging/claude-office.sh`
- Test: `test/scripts/install.test.ts`

**Interfaces:**
- Consumes: 패키지 구조(Task 6), 서버 CLI(`doctor`, `diag`, `--port`, `--log-dir`; Task 4·5), `CLAUDE_OFFICE_PREFIX`(Ruling B2)
- Produces:
  - `install.sh [--prefix DIR] [--yes] [--no-path] [--no-open]` — 패키지 폴더 안에서 실행(`$(dirname "$0")` 기준).
  - 설치 뒤 `<prefix>/bin/claude-office` = `claude-office.sh` 복사본(0755). 하위 명령: (없음)=서버 전경 실행 + 브라우저 열기, `doctor [--json]`, `diag`, `uninstall [--yes]`, `--version`. 나머지 인자는 서버에 그대로 넘긴다(`--port` 등).
  - rc 표지 줄: `# claude-office PATH` 다음 줄 `export PATH="<prefix>/bin:$PATH"`. 대상 파일: 로그인 셸이 zsh면 `$HOME/.zshrc`, bash면 `$HOME/.bashrc`(없으면 `$HOME/.profile`).

- [ ] **Step 1: 실패하는 테스트** (`test/scripts/install.test.ts`. 모든 케이스가 `HOME=<mkdtemp>`, `--prefix <임시>/.claude-office`, `--no-open`. 가짜 `claude`는 임시 `stub-bin/claude` 셸 스크립트로 인자를 파일에 기록만 한다(`echo "$@" >> $STUB_LOG`). `PATH=<stub-bin>:<node 폴더>:/usr/bin:/bin`. Task 6 패키지 폴더(`release/claude-office-<v>/`)가 없으면 `beforeAll`에서 `npm run package:beta`.)
  - `bash -n과 sh -n 문법 검사 통과` — install.sh, claude-office.sh.
  - `--no-path면 HOME의 셸 설정 파일을 만들지도 고치지도 않는다` — `--yes --no-path` 후 `$HOME/.zshrc`, `.bashrc`, `.profile`이 없다. 미리 만든 `.zshrc`(내용 `# mine`)는 바이트 그대로.
  - `설치 결과 구조` — `<prefix>/app/app/server.mjs`는 아니고 `<prefix>/app/server.mjs`, `<prefix>/bin/claude-office`(실행 권한), `<prefix>/logs/`, `<prefix>/diagnostics/`.
  - `재설치는 app만 바꾸고 logs·diagnostics는 남긴다` — logs에 파일 두고 재설치 → 남아 있음, app 안의 임의 파일은 사라짐.
  - `--yes면 플러그인 설치를 claude CLI로 요청한다` — STUB_LOG에 `plugin marketplace add <prefix>/app/../plugin 경로>`와 `plugin install claude-office@claude-office --scope user` 순서로 기록. (설치 위치: `<prefix>/plugin/`에 복사해 두고 그 경로를 marketplace add에 쓴다.) `CLAUDE_CONFIG_DIR`이 설정돼 있으면 그대로 넘어간다.
  - `claude가 없으면 플러그인 단계를 건너뛰고 안내만` — stub 없는 PATH → 종료 코드 0, 출력에 `나중에` 안내 문구와 명령.
  - `Node 24 미만이면 멈춘다` — 가짜 `node` stub(`echo v22.0.0`)이 앞선 PATH → 종료 코드 1, 출력에 `Node.js 24`.
  - `PATH 단계(--no-path 없이, HOME 임시)` — `SHELL=/bin/zsh --yes` → `$HOME/.zshrc`에 표지 줄 2줄, 두 번 설치해도 한 번만.
  - `claude-office doctor --json이 JSON 배열` — 설치본 `bin/claude-office doctor --json --port <빈 포트>` 출력이 JSON.parse 가능, `node` 항목 ok.
  - `claude-office가 서버를 켜고 로그를 prefix/logs에 쓴다` — `CLAUDE_OFFICE_NO_OPEN=1 bin/claude-office --port <빈 포트> --claude-home <fakeHome>` 백그라운드 → `/` 200, `<prefix>/logs/office-*.log`에 `"msg":"start"`. kill.
  - `uninstall --yes는 app·bin·plugin·rc 표지 줄을 지우고 logs·diagnostics는 묻는다(--yes면 지운다)` — STUB_LOG에 `plugin uninstall claude-office@claude-office --scope user`와 `plugin marketplace remove claude-office`, `.zshrc`의 표지 두 줄만 사라지고 `# mine`은 남는다, prefix 폴더 없음.

- [ ] **Step 2: 실패 확인** — `npx vitest run test/scripts/install.test.ts` → FAIL
- [ ] **Step 3: 구현** (POSIX sh, `set -eu`. bash 전용 문법 금지.)

`packaging/install.sh` 흐름:
```sh
#!/bin/sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX="$HOME/.claude-office"; YES=0; NOPATH=0; NOOPEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    --no-path) NOPATH=1; shift ;;
    --no-open) NOOPEN=1; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done
ask() { [ "$YES" = 1 ] && return 0; printf '%s [y/N] ' "$1"; read -r a; [ "$a" = y ] || [ "$a" = Y ]; }

# 1. Node 확인
command -v node >/dev/null 2>&1 || { echo "Node.js 24 이상이 필요합니다. https://nodejs.org 에서 LTS를 설치해 주세요." >&2; exit 1; }
major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$major" -ge 24 ] || { echo "Node.js 24 이상이 필요합니다(지금 $(node -v))." >&2; exit 1; }

# 2. 복사 — app·plugin만 교체, logs·diagnostics 유지
mkdir -p "$PREFIX/bin" "$PREFIX/logs" "$PREFIX/diagnostics"
rm -rf "$PREFIX/app" "$PREFIX/plugin"
cp -R "$HERE/app" "$PREFIX/app"
cp -R "$HERE/plugin" "$PREFIX/plugin"
cp "$HERE/VERSION" "$PREFIX/VERSION"
[ -f "$HERE/사용설명서.html" ] && cp "$HERE/사용설명서.html" "$PREFIX/사용설명서.html"
cp "$HERE/claude-office.sh" "$PREFIX/bin/claude-office"; chmod 755 "$PREFIX/bin/claude-office"

# 3. PATH
if [ "$NOPATH" = 0 ]; then
  case "${SHELL:-}" in */zsh) RC="$HOME/.zshrc" ;; *) RC="$HOME/.bashrc"; [ -f "$RC" ] || RC="$HOME/.profile" ;; esac
  if ! grep -q '^# claude-office PATH$' "$RC" 2>/dev/null && ask "$RC에 claude-office 명령 경로를 추가할까요?"; then
    printf '\n# claude-office PATH\nexport PATH="%s/bin:$PATH"\n' "$PREFIX" >> "$RC"
  fi
fi

# 4. 플러그인
if command -v claude >/dev/null 2>&1; then
  if ask "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보냅니다."; then
    claude plugin marketplace add "$PREFIX/plugin" || echo "마켓플레이스 등록 실패 — 사용설명서 5장을 봐 주세요."
    claude plugin install claude-office@claude-office --scope user || echo "플러그인 설치 실패 — 사용설명서 5장을 봐 주세요."
  fi
else
  echo "claude 명령을 찾지 못해 플러그인 설치를 건너뜁니다. 나중에:"
  echo "  claude plugin marketplace add \"$PREFIX/plugin\""
  echo "  claude plugin install claude-office@claude-office --scope user"
fi

# 5. doctor, 6. 사용설명서
"$PREFIX/bin/claude-office" doctor || true
if [ "$NOOPEN" = 0 ] && [ -f "$PREFIX/사용설명서.html" ]; then
  (open "$PREFIX/사용설명서.html" 2>/dev/null || xdg-open "$PREFIX/사용설명서.html" 2>/dev/null) || true
fi
echo "설치 완료. 새 터미널에서 claude-office 를 실행하세요."
```

`packaging/claude-office.sh` 흐름: `PREFIX=$(cd "$(dirname "$0")/.." && pwd)`; `export CLAUDE_OFFICE_PREFIX="$PREFIX"`; `case "$1"`:
- `doctor|diag` → `exec node "$PREFIX/app/server.mjs" "$@"`
- `--version` → `cat "$PREFIX/VERSION"`
- `uninstall` → (ask 함수 동일, `--yes` 인자) claude가 있으면 `claude plugin uninstall claude-office@claude-office --scope user`와 `claude plugin marketplace remove claude-office`(실패 무시) → rc 파일들(`.zshrc`, `.bashrc`, `.profile`)에서 표지 줄과 바로 다음 줄만 지움(`awk`로 새 파일에 쓰고 원자적으로 `mv`; 표지가 없으면 파일을 건드리지 않음) → `rm -rf app plugin bin VERSION 사용설명서.html` → `ask "로그와 진단 파일도 지울까요?"`면 logs·diagnostics와 prefix 폴더 삭제.
- 그 밖 → `CLAUDE_OFFICE_NO_OPEN`이 비어 있으면 `(sleep 1; open http://127.0.0.1:${port}/ || xdg-open …) &`(port는 인자의 `--port` 값, 기본 4317) → `exec node "$PREFIX/app/server.mjs" "$@"`.

- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`. **확인:** 테스트 전후로 `shasum ~/.claude/settings.json` 값 `84b304dd…` 동일, `~/.zshrc` 수정 시각 변화 없음.
- [ ] **Step 5: 커밋** — `git add packaging/install.sh packaging/claude-office.sh test/scripts/install.test.ts && git commit -m "feat(beta): install.sh and claude-office launcher (doctor, diag, uninstall)"`

---

### Task 8: install.ps1 (developer, 리뷰만)

**Files:**
- Create: `packaging/install.ps1`, `packaging/claude-office.ps1`, `packaging/claude-office.cmd`
- Test: `test/scripts/install-ps1.test.ts`(정적 검사)

**Interfaces:**
- Consumes: Task 7과 같은 단계·문구·플러그인 명령. 경로 `%USERPROFILE%\.claude-office\`.
- Produces: `install.ps1 [-Prefix DIR] [-Yes] [-NoPath] [-NoOpen]`, `bin\claude-office.cmd`(→ `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-office.ps1" %*`), `bin\claude-office.ps1`(하위 명령 Task 7과 같음). PATH는 `[Environment]::SetEnvironmentVariable("Path", …, "User")`로 사용자 PATH에만, 이미 있으면 추가하지 않음. uninstall은 사용자 PATH에서 그 항목만 제거.

- [ ] **Step 1: 실패하는 테스트**(이 Mac에는 PowerShell이 없으므로 정적 검사. `pwsh`가 있으면 추가로 `[System.Management.Automation.Language.Parser]::ParseFile` 문법 검사를 `it.skipIf(!hasPwsh)`로)
  - 세 파일이 존재하고, `install.ps1`에 `-Prefix`, `-Yes`, `-NoPath`, `-NoOpen` 파라미터 선언.
  - `"User"` 범위 외(`"Machine"`) PATH 변경이 없다.
  - 플러그인 명령 문자열이 install.sh와 같다(`plugin marketplace add`, `plugin install claude-office@claude-office --scope user`, uninstall 쪽 `plugin uninstall … --scope user`, `plugin marketplace remove claude-office`).
  - Node 24 검사 문구 존재, `Remove-Item`의 대상이 모두 `$Prefix` 아래(정규식으로 `Remove-Item` 줄 검사).
  - 패키지 zip 안에서 CRLF(Task 6 테스트가 담당).
- [ ] **Step 2: 실패 확인** — `npx vitest run test/scripts/install-ps1.test.ts` → FAIL
- [ ] **Step 3: 구현** — install.sh와 같은 6단계를 PowerShell로. 파일 상단 주석: `# 베타 미검증: Windows 실제 설치 확인 전입니다(스펙 12장).`
- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`. `npm run package:beta` 후 zip에 세 파일이 들어가는지.
- [ ] **Step 5: 커밋** — `git add packaging/install.ps1 packaging/claude-office.ps1 packaging/claude-office.cmd test/scripts/install-ps1.test.ts && git commit -m "feat(beta): install.ps1 and Windows launcher (unverified on Windows)"`

---

### Task 9: 진단 칩과 패널 디자인 (designer)

**Files:**
- Create: `docs/design/beta/diagnostics.md`(필요하면 `docs/design/beta/diagnostics-mock.html`)

**Interfaces:**
- Consumes: `DiagnosticsSummary`(Task 5), Phase 1 HUD·결정 칩·Galmuri 규칙(`docs/design/phase1/SPEC.md`)
- Produces(Task 10이 그대로 구현할 값): 칩 위치(HUD의 결정 칩 옆), 크기, 문구 `진단`, 빨간 점 조건(최근 1시간 error > 0)과 색·크기, 패널 형태(모달/드로어), 항목 행(✅⚠️❌ 아이콘 또는 픽셀 아이콘, 제목, detail, fix), 오류 수 줄, hook 요약 줄(`최근 10분 N건, 마지막 수신 N분 전, 거부 N건`), "진단 파일 만들기" 버튼 상태(기본/만드는 중/완료 — 파일 이름과 "받기" 링크/실패), 키보드(Esc 닫기, 포커스 이동), `aria` 이름, 좁은 화면, 다크/라이트.
- 사용설명서 그림(Task 12) 목록도 여기서 정한다: 설치 성공 화면, 진단 칩·패널, 진단 파일 만들기, 흔한 오류 화면. 형식은 인라인 SVG(오프라인 단일 파일).

- [ ] **Step 1:** 결정 칩과 같은 규칙으로 값 표(px, 색 토큰, 문구)를 쓴다. mock HTML은 값의 권위, SPEC 문서가 동작의 권위(Phase 1 규칙과 같음).
- [ ] **Step 2: 커밋** — `git add docs/design/beta/ && git commit -m "design(beta): diagnostics chip and panel, manual illustration list"`

---

### Task 10: 진단 칩·패널 구현 (developer, Task 5·9 뒤)

**Files:**
- Create: `web/diag/useDiagnostics.ts`, `web/diag/DiagnosticsChip.tsx`, `web/diag/DiagnosticsPanel.tsx`
- Modify: `web/hud/Hud.tsx`(칩 배치), `web/styles.css`
- Test: `test/web/diag.test.tsx`

**Interfaces:**
- Consumes: `GET /api/diagnostics`, `POST /api/diagnostics/bundle`, `GET /api/diagnostics/files/:name`(Task 5), 디자인 값(Task 9)
- Produces:
  ```ts
  export function useDiagnostics(open: boolean): { data: DiagnosticsSummary | null; error: string | null; reload(): void };
  // 칩의 빨간 점을 위해 패널이 닫혀 있어도 60초마다 /api/diagnostics를 가져온다
  export function DiagnosticsChip(props: { errorsLastHour: number; onOpen(): void }): JSX.Element;
  export function DiagnosticsPanel(props: { data: DiagnosticsSummary | null; onClose(): void }): JSX.Element;
  ```
  `DiagnosticsSummary`, `DoctorItem` 타입은 `src/shared/types.ts`로 옮겨 서버·화면이 같이 쓴다(**Task 5가 app.ts에 둔 타입을 옮기는 것은 Task 10에서 허용** — import 경로만 바꾸는 한 줄 수정, 리뷰에서 확인).

- [ ] **Step 1: 실패하는 테스트**(jsdom, `fetch` mock)
  - `오류가 없으면 점이 없고, 1시간 안 오류가 있으면 빨간 점과 aria 문구` — 점 요소와 `aria-label`에 `오류 N건` 포함.
  - `칩을 누르면 패널이 열리고 doctor 항목이 상태별로 보인다` — ok/warn/fail 각 1개 → 제목·fix 표시, fail이 위.
  - `hook 요약 줄` — `최근 10분 5건` 등 디자인 문구.
  - `진단 파일 만들기 → 만드는 중 → 파일 이름과 받기 링크` — POST가 `Content-Type: application/json`, `body: "{}"`로 호출, 링크 href가 `/api/diagnostics/files/<name>`.
  - `실패하면 알림 문구, 버튼 다시 사용 가능`.
  - `Esc로 닫고 칩으로 포커스가 돌아간다`.
- [ ] **Step 2: 실패 확인** — `npx vitest run test/web/diag.test.tsx` → FAIL
- [ ] **Step 3: 구현** — 디자인 문서 값 그대로. 결정 칩(`web/hud/DecisionChip.tsx`)의 구조·클래스 규칙을 따른다.
- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`, `npm run typecheck`, `npm run build`.
- [ ] **Step 5: 커밋** — `git add web/diag web/hud/Hud.tsx web/styles.css src/shared/types.ts server/app.ts server/diag/doctor.ts test/web/diag.test.tsx && git commit -m "feat(beta): diagnostics chip and panel"`

---

### Task 11: qa:analyze (qa, Task 6 뒤)

**Files:**
- Create: `scripts/qa-analyze.ts`
- Modify: `package.json`(`"qa:analyze": "tsx scripts/qa-analyze.ts"`)
- Test: `test/scripts/qa-analyze.test.ts`

**Interfaces:**
- Consumes: `DiagBundle`(Task 5)
- Produces: `export function analyze(b: DiagBundle): string` (Markdown), CLI `npm run qa:analyze -- <file>` → stdout.

- [ ] **Step 1: 실패하는 테스트**(가짜 진단 파일을 `buildBundle`로 만들어 사용)
  - `환경 요약` — `## 환경` 아래 앱·Node·OS·Claude 버전.
  - `fail·warn doctor 항목만` — ok는 나오지 않는다.
  - `오류 묶음` — 같은 `src`+`msg`의 error를 묶어 `N회, 처음 <t>, 마지막 <t>`로, 많은 순.
  - `hook 통계` — 수신 합계, 이벤트별 표, 거부 수.
  - `[QA 인폼] 초안` — 마지막 절이 `[QA 인폼]`로 시작하고 증상·환경·추정 원인(첫 fail 항목의 fix)·다음 조치 네 줄.
  - `kind가 claude-office-diag가 아니면 오류 종료 코드 2`.
  - `beta-feedback/`는 .gitignore에 있다(`git check-ignore beta-feedback/x.json` 성공).
- [ ] **Step 2: 실패 확인** — `npx vitest run test/scripts/qa-analyze.test.ts` → FAIL
- [ ] **Step 3: 구현** — 순수 함수 `analyze` + 얇은 CLI(`readFileSync(process.argv[2])` → `JSON.parse` → 출력).
- [ ] **Step 4: 통과 확인** — 대상 테스트 + `npm test`, `npm run typecheck`.
- [ ] **Step 5: 커밋** — `git add scripts/qa-analyze.ts package.json test/scripts/qa-analyze.test.ts && git commit -m "feat(beta): qa:analyze diagnostic report"`

---

### Task 12: 사용설명서 (qa 작성, designer 그림, reviewer 검토, director 확인)

**Files:**
- Create: `docs/manual/index.html`

**Interfaces:**
- Consumes: 설치·명령 문구(Task 7·8 실제 출력), doctor 항목과 fix 문구(Task 4), 진단 패널(Task 9·10), 그림 목록(Task 9)
- Produces: 단일 HTML(외부 요청 0 — 글꼴·그림·스크립트 모두 인라인), 스펙 10장의 9개 절(부록 A 관리자 설정, 부록 B 알려진 한계 포함), OS 탭(macOS/Linux/Windows), 명령마다 복사 버튼, 단계마다 "이렇게 보이면 성공".

- [ ] **Step 1: qa 초안** — 문구는 실제 명령 출력을 복사해 쓴다(설치 테스트 로그 참고). 비개발자용: 전문 용어 첫 등장 시 한 줄 설명. 가짜 값만 예시로.
- [ ] **Step 2: designer 그림** — Task 9 목록의 인라인 SVG를 qa에게 전달(파일 편집은 qa, 또는 designer가 `docs/manual/` 안 SVG 블록만 — 배정 메시지로 정함).
- [ ] **Step 3: 정적 검사**(`test/scripts/manual.test.ts`) — `<script src`, `<link href="http`, `url(http`가 없다, 절 제목 9개, OS 탭 3개, 복사 버튼이 `navigator.clipboard` 사용, 가짜 비밀값 패턴(`sk-ant-`, 40자 hex) 없음.
- [ ] **Step 4: reviewer 검토 → director 확인** — 비개발자 관점(순서대로 따라 하면 되는가, 명령이 실제와 같은가), 비밀값·실제 사용자 경로 없음.
- [ ] **Step 5: 커밋** — `git add docs/manual/index.html test/scripts/manual.test.ts && git commit -m "docs(beta): offline user manual"` → director가 비공개 artifact로 올린다(배포는 사용자 결정).

---

### Task 13: mac 끝에서 끝까지 확인, 최종 리뷰, Doc (director 주관, developer·qa 수행)

- [ ] **Step 1: 패키지** — `npm test && npm run typecheck && npm run build && npm run package:beta` 모두 통과. 패키지에 install.sh·install.ps1·claude-office.*·사용설명서.html이 모두 있다.
- [ ] **Step 2: 설치(임시 홈)** —
  ```sh
  T=$CLAUDE_JOB_DIR/tmp/e2e; rm -rf "$T"; mkdir -p "$T/pkg"
  tar -xzf release/claude-office-2.0.0-beta.1.tar.gz -C "$T/pkg"
  HOME="$T" CLAUDE_CONFIG_DIR="$T/.claude" sh "$T/pkg/claude-office-2.0.0-beta.1/install.sh" --prefix "$T/.claude-office" --yes --no-path --no-open
  ```
  플러그인이 `$T/.claude`에만 설치되었는지(`$T/.claude/settings.json`의 enabledPlugins, `~/.claude`는 체크섬 그대로).
- [ ] **Step 3: 서버(tsx·npm 없이)** — `HOME="$T" CLAUDE_CONFIG_DIR="$T/.claude" CLAUDE_OFFICE_NO_OPEN=1 PATH="<node 폴더>:/usr/bin:/bin" "$T/.claude-office/bin/claude-office" --port 4319 &` → `/` 200, `claude-office doctor` 표.
- [ ] **Step 4: hook 통계** — 플러그인 hook 주소는 4317 고정이고 4317은 사용자 v1 뷰어라 쓸 수 없다. 그래서 설치본의 `plugin/plugins/claude-office`를 `$T/plugin-4319`로 복사하고 hooks.json의 주소만 4319로 바꾼 사본을 만든다(저장소·설치본은 그대로). 실험 세션은 Phase 1과 같이 사용자 기존 로그인으로 `claude -p "echo hi를 Bash로 실행해" --plugin-dir "$T/plugin-4319"`(세션 한정, `~/.claude` 설정 파일은 바뀌지 않음 — 전후 체크섬 확인) → `GET /api/diagnostics`의 `hooks.total > 0`.
- [ ] **Step 5: 진단 파일** — 화면 버튼 대신 `curl -X POST -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:4319' http://127.0.0.1:4319/api/diagnostics/bundle -d '{}'` → 201, 파일을 `npm run qa:analyze -- <file>`로 분석. 파일 안에 `$T` 실제 경로·사용자 이름 없음.
- [ ] **Step 6: PATH 단계** — 별도 `HOME=<임시2>`, `SHELL=/bin/zsh`, `--yes --no-open`(--no-path 없이) → `<임시2>/.zshrc`만 바뀜.
- [ ] **Step 7: uninstall** — `claude-office uninstall --yes` → prefix 없음, `$T/.claude`의 플러그인 제거.
- [ ] **Step 8: 안전 확인** — `shasum ~/.claude/settings.json` = `84b304dd4c5092f8e8f026998415b6ce7a407552`, 4317 PID 47661 살아 있음, `~/.zshrc` 수정 시각 변화 없음, `git status`에 진단 파일·release 없음.
- [ ] **Step 9:** 최종 리뷰(전체 브랜치, 1회 + 재리뷰 1회) → Doc(reviewer) → 로컬 태그 `git tag v2.0.0-beta.1`(push 안 함) → `[최종 보고]`.
