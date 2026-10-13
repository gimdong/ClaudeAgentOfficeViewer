# v2 Phase 4b — 작업 지시·새 층(실험 기능) 설계 스펙

- 작성 2026-10-14. 사용자 결정(2026-10-14): A 실험 기능으로 쓴다, B 대시보드가 띄운 새 층만, C tmux + 확인 창은 사용자가 직접, D 휴업 중 지시는 보관했다가 재개할 때 보낸다. 설계안 승인(대화) 뒤 작성.
- 근거: Phase 4b 스파이크 보고서(`docs/superpowers/spikes/2026-10-13-phase4b-spike.md`, 브랜치 `spike/phase4b` 68326fb), Phase 0 보고서 T0.4, Phase 4a 스펙(일시정지·재개).
- 이 문서에는 실제 사용자 이름·홈 경로를 적지 않는다.

## 1. 목적

대시보드에서 **새 층(새 Claude Code 세션)을 띄우고**, 그 층에 **작업을 지시**한다. 휴업 중인 층에 보낸 지시는 보관했다가 재개할 때 확인·수정 후 보낸다. Phase 1이 비워 둔 "작업 지시"·빈 층의 "새 층" 버튼 자리를 채운다.

## 2. 전제 (스파이크 실측, 바꿀 수 없는 제약)

| # | 사실 | 출처 |
|---|---|---|
| F1 | 우리 플러그인의 channel은 승인 목록 밖이다. `--channels`로는 등록되지 않고 `--dangerously-load-development-channels plugin:claude-office@claude-office`로만 된다. 시작할 때마다 경고 확인 창이 뜨고, 대화형 세션에서만 듣는다 | 스파이크 Q1(실측 + 문서) |
| F2 | 이미 켜진 세션에는 channel을 붙일 수 없다. `--resume` 때도 플래그를 다시 줘야 한다 | Q1 |
| F3 | 플래그 옵션은 값을 여러 개 받아 뒤에 둔 프롬프트를 삼킨다. 첫 지시는 이 옵션 **앞에** 둔다 | Q4 |
| F4 | 새 폴더에서는 확인 창 두 개(폴더 신뢰, 개발용 경고)가 차례로 뜬다 | Q4 |
| F5 | 대기 중 세션에 넣은 channel 메시지는 바로 처리된다. 턴 도중이면 다음 턴에 모아 전달된다(문서, 미실측) | Q3 |
| F6 | 휴업(4a) 중에도 channel 메시지는 모델에 들어가고 도구만 막힌다. 재개는 세션을 깨우지 않는다 | Q3(c) |
| F7 | channel 서버는 Claude Code의 자식 프로세스이고 `CLAUDE_CODE_MESSAGING_TOKEN` 등을 env로 받는다 | Q2 |
| F8 | Team·Enterprise는 기본으로 channel이 막혀 있고, 이때는 개발용 플래그도 듣지 않는다 | Q5(문서) |

Task 0(확인)에서 다시 볼 것: (가) 설치된 플러그인 이름 `plugin:claude-office@claude-office`로 개발용 플래그가 등록되는지(스파이크는 `--plugin-dir`의 `@inline`), (나) 대시보드가 `claude`에 넘긴 환경변수가 플러그인 MCP 서버까지 그대로 가는지, (다) MCP 서버가 4317로 나가는 HTTP 연결을 열 수 있는지(샌드박스 없음 확인). 셋 중 하나라도 틀리면 해당 절의 대안(9장)으로 가고 사용자에게 알린다.

## 3. 실험 기능 스위치

- 서버 상태 `experimental.channels: boolean`(기본 false). `~/.claude-office/state.json`에 저장한다. 예산 기본값과 같은 파일, 같은 원자적 쓰기. 사용자가 일부러 켠 것이라 대시보드를 다시 켜도 유지한다.
- 위쪽 막대에 "실험 기능" 버튼 → 작은 창: 설명 + 동의 체크 + [켜기]/[끄기].
  - 설명 문구(고정): `작업 지시와 새 층은 Claude Code의 연구 프리뷰 기능(channel)을 씁니다. Claude Code가 바뀌면 동작이 바뀌거나 멈출 수 있습니다. 새 층을 띄울 때마다 Claude Code가 개발용 channel 경고를 띄웁니다. 회사 계정(Team·Enterprise)에서는 관리자가 허용하기 전까지 동작하지 않습니다.`
