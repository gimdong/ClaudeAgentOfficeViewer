# Claude Agent Office Viewer v2 — Phase 1 설계 스펙: 이벤트 브리지와 빌딩 UI

- 작성일: 2026-10-01
- 상태: 사용자 검토 대기
- 브랜치: `feat/v2-phase1` (시작점: `spike/phase0` `1dfd28d`)
- 근거 문서
  - v2 로드맵: `~/.claude/plans/mighty-floating-feigenbaum.md` (특히 3.1 Phase 0 반영 사항)
  - Phase 0 보고서: `docs/superpowers/spikes/2026-09-30-phase0-report.md`
  - 디자인 명세: `docs/design/phase1/SPEC.md`, 시안 `docs/design/phase1/index.html` (designer 작성, 사용자 결정 3건 반영)
  - v1 스펙: `docs/superpowers/specs/2026-09-28-claude-office-design.md`

## 1. 목적과 범위

Claude Code의 **hook 이벤트를 실시간으로 받아**, 에이전트가 "지금 무엇을 하는지"와 "결정을 기다리는지"를 **빌딩(층) 화면**에 보여준다.
이 단계는 **보기만 한다.** 대시보드에서 세션을 조작하는 기능은 없다.

| Task | 내용 | 로드맵 요구 |
|---|---|---|
| T1.1 | `claude-office` 플러그인과 저장소 마켓플레이스 | R1 |
| T1.2 | 서버의 hook 이벤트 수신 API와 이벤트 저장소 | R5, R6 |
| T1.3 | 에이전트별 "지금 하는 일"과 결정 대기 상태 계산, 스냅샷 확장 | R5, R6 |
| T1.4 | 빌딩(층) 레이아웃 | R2(모양만) |
| T1.5 | "저는 지금 …을 하고 있습니다" 말풍선 | R5 |
| T1.6 | 손들기와 노란 ? (표시만) | R6(표시만) |
| T1.7 | PLAN 바의 `spend_limit` 지원 | R1 |
| T1.8 | 실험 세션에서 끝에서 끝까지 확인, 문서 | — |

**범위 밖 (이후 Phase에서 한다)**
- 결정에 답하기(허용, 거부, 선택지 선택, 채팅)와 결정 보고서 패널: Phase 2
- 예산 설정과 예산 관문: Phase 2
- 권한 정책: Phase 3
- 층 컨트롤(휴업, 종료, 삭제, 작업 지시, 새 세션)의 **동작**: Phase 4. Phase 1에서는 모양만 두고 비활성화한다(디자인 A8).
- 브라우저용 인증 토큰: 쓰기 API가 생기는 Phase 2에서 도입한다.

## 2. Phase 0에서 확정된 전제

1. 결정은 모두 `PermissionRequest`에서 기다린다. `PreToolUse`에서는 기다리지 않는다. Phase 1은 **아무것도 기다리지 않고**, 모든 hook에 즉시 빈 응답을 돌려준다.
2. 팀원 hook의 `agent_type`에는 **팀원 이름**이 들어온다. 리드가 쓴 도구에는 `agent_id`와 `agent_type`이 없다. 일반 서브에이전트는 `agent_type`에 타입 이름(예: `general-purpose`)이 들어오고, `agent_id`는 `a<16진수>` 형태다.
3. `agent_type === ""`인 `SubagentStop`은 내부 보조 에이전트가 끝날 때 오는 이벤트라 무시한다.
4. `TeammateIdle` 입력에는 `teammate_name`과 `team_name`이 있다.
5. 서버가 꺼져 있으면 HTTP hook은 연결 실패로 끝나고, 세션은 **그대로 계속 진행한다**(문서에 명시).

## 3. 구조

```
Claude Code 세션 ──(플러그인 http hooks, 즉시 응답)──▶ POST /hooks/event ─▶ EventStore(메모리)
                                                                              │
~/.claude 파일(v1 수집기) ──────────────────────────▶ SnapshotBuilder ◀────────┘
                                                        │ activity, decision 병합
                                                        ▼
                                              SnapshotHub ─SSE─▶ 빌딩 UI
```

