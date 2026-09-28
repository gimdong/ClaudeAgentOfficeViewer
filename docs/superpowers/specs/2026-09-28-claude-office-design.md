# Claude Agent Office Viewer — 설계 스펙

- 작성일: 2026-09-28
- 상태: 사용자 검토 대기
- 저장소: https://github.com/gimdong/ClaudeAgentOfficeViewer

## 1. 목적

Claude Code의 토큰 사용량과 잔여량, 실행 중인 세션의 상태, 각 agent team 팀원의 상태를 한 화면에서 확인하는 **로컬 웹 대시보드**를 만든다.
세션은 "사무실", 팀원은 "책상에 앉은 도트 캐릭터"로 그려 상태를 직관적이고 귀엽게 보여준다.

### 합의된 요구사항 (사용자 결정)

| 항목 | 결정 |
|---|---|
| 잔여량 표시 | 세 가지를 모두 표시한다: ① 사용자가 정한 예산(5시간·주간) 대비 잔여, ② 세션별 컨텍스트 창 잔여, ③ 요금제 한도 잔여(데이터를 가져올 수 있을 때만) |
| 실행 방식 | 로컬 서버 + 자동 갱신 (브라우저로 localhost 접속) |
| 표시 범위 | 실행 중인 세션 전부. 세션 하나 = 사무실 하나. 종료된 세션은 불 꺼진 사무실로 표시 |
| 비주얼 스타일 | C. 네온 야근 사무실 (어두운 배경 + 네온 모니터 불빛, 도트 그래픽) |
| 화면 배치 | B. 게임 HUD(상단 잔여량 체력바) + 사무실 타일 격자 |
| 기술 스택 | React + Vite + Express, TypeScript, Vitest |
| 권한 | **보기 전용**. `~/.claude`를 읽기만 하며, 대시보드에서 세션이나 팀원을 조작하지 않는다 |

### 성공 기준

1. `npm start` 후 브라우저에서 이 Mac의 실행 중인 세션과 팀원이 사무실 타일과 캐릭터로 보인다.
2. 팀원 상태 변화가 **5초 안에** 화면에 반영된다. 대기에서 작업 중으로, 메시지 수신, 종료가 해당한다. 단, 작업 중에서 대기로 바뀌는 것은 판정 규칙(마지막 활동 후 10초)에 따라 **최대 15초**까지 걸릴 수 있다.
3. 오늘·5시간·주간 사용 토큰이 대화 기록 기준으로 정확하다. 이는 fixture 테스트로 검증한다.
4. 예산과 한도 데이터가 없어도 화면이 깨지지 않고 대체 문구를 표시한다.

## 2. 구조

```
[~/.claude 파일들] ──읽기 전용──▶ [Express 서버 127.0.0.1:4317]
                                  ├ collectors/  파일 → 정규화된 데이터
                                  ├ fs.watch(debounce 500ms) + 3초 주기 재수집
                                  └ GET /api/snapshot, GET /api/stream (SSE)
                                              │
                                              ▼
                                  [React 앱 (Vite)]  HUD + 사무실 타일 + 도트 캐릭터
```

- 서버는 `127.0.0.1`에만 바인딩한다.
- 기본 포트는 4317이며 `--port`로 바꿀 수 있다.
- Claude 데이터 폴더는 기본값 `~/.claude`이며, `--claude-home` 옵션이나 `CLAUDE_HOME` 환경변수로 바꿀 수 있다. 테스트에서 fixture 폴더를 쓰기 위해 필요하다.
- 설정 파일은 저장소 루트의 `claude-office.config.json`이다(선택). 담는 내용: `budget.fiveHour`, `budget.weekly`(토큰 수), `contextWindows`(모델별 창 크기, 기본값 200000).

## 3. 데이터 수집기

| 수집기 | 입력 | 출력 |
|---|---|---|
| `usage` | `projects/**/*.jsonl`, `projects/**/subagents/*.jsonl` | 모델별 input/output/cacheRead/cacheWrite 합계. today / last5h / last7d 구간 합계와 최근 24시간의 시간대별 합계 |
| `sessions` | `sessions/<pid>.json` | 세션 id, name, cwd, status(busy/idle), 프로세스 생존 여부(`process.kill(pid, 0)`), 시작 시각 |
| `teams` | `teams/<팀>/config.json`, `teams/<팀>/inboxes/*.json` | 팀원 name, agentType, model, color, 합류 시각, 읽지 않은 메시지 수. 팀과 세션은 `leadSessionId`로 연결한다 |
| `context` | 세션 대화 기록의 마지막 assistant `usage` | used = input + cacheRead + cacheWrite, window(모델별), pct |
| `limits` (선택) | `~/.claude/claude-office/limits.json` (statusline tap이 기록) | 5시간·주간 한도 사용률, 초기화 시각. 파일이나 필드가 없으면 `null` |