- 꺼져 있으면 "작업 지시"·"새 층" 버튼은 `aria-disabled`이고 툴팁은 `실험 기능을 켜면 쓸 수 있습니다`.
- Windows(`process.platform === "win32"`)와 tmux가 없는 환경에서는 켤 수 없다. 창에 이유 한 줄: `tmux가 있어야 새 층을 띄울 수 있습니다(macOS·Linux).`

## 4. 새 층 띄우기

### 4.1 화면
- 빈 층의 "새 층" 버튼 → 창: 폴더(텍스트), 이름(선택, 비우면 폴더 이름), 모델(기본/Opus/Sonnet/Haiku → `opus`/`sonnet`/`haiku`, 기본이면 인자 없음), 첫 지시(선택, 여러 줄).
- [띄우기] 성공 → 창이 "붙어서 확인하기" 단계로 바뀐다: `터미널에서 아래 명령으로 붙어 확인 창 두 개(폴더 신뢰, 개발용 channel 경고)를 확인해 주세요. 확인하기 전에는 Claude가 시작하지 않습니다.` + `tmux attach -t <tmux 세션 이름>`(복사 버튼). 대시보드는 확인 창을 대신 누르지 않는다(키 입력 보내지 않음).
- 층은 Claude Code가 세션 기록을 쓰는 순간 평소처럼 빌딩에 나타난다. 대시보드가 띄운 층은 층 머리에 작은 표시 `대시보드가 띄움`과 channel 상태(`연결됨`/`연결 전`)를 단다.

### 4.2 API `POST /api/floors/launch`
- 본문 `{ cwd: string, name?: string, model?: "opus"|"sonnet"|"haiku", prompt?: string }`. 보호: 기존 토큰 쿠키 + sameOrigin + 실험 기능 켜짐.
- 검증(실패 400 `{ error }`):
  - `cwd`: 절대 경로, `realpath` 뒤 실제 디렉터리. 길이 ≤ 1024. `~`로 시작하면 홈으로 펼친다.
  - `name`: `^[\p{L}\p{N} ._-]{1,40}$`(u). 비우면 폴더 basename을 같은 규칙으로 걸러 쓴다.
  - `model`: 위 세 값만.
  - `prompt`: ≤ 8,000자, NUL 금지.
- 실행: `execFile("tmux", [...])` — **셸을 거치지 않는다.**
  - `tmux new-session -d -s co-<짧은 무작위 8자> -c <cwd> -e CLAUDE_OFFICE_FLOOR_KEY=<층 열쇠> -e CLAUDE_OFFICE_PORT=<서버 포트> -- <claude 절대 경로> --session-id <새 UUID> --name <name> [--model <m>] [<prompt>] --dangerously-load-development-channels plugin:claude-office@claude-office`
  - 순서: 프롬프트는 반드시 channel 옵션 **앞**(F3). 테스트로 고정한다.
  - claude 절대 경로: 서버 시작 때 `PATH`에서 찾은 실제 파일(심볼릭 링크 풀기). 못 찾으면 실험 기능을 켤 수 없다.
- 응답 200 `{ sessionId, tmux: "co-xxxxxxxx" }`. tmux 실패는 502 `{ error: "tmux" }`(stderr는 로그에 오류 코드만).
- 서버 메모리: `launched: Map<sessionId, { key, tmux, name, at }>`. 층 열쇠는 `randomBytes(32)` hex. 로그·진단·스냅샷에 넣지 않는다.
- 동시에 띄운 층 상한 8. 넘으면 429 `{ error: "limit" }`.

## 5. channel 서버(플러그인에 넣음)