v1의 수집기(파일 기반)는 그대로 둔다. hook 이벤트는 **실시간 보강 정보**로만 쓴다. 이벤트가 없어도(플러그인 미설치, 서버 재시작 직후) v1과 같은 수준으로 동작해야 한다.

## 4. T1.1 플러그인과 마켓플레이스

**저장소 자체를 마켓플레이스로 만든다.**
- `.claude-plugin/marketplace.json`: 이름 `claude-office`. 플러그인 `claude-office`를 `./plugins/claude-office`에서 제공한다.
- `plugins/claude-office/.claude-plugin/plugin.json`: 이름, 버전 `0.1.0`, 설명, 라이선스 표시
- `plugins/claude-office/hooks/hooks.json`

**hooks.json 규칙**
- 대상 이벤트: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `Stop`
- 모든 항목은 `"type": "http"`, `"url": "http://127.0.0.1:4317/hooks/event"`, `"timeout": 5`로 둔다. 도구 이벤트는 `"matcher": "*"`를 쓴다.
- 이벤트 이름은 입력의 `hook_event_name`으로 구분하므로 URL은 하나다.

**개발 중 포트 분리:** 사용자는 4317에서 v1 뷰어를 보고 있다. 개발 서버는 4318에서 띄운다.
- `scripts/make-dev-plugin.mjs --port 4318 --out <dir>`: 플러그인을 복사하면서 URL의 포트만 바꾼다.
- 실험 세션은 `claude --plugin-dir <dir>`로 이 개발용 플러그인을 로드한다.
- 이렇게 하면 사용자 설정(`enabledPlugins`)을 건드리지 않는다.

설치 방법(사용자용)은 README에 적는다: `/plugin marketplace add gimdong/ClaudeAgentOfficeViewer` → `/plugin install claude-office@claude-office`. **실제 설치는 사용자가 결정한다.** 팀은 설치하지 않는다.

## 5. T1.2 이벤트 수신과 저장소

**`POST /hooks/event`**
- **요청 검증** (브라우저에서 오는 위조 요청 차단. 토큰은 Phase 2에서 도입)
  - v1의 Host 검사를 그대로 적용한다.
  - `Content-Type`이 `application/json`이 아니면 415를 돌려준다. 이렇게 하면 브라우저가 다른 출처에서 보낼 때 사전 확인(preflight)이 필요해지고, 서버가 CORS를 허용하지 않으므로 요청이 막힌다.
  - `Origin` 헤더가 있으면 403을 돌려준다. Claude Code의 hook 요청에는 이 헤더가 없다.
  - 본문은 최대 1MB. 넘으면 413을 돌려준다.
  - `hook_event_name`, `session_id`가 문자열이 아니면 400을 돌려준다.
- **응답:** 저장한 뒤 즉시 `200`과 빈 본문을 돌려준다. **어떤 결정도 돌려주지 않는다.** 처리 중 예외가 나도 200을 돌려주고 로그만 남긴다. hook 쪽을 절대 막지 않기 위해서다.

**`EventStore` (`server/events/store.ts`)**
- 에이전트 키 `(session_id, agentName)`마다 최근 이벤트 20개를 원형 버퍼로 보관한다.
  - `agentName` 결정 규칙: `agent_id`가 없으면 `"team-lead"`. `TeammateIdle`이면 `teammate_name`. `agent_id`가 `a<16진수>` 형태가 아니면 팀원으로 보고 `agent_type`. 일반 서브에이전트(`a<16진수>`)는 **부모인 리드에 합친다**(활동 문장에 "서브에이전트" 표시).
- **저장할 때 요약한다.** `tool_input` 전체를 보관하지 않는다.
  - 필요한 필드만 남긴다: `command`, `description`, `file_path`, `pattern`, `query`, `url`의 도메인, `to`, `activeForm`, 질문 텍스트
  - 문자열은 각각 최대 200자로 자른다.