### 계산 규칙

- **사용 토큰** = input + output + cacheWrite. cacheRead는 따로 보여주고 합계에서 제외한다.
- **중복 제거:** 같은 `requestId`는 한 번만 센다. `requestId`가 없으면 `message.id`로 센다.
- **구간:** 현재 시각 기준으로 거꾸로 5시간, 7일(rolling window). 실제 요금제 한도 구간과 다를 수 있어 UI에 "추정"으로 표시한다. "오늘"은 로컬 시간 자정부터다.
- **증분 읽기:** 파일별로 (크기, 마지막 offset)을 기억해 새로 추가된 바이트만 파싱한다. 파일 크기가 줄었으면(교체된 경우) 처음부터 다시 읽는다. 마지막 줄이 개행으로 끝나지 않았으면 그 줄은 다음 수집으로 미룬다.

### 팀원 상태 판정

위에서부터 순서대로 처음 맞는 규칙을 적용한다.
1. 소속 세션의 프로세스가 죽었으면 → `offline`
2. 받은편지함에 읽지 않은 메시지가 있으면 → `mail`
3. 팀원 대화 기록의 수정 시각이 10초 이내이거나, 마지막 항목이 결과가 아직 오지 않은 도구 호출이면 → `working`
4. 그 밖의 경우 → `idle`

리드(세션 본체)는 `sessions/<pid>.json`의 `status`를 그대로 쓴다. busy는 `working`, idle은 `idle`이다.

## 4. API

```ts
type MemberState = "working" | "idle" | "mail" | "offline";

interface Snapshot {
  generatedAt: string;                 // ISO
  error?: string;                      // ~/.claude 접근 불가 등
  usage: {
    today: TokenSum; last5h: TokenSum; last7d: TokenSum;
    byModel: Array<{ model: string } & TokenSum>;
    hourly: number[];                  // 길이 24, 사용 토큰
  };
  budget: { fiveHour?: number; weekly?: number };
  limits: { fiveHourPct?: number; weeklyPct?: number; resetsAt?: string; source: string } | null;
  sessions: Array<{
    id: string; name: string; cwd: string; alive: boolean; isCurrent: boolean;
    status: MemberState; stale?: boolean;
    context: { used: number; window: number; pct: number; estimated: boolean } | null;
    members: Array<{ name: string; role: string; model?: string; color?: string;
                     state: MemberState; unread: number; tokens: TokenSum; lastActivityAt?: string }>;
  }>;
}
interface TokenSum { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
```

- `GET /api/snapshot`: 현재 스냅샷을 JSON으로 반환한다.
- `GET /api/stream`: SSE. 연결되면 스냅샷을 즉시 한 번 보내고, 이후 내용이 바뀔 때마다 `event: snapshot`으로 스냅샷 전체를 보낸다. 15초마다 연결 유지용 heartbeat 주석을 보낸다.
- `isCurrent`: 가장 최근에 활동한(`updatedAt` 기준) 살아 있는 세션이다.
- 사무실 목록에는 살아 있는 세션과 최근 24시간 안에 종료된 세션을 포함한다.

## 5. 화면

```
<App>
 ├ <Hud>            TokenCounter(오늘/5H/주간) + HeartBar×3(5H 예산 · WEEK 예산 · PLAN 한도) + LIVE 표시
 ├ <OfficeGrid>     현재 세션(★)을 맨 앞에 둔 사무실 타일 격자
 │   └ <OfficeTile> 배경(창문·시계·화분) + 세션 이름 + CTX 바 + Desk×N
 │       └ <Desk>   책상 + 모니터 + PixelCharacter + StatusBubble
 └ <MemberPopover>  마우스를 올리면 이름·모델·토큰·최근 활동 표시
```

- **팔레트(네온):** 벽 `#1d1b33`, 바닥 `#2a2446`, 책상 `#3b3460`, 모니터 불빛 `#39ffb6`, 강조 `#ff5fa2` `#3fd0ff` `#b98cff` `#fff7a8`
- **캐릭터:** 8×10 문자열 픽셀 맵을 SVG `rect`로 렌더링한다(`shape-rendering: crispEdges`). 이미지 파일은 쓰지 않는다.
  - 리드와 감독관은 보라 셔츠에 넥타이, 구현 담당은 초록, 리뷰어는 하늘색 셔츠에 안경이다.
  - 그 밖의 팀원은 config `color`로 셔츠 색을 정한다.
- **상태 표현:** 2프레임 CSS `steps()` 애니메이션을 쓴다.