- `plugins/claude-office/.mcp.json`에 stdio MCP 서버 `office-channel`(node 스크립트, 의존성 없이 — 스파이크와 같은 직접 구현, MCP 협상 revision은 2025-11-25로 고정하고 테스트로 확인).
- capabilities: `experimental: { "claude/channel": {} }`(권한 중계는 쓰지 않는다 — Phase 0 결정대로 hook으로 통일).
- 시작 때 `CLAUDE_OFFICE_FLOOR_KEY`가 없으면 **아무 연결도 하지 않고** MCP 초기화에만 응답한다(대시보드가 띄우지 않은 모든 세션). 메시지를 내보내지 않는다.
- 있으면 `GET http://127.0.0.1:<CLAUDE_OFFICE_PORT>/channel/stream`에 `Authorization: Floor <key>`로 SSE 연결. 끊기면 1·2·4·8·16초(최대 30초) 간격으로 다시 잇는다.
- SSE 이벤트 `instruction { id, text }` → `notifications/claude/channel`로 세션에 전달 → `POST /channel/ack { id }`(같은 인증).
- **포트를 열지 않는다.** env의 `CLAUDE_CODE_MESSAGING_TOKEN` 등 다른 값은 읽지도 보내지도 않는다(코드가 `process.env`에서 두 이름만 읽는다는 테스트 + 보낸 요청에 그 값이 없다는 테스트).
- 서버 쪽 `/channel/*`는 Host 검사와 층 열쇠로만 인증한다(쿠키 없음, Origin 있으면 403). 열쇠는 `launched`의 값과 상수 시간 비교.

## 6. 작업 지시

- "작업 지시" 버튼은 `launched`에 있고 channel이 **연결됨**인 층에만 켜진다. 그 밖: 대시보드가 띄우지 않은 층 → 툴팁 `대시보드가 띄운 층에만 지시할 수 있습니다(Claude Code 제약)`, 연결 전 → `channel이 아직 연결되지 않았습니다. 터미널에서 확인 창을 확인했는지 봐 주세요.`
- 창: 글 입력(≤ 8,000자) + [보내기]. `POST /api/floors/:id/instruct { text }` → 영업 중이면 SSE로 보내고 200 `{ id, state: "sent" }`; ack가 오면 스냅샷의 그 지시가 `delivered`.
- 휴업 중이면 보관함에 넣고 200 `{ id, state: "held" }`(7장).
- 층 머리에 최근 지시 한 줄 상태: `지시 보냄`/`전달됨`/`보관 N`. 작업 중 층에 보내면 창에 `작업 중이라 Claude가 지금 하던 일을 마친 뒤 읽습니다.`
- 지시 글은 로그에 넣지 않는다(길이·상태만).

## 7. 휴업 중 지시 보관과 재개 브리핑

- 보관함: 서버 메모리 `held: Map<sessionId, Array<{ id, text, at }>>`, 층당 20개 상한(넘으면 409 `{ error: "held-full" }`). 대시보드를 끄면 사라진다(4a 한계 1과 같은 문장을 브리핑 창에 적는다).
- 재개 스위치를 누를 때 그 층에 보관 지시가 있거나 기다리는 결정이 있으면 **재개 브리핑 창**을 먼저 연다(없으면 4a대로 바로 재개).
  - 보관 지시 목록: 각 항목 [고치기](글 수정)·[지우기]. 순서는 보관한 순서.
  - `기다리는 결정 N건` + [결정 보러 가기](4a의 "가장 오래된 결정 보고서 열기"와 같은 동작, 브리핑 창은 닫힌다 — 재개는 하지 않음).
  - `휴업 중 답한 질문 N건 — 답을 바꾸려면 아래 지시로 정정해 주세요.`(휴업 중 대시보드가 답한 AskUserQuestion 수. 답 자체를 고치는 기능은 범위 밖, 12장)
  - [보내고 재개]: 재개 API 성공 뒤 보관 지시를 순서대로 SSE로 보낸다. 보관 지시가 없으면 [재개]만. [취소]: 휴업 유지.
- 대시보드가 띄우지 않은 층(지시 불가)은 보관 지시가 생기지 않으므로 기존 4a 흐름 그대로(결정이 있으면 보고서 열기).
- API: `GET /api/floors/:id/held`, `PUT /api/floors/:id/held/:hid { text }`, `DELETE /api/floors/:id/held/:hid`, `POST /api/floors/:id/resume { sendHeld: true }`.

## 8. 화면 문구·접근성

- 새 문구는 모두 `web/floors/` 상수로 두고 설명서·테스트가 대조한다(4a와 같은 방식). 고객 문구는 qa가 앞뒤 출력과 나란히 검토한다.
- 새 창 셋(실험 기능, 새 층, 작업 지시)과 브리핑 창은 기존 대화상자 패턴(포커스 [취소], Esc, 닫으면 연 버튼으로 복귀, `useLayoutEffect`). 다른 창이 열려 있으면 열지 않는다.
- 디자인 명세: designer가 `docs/design/phase4b/SPEC.md`. 정적 렌더로 배치 확인(FB-6).