- 메모리에만 두고 파일로 쓰지 않는다.
- 세션마다 마지막 이벤트 시각을 기록한다. 세션이 종료되고 24시간이 지나면 버린다.

## 6. T1.3 활동과 결정 상태

에이전트마다 다음 두 값을 계산해 스냅샷에 넣는다(`server/events/derive.ts`, 순수 함수, `now` 주입).

**`activity`**: `{ kind, tool?, target?, startedAt }`
- **진행 중인 도구:** 가장 최근의 `PreToolUse` 중 짝이 되는 `PostToolUse`나 `PostToolUseFailure`가 아직 없는 것. 짝은 `tool_use_id`가 있으면 그것으로 찾고, 없으면 같은 에이전트의 다음 Post 이벤트로 본다.
- **할 일 목록의 activeForm:** `TodoWrite`, `TaskCreate`, `TaskUpdate`의 입력에서 `in_progress`인 항목의 `activeForm`
- **마지막 문장:** v1의 `readLastEntry`로 읽은 대화 기록의 마지막 assistant 문장
- 우선순위와 문장 틀은 디자인 명세 7.2절의 표를 **그대로** 따른다. 문장은 UI에서 만들고, 서버는 구조화된 값만 준다.
- `startedAt`은 해당 PreToolUse 시각이다.
- 진행 중인 도구가 10분 넘게 짝이 없으면 활동에서 뺀다. 이벤트를 놓친 경우에 대비한 것이다.

**`decision`** (표시 전용): `{ kind: "permission" | "question" | "plan", since, summary }`
- **올라가는 조건**
  - `PermissionRequest` → `permission`
  - `PreToolUse`의 `tool_name`이 `AskUserQuestion`이면 `question`, `ExitPlanMode`이면 `plan`
- **내려가는 조건**
  - 같은 에이전트의 `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop`, 또는 이후의 새 `PreToolUse`가 오면
  - 이벤트를 놓친 경우에 대비해, 올라간 지 30분이 지나면
- `summary`는 요약된 `tool_input`에서 만든다. 권한이면 명령이나 파일, 질문이면 첫 질문 텍스트다.
- Phase 1에는 `deadline`이 없다(기다리지 않으므로). Phase 2에서 추가한다.

**스냅샷 타입 확장 (`src/shared/types.ts`)**
- `MemberState`에 `"decision"`을 추가한다. 우선순위는 디자인 명세대로 `decision > working > mail > idle > offline`이다.
- `Member.activity?`, `Member.decision?`를 추가한다.
- `SessionView.floor`(층 번호)를 추가한다. **시작 시각이 가장 오래된 세션이 1F**다(사용자 확정).
- `SessionView.floorStatus`를 추가한다. 값은 `"working" | "idle" | "ended"`이고, `"paused"`는 Phase 4에서 추가한다.
- `Snapshot.decisionCount`를 추가한다. HUD의 "결정 대기 N" 칩에 쓴다.
- 이벤트로 `working`이 확인되면 v1의 파일 기반 판정(mtime 10초 규칙)보다 우선한다. 이벤트가 없는 에이전트는 v1 판정을 그대로 쓴다.

## 7. T1.7 `spend_limit`

- `readLimits`가 `rate_limits.spend_limit.used_percentage`와 `resets_at`을 읽는다.
- 사용률은 100을 넘을 수 있으므로 0~100으로 자르기 **전에** 원래 값도 보관한다.
- PLAN 바는 세 창(5H, WEEK, SPEND) 가운데 가장 많이 쓴 창을 보여준다(Ruling 15 확장). hint는 `"SPEND"`다.
- 초기화 시각이 지난 창은 v1 Ruling 13대로 버린다.

## 8. T1.4~T1.6 화면