| 상태 | 캐릭터 | 모니터 | 말풍선 |
|---|---|---|---|
| working | 타이핑(손 위아래) | 켜짐, 코드 줄이 흐름 | ⌨ |
| idle | 졸기(고개 끄덕임) | 꺼짐 | z z |
| mail | 기본 자세 | 켜짐 | ✉ + 안 읽은 개수 |
| offline | 빈 의자 | 꺼짐 | 없음 |

- **HeartBar 색:** 남은 비율이 50% 이상이면 초록, 20~50%면 노랑, 20% 미만이면 분홍이며 분홍일 때 깜빡인다.
  - 예산이 설정되지 않았으면 `-- 설정 필요`를 표시한다.
  - 한도 데이터가 없으면 `-- 데이터 없음`을 표시한다.
- **종료된 세션:** 사무실 전체를 불 꺼진 모습으로 흐리게 표시한다(opacity 0.45).

## 6. 요금제 한도 연동 (선택)

- `scripts/statusline-tap.sh`는 stdin으로 받은 JSON을 `~/.claude/claude-office/limits.json`에 원자적으로 저장한다(임시 파일에 쓴 뒤 mv). 그런 다음 같은 입력을 기존 statusline 명령에 그대로 넘기고, 그 출력을 그대로 내보낸다.
- `npm run setup:statusline`
  1. `~/.claude/settings.json`을 백업한다.
  2. 원래 `statusLine.command`를 `~/.claude/claude-office/original-statusline.sh`로 저장한다.
  3. `statusLine.command`를 tap 스크립트로 교체한다.
  - 사용자가 직접 실행할 때만 적용된다. 서버는 이 파일을 절대 수정하지 않는다.
- `npm run remove:statusline`: 백업에서 원래 명령을 복원한다.
- **첫 구현 과제:** 현재 Claude Code(2.1.283)가 statusline에 넘기는 JSON에 한도 필드가 있는지 확인한다. 없으면 이 기능은 tap 스크립트까지만 만들고, UI는 `-- 데이터 없음`으로 둔다.

## 7. 오류 처리

| 상황 | 처리 |
|---|---|
| JSONL에 깨진 줄이 있음 | 그 줄을 건너뛴다. 마지막 미완성 줄은 다음 수집 때 다시 읽는다 |
| 세션 JSON이 없거나 형식이 다름 | 그 세션만 제외하고 경고 로그를 남긴다 |
| PID는 있으나 프로세스가 죽음 | `alive=false`로 두고 불 꺼진 사무실로 표시한다 |
| 팀 폴더는 있으나 config가 없음 | 리드만 있는 1인 사무실로 표시한다 |
| `~/.claude` 접근 불가 | 빈 스냅샷에 `error`를 채우고 화면에 배너를 표시한다 |
| 모르는 모델 | 컨텍스트 창을 200k로 계산하고 `estimated=true`로 표시한다 |
| 수집기 예외 | 수집기별로 격리한다. 직전 값을 유지하고 해당 세션에 `stale=true`를 붙인다 |
| 포트가 이미 사용 중 | 명확한 메시지와 함께 종료 코드 1로 끝낸다 |

## 8. 테스트

- **수집기 (Vitest):** `test/fixtures/claude-home/`의 가짜 데이터로 다음을 검증한다.
  - `requestId` 중복 제거
  - 5시간·7일 경계
  - 깨진 줄과 미완성 마지막 줄
  - 증분 읽기와 파일 교체
  - 팀원 상태 판정 4종
  - 컨텍스트 계산
- **API:** fixture 폴더로 서버를 띄워 다음을 확인한다.
  - `/api/snapshot`의 구조
  - SSE 연결 직후 첫 이벤트
  - 파일을 추가하면 5초 안에 이벤트가 오는지
- **UI (@testing-library/react):** 다음을 확인한다.
  - 상태별 말풍선과 모니터
  - HeartBar 색 경계(50%, 20%)
  - 설정·데이터가 없을 때의 대체 문구
  - 종료된 세션의 흐린 표시
- **실사용 확인:** 실제 `~/.claude`로 `npm start`를 실행하고 브라우저 화면을 캡처해, 실행 중인 팀이 표시되는지 확인한다.

## 9. 명령

- `npm run dev`: Vite(프론트)와 Express(API)를 동시에 실행한다. Vite가 `/api`를 Express로 넘긴다(proxy).
- `npm run build`: 프론트엔드를 빌드한다.
- `npm start`: Express가 빌드된 정적 파일과 API를 함께 서비스한다.
- `npm test`: 전체 Vitest를 실행한다.

## 10. 범위 밖 (이번에 하지 않음)

- 원격 접속과 인증
- 과거 데이터를 DB에 저장
- 비용(달러) 환산
- 알림
- 캐릭터 커스터마이징
- 대시보드에서 세션이나 팀원을 조작하는 기능