## 9. 전제가 틀릴 때의 대안 (Task 0 결과에 따라)

- (가) 설치 플러그인 이름으로 등록 안 됨 → 개발용 플래그 값을 `server:office-channel` + `--mcp-config <대시보드가 만든 임시 json>`으로 바꾼다(스파이크에서 같은 오류 문구로 동작 확인된 형태).
- (나) env가 MCP 서버로 안 감 → 층 열쇠를 `--mcp-config` json의 `env`로 넘긴다(파일은 `~/.claude-office/run/` 0600, 층이 끝나면 지움).
- (다) 나가는 연결 불가 → 4b를 멈추고 사용자에게 알린다(포트를 여는 방식은 하지 않는다).

## 10. 로그·진단·doctor

- 로그 `floors` 종류에 `launch`, `instruct`, `held`, `resume-send`, `channel-connect`, `channel-drop`. 세션 순번·상태·글 길이만. 지시 글·폴더 경로·층 열쇠·env 값은 넣지 않는다.
- 진단 묶음에 `launched`·`connected`·`held` 수. doctor에 "실험 기능: 켜짐/꺼짐, tmux 있음/없음" 한 줄(값만).

## 11. 완료 기준

1. 단위: launch 인자(셸 없음, 프롬프트가 channel 옵션 앞, 모델·이름 생략 규칙), 입력 검증 표, 상한 429, 실험 기능 꺼짐 403; channel 서버(열쇠 없으면 무연결·무출력, 열쇠 있으면 SSE·재연결·ack, env 두 이름만 읽음, 보낸 요청에 messaging token 없음); `/channel/*` 인증(열쇠 틀림 401, Origin 403); instruct 상태(sent/delivered/held); 보관함 상한·수정·삭제; 브리핑 창 흐름(보내고 재개, 결정 보러 가기, 취소).
2. 변이 확인: 프롬프트 순서 검사, 열쇠 없는 세션의 무연결, Origin 거부.
3. UI(jsdom) + 정적 렌더(360·900·1200).
4. 실제 세션(job tmp, 4319, 실제 claude 절대 경로, 프롬프트 **4개 이하**): 실험 기능 켬 → 새 층 띄움(첫 지시 1) → 사람이 tmux로 붙어 확인 창 둘 확인(팀원이 키 입력을 보내지 않고, 이 단계는 developer가 tmux에 직접 붙어 확인 — 대시보드 기능이 대신 누르지 않는다는 것을 지킨다) → 작업 지시(2) → 휴업 → 지시 보관 → 브리핑에서 고쳐 [보내고 재개](3). 사용자 4317과 그 세션은 대상이 아니다.
5. 누출 검사: 로그·진단·스냅샷·channel 서버 출력에 지시 글, 폴더 경로, 층 열쇠, messaging token, 64자 hex 없음.
6. 단독 최종 확인(새 worktree, `npm ci`, 전체 테스트 3회, `caffeinate -s -i`).

## 12. 범위 밖

- 휴업 중 이미 보낸 질문 답 고치기(결정 큐 의미 변경, 590초 제한) — 다음 단계.
- 플래그 없이 이미 켜진 층에 지시, 사용자 터미널 앱 열기, `claude --bg`, Windows.
- channel 권한 중계(hook으로 통일).
- 보관함·launched의 파일 저장(메모리만. 실험 기능 스위치만 저장).

## 13. 위험

| 위험 | 대응 |
|---|---|
| 대시보드 API로 임의 명령 실행 | 셸 없이 인자 배열, 실행 파일은 tmux와 확인된 claude 절대 경로뿐, 입력 검증, 토큰+sameOrigin, 실험 기능 켜짐 조건 |
| 열린 포트로 프롬프트 주입 | channel 서버는 포트를 열지 않음, `/channel/*`는 층 열쇠 |
| 사용자 동의를 대신 누름 | 키 입력을 보내지 않음, 붙는 명령만 안내 |
| research preview가 바뀜 | 실험 기능으로 격리(기본 꺼짐), 설명서에 명시, Task 0 대안 |
| 다른 세션에 영향 | 열쇠 없는 세션의 channel 서버는 무연결·무출력(테스트) |
| messaging token 누출 | env 두 이름만 읽는 테스트, 누출 검사 |
| 주간 사용량 한도(75%, 10/18 초기화) | Task를 작게, 실제 세션은 마지막에 한 번 |