`docs/design/phase1/SPEC.md`의 **2~7장, 10~12장**을 구현한다(8~9장 결정 보고서와 대화상자는 Phase 2). 값, 픽셀 맵, 문구는 그 문서를 기준으로 삼는다. 이 스펙과 디자인 명세가 다르면 디자인 명세가 이긴다. 기능 범위만 이 스펙이 정한다.

- **빌딩:** 지붕 간판, 맨 위 빈 층, 층들(1F가 가장 아래), 바닥
  - 층 머리: 이름, ★, 상태 칩, 결정 칩, CTX 바, **예산 바 자리("예산 없음")**, 컨트롤
- **컨트롤:** 모두 `aria-disabled="true"`에 투명도 0.4, title "아직 사용할 수 없습니다". 빈 층의 "새 세션 시작"도 같다.
- **종료된 층:** 처음에는 접혀 있다. 접힘 상태는 세션 id별로 `localStorage`에 기억한다(v1의 localStorage 원칙: 읽기와 쓰기를 try/catch로 감싼다).
- **엘리베이터(층 바로가기)와 HUD의 "결정 대기 N" 칩:** 칩을 누르면 가장 오래 기다린 결정이 있는 층으로 스크롤한다. 보고서는 Phase 2에서 연결한다.
- **말풍선:** 7장 규칙대로 만든다. 「」, 28자 자르기, `Intl.Segmenter`, 위치 계산, 150ms/100ms 타이밍을 따른다. 결정 대기 문장과 휴업 문장도 표에 있으므로 함께 구현한다. 휴업 문장은 Phase 1에서는 나오지 않는다.
- **손들기:** 6장대로 만든다. `BODY_UP` 프레임, ? 스프라이트, 콩콩/흔들림 애니메이션을 쓴다. 급함(남은 시간 60초 이하)은 Phase 2에서 켠다.
  - 책상은 `<button>`으로 만들지만, Phase 1에서는 눌러도 보고서가 열리지 않는다. title "결정 보고서는 다음 버전에서 열립니다"를 붙인다.
- **폰트:** Galmuri를 npm 패키지로 번들한다(3.1절). OFL 저작권 표시는 README와 `THIRD_PARTY_NOTICES.md`에 둔다.
- v1의 HUD, HeartBar, 도트 스프라이트 코드는 재사용한다. v1의 `OfficeGrid`와 `OfficeTile`은 `Building`과 `Floor`로 대체한다.

## 9. 오류 처리

| 상황 | 처리 |
|---|---|
| 서버가 꺼져 있음 | hook 연결 실패로 세션은 그대로 진행한다. 화면은 v1 판정으로만 동작한다. |
| 알 수 없는 `hook_event_name` | 저장만 하고 파생 계산에서 무시한다. |
| `tool_input`이 없거나 형식이 다름 | 요약 필드를 비운다. 활동 문장은 "그 밖의 도구" 틀을 쓴다. |
| 이벤트 순서가 어긋남 (Post가 Pre보다 먼저) | 짝이 없는 Post는 무시한다. |
| 이벤트 폭주 | 원형 버퍼 20개로 메모리가 제한된다. 파생 계산은 스냅샷 주기(최소 debounce 200ms)에만 한다. |
| 세션 파일은 없고 이벤트만 있음 | 층을 만들지 않는다. 층의 출처는 v1 세션 수집기다. 이벤트는 보강 정보다. |

## 10. 보안과 개인정보

- hook 입력에는 명령, 파일 경로, 질문 같은 작업 내용이 들어 있다. **요약 필드만 메모리에 둔다.** 파일, 로그, SSE에는 요약된 값만 나간다.
- `127.0.0.1` 바인딩, Host 검사, Content-Type 강제, Origin 거부로 외부 웹페이지의 위조와 열람을 막는다.
- 테스트 fixture에는 실제 토큰이나 명령 기록이 아닌 **가짜 값만** 쓴다.
- 팀은 `~/.claude` 설정을 수정하지 않는다. 플러그인은 실험 세션에서 `--plugin-dir`로만 로드한다.

## 11. 테스트

- **플러그인:** `hooks.json` 검증 테스트
  - 모든 이벤트가 있는가
  - 모든 URL이 `http://127.0.0.1:4317/hooks/event`인가
  - timeout이 5 이하인가
  - `make-dev-plugin`이 포트만 바꾸는가
- **수신 API:**
  - JSON이 아니면 415, Origin이 있으면 403, 잘못된 Host면 403, 1MB를 넘으면 413, 필수 필드가 없으면 400
  - 정상 요청이면 200과 빈 본문
  - 처리 중 예외가 나도 200
- **EventStore와 derive:**
  - 에이전트 이름 규칙 4가지(리드, 팀원, `TeammateIdle`, 서브에이전트 합치기)
  - 빈 `agent_type`인 `SubagentStop` 무시
  - 원형 버퍼 한도
  - 요약 필드와 200자 자르기
  - 진행 중인 도구의 짝 맞추기(`tool_use_id` 있을 때와 없을 때)
  - activeForm, 10분 만료
  - 결정 올리고 내리기(조건 5가지와 30분 만료)
  - 세션 24시간 정리
- **스냅샷:** 층 번호(가장 오래된 세션이 1F), `floorStatus`, `decisionCount`, 이벤트의 working이 파일 판정보다 우선
- **limits:** `spend_limit` 읽기, 100% 초과 원래 값 보존, PLAN 바에서 세 창 중 최댓값
- **UI (jsdom):**
  - 빌딩: 층 순서(위가 최신), 빈 층, 종료 층이 접혀 있음, localStorage가 실패해도 동작
  - 컨트롤 비활성
  - 말풍선 문장 규칙: 7.2절 표의 모든 행
  - 자르기: 파일은 가운데를 줄이고, 그 밖은 끝을 줄임, 공백 정리
  - 손들기 렌더링, 결정 칩 개수, 움직임 줄이기
- **디자인 일치:** reviewer가 디자인 명세의 토큰, 픽셀 맵, 문구를 대조한다.

## 12. 끝에서 끝까지 확인 (T1.8)

실험 폴더(`~/Code/claude_project/spikes/phase1/`)에서 진행한다.
1. 개발 서버를 4318에서 띄운다(v1 뷰어 4317은 그대로 둔다).
2. `make-dev-plugin --port 4318`로 만든 플러그인을 `claude --plugin-dir …`로 Haiku 실험 세션에 로드한다.
3. 실험 세션에서 차례로 실행한다.
   - Bash 명령 → 말풍선에 「설명」 명령 문장이 나오는지
   - 파일 쓰기 권한 요청 → 손들기와 ?가 뜨는지. 터미널에서 허용하면 내려가는지
   - `AskUserQuestion` → 질문 대기 표시
   - 팀원 하나를 스폰 → 팀원 책상에 활동이 나오는지
4. `/api/snapshot`으로 `activity`와 `decision` 값을 확인한다. 화면은 사용자가 Safari로 본다.
5. 안전 규칙: `settings.json` 체크섬을 전후로 비교하고, 실험 세션과 서버를 정리한다. 4317은 건드리지 않는다. 자격 증명은 읽지 않는다.

## 13. 완료 기준

1. 플러그인을 로드한 실험 세션의 도구 실행이 **2초 안에** 말풍선 문장으로 나타난다.
2. 권한 요청과 질문이 뜨면 해당 캐릭터가 손을 든다. 터미널에서 답하면 2초 안에 내려간다.
3. 플러그인이 없거나 서버가 꺼져 있어도 v1과 같은 수준으로 표시되고, Claude Code 세션은 영향을 받지 않는다.
4. 화면이 디자인 명세 2~7장과 일치한다(reviewer 대조, 사용자 육안 확인).
5. 테스트, 타입 검사, 빌드가 통과한다. 이때 v1 테스트 158개도 전부 통과해야 한다.
