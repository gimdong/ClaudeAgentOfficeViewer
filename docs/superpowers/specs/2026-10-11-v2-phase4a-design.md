# v2 Phase 4a — 층 관리(일시정지·재개, 종료, 삭제) 설계 스펙

- 작성 2026-10-11, 사용자 승인(대화) 뒤 작성. 바탕 문서: v2 계획(Phase 4 T4.1·T4.2), Phase 0 보고서, Phase 3 스펙(예외 도구·관문 순서).
- Phase 4를 둘로 나눈다(사용자 결정 2026-10-11). **4a**(이 문서): 일시정지/재개, 종료, 삭제. **4b**: 실행 중인 층에 작업 지시, 새 층 만들기 — channel 스파이크 뒤에 따로 설계한다.
- 이 문서에는 실제 사용자 이름·홈 경로를 적지 않는다.

## 1. 목적

사용자가 대시보드에서 층(세션)을 **멈추고, 다시 돌리고, 끄고, 목록에서 치울** 수 있게 한다. Phase 1이 비워 둔 층 머리의 제어 버튼 자리(`web/building/FloorControls.tsx`, 디자인 A8)를 채운다.

사용자 결정(2026-10-11):
- 종료: 확인 창 → SIGTERM → 10초 뒤에도 살아 있으면 한 번 더 확인 → SIGKILL.
- 삭제: 세션 기록 파일은 건드리지 않고 대시보드에서만 숨긴다.
- 일시정지 범위: 그 층의 리드·팀원·서브에이전트 모두. 예외는 Phase 3의 예외 도구 9개와 같다.
- 저장: 서버 메모리만. 대시보드를 껐다 켜면 모두 "영업 중"으로 돌아오고 숨긴 층도 다시 보인다.

## 2. 전제 (코드에서 확인, 스파이크 불필요)

| # | 전제 | 근거 |
|---|---|---|
| P1 | 세션 레코드에 `pid`와 `procStart`가 있고, `ProcStartMatcher`가 pid 재사용을 가려낸다 | `server/collectors/sessions.ts` `SessionRecord`, `defaultProcStartMatcher` |
| P2 | PreToolUse hook의 `permissionDecision: "deny"` + `permissionDecisionReason`이 리드·팀원·서브에이전트 모두에게 적용된다 | Phase 3 끝에서 끝까지 확인(스펙 3 §14) |
| P3 | 예외 도구 9개는 `server/policy/tools.ts` `EXEMPT_TOOLS` 하나로 관리된다 | Phase 3 + TaskStop 결정(72fa75b) |
| P4 | 팀원은 리드와 같은 프로세스 안에서 돈다. 리드 프로세스가 끝나면 팀원도 끝난다 | agent team 동작(CLAUDE.md) |
| P5 | 끝난 세션은 `updatedAt`에서 1일 지나면 목록에서 빠진다 | `readSessions`의 `DAY` 기준 |

P4가 틀리면(팀원이 별도 프로세스) 종료 뒤 남은 프로세스를 목록에 그대로 보이게 두고 설명서에 적는다. 다른 전제는 코드가 근거이므로 틀릴 수 없다.

## 3. 상태 모델

새 모듈 `server/floors/control.ts`, 메모리만.

```ts
interface FloorControl {
  paused: Set<string>;                              // sessionId
  pausedDenied: Map<string, number>;                // sessionId → 막힌 호출 수(켠 뒤로)
  hidden: Set<string>;                              // sessionId
  terminating: Map<string, { sentAt: number; force: boolean }>;
}
```

- 스냅샷을 만들 때(`SnapshotBuilder.build`) `alive=false`인 세션은 `paused`·`pausedDenied`·`terminating`에서 지운다. `hidden`은 세션 레코드가 목록에서 사라질 때(P5) 지운다 — 살아 있는 동안 지우지 않는다.
- 상한: 세 집합 모두 세션 수만큼이라 따로 두지 않는다.

## 4. 일시정지·재개

### 4.1 API
- `POST /api/floors/:id/pause`, `POST /api/floors/:id/resume`. 본문 없음. 200 `{ paused: boolean }`.
- 살아 있지 않은 세션이면 409 `{ error: "ended" }`. 이미 같은 상태면 200(멱등).
- 보호: `/api/policy`와 같은 토큰 쿠키 + `sameOrigin`.

### 4.2 hook 관문
`/hooks/event`의 PreToolUse 처리 순서를 다음으로 한다. 일시정지가 가장 넓은 규칙이므로 맨 앞이다(Phase 3 Ruling B79의 논리와 같다. 앞 관문이 뒤 관문에 부작용을 남기지 않는다).

1. **일시정지 deny** (새로 추가)
2. 정책 deny
3. 예산 관문
4. 정책 ask

판정:
- `session_id`가 `paused`에 있고 `tool_name`이 `EXEMPT_TOOLS`에 없으면 deny. 예외 도구는 그대로 통과(리드가 `AskUserQuestion`으로 사용자에게 물을 수 있고, `TaskStop`으로 팀을 내릴 수 있다).
- 응답은 정책 deny와 같은 모양(`hookSpecificOutput.permissionDecision: "deny"`, `permissionDecisionReason`).
- 이유 문구(고정, 설명서와 테스트가 대조): `대시보드 일시정지: 사용자가 대시보드에서 이 세션을 일시정지해 지금은 이 도구를 쓸 수 없습니다. 사용자가 대시보드에서 스위치를 "영업 중"으로 돌리면 다시 쓸 수 있습니다. 기다리거나 사용자에게 알려 주세요.` (2026-10-11 교정, Ruling B122: 원문 "…\"영업 중\" 스위치를 켜 주세요"는 멈춘 동안의 라벨이 "멈춤"이라 틀렸고, 받는 쪽인 Claude가 할 수 없는 일을 시켰다. 머리말 "대시보드 일시정지:"로 정책 문구와 구별한다. 라벨은 "영업 중"↔"멈춤"으로 통일한다)
- deny할 때 `pausedDenied[session]++`, 로그 `floors`/`paused-deny`(세션 id·도구 이름만. tool_input은 읽지 않는다).
- 정책 deny처럼 예산 관문·큐·이벤트 저장소를 거치지 않는다(막힌 호출이 "작업 중"으로 남지 않게).
- PreToolUse가 아닌 이벤트(PostToolUse, Stop, Notification 등)는 일시정지와 무관하게 그대로 처리한다.
- 판정에서 예외가 나면 로그만 남기고 일시정지가 없는 것처럼 이어 간다(정책과 같은 규칙).

### 4.3 결정 큐와의 관계
- 일시정지 전에 큐에 올라온 결정은 그대로 둔다. 사용자가 대시보드나 터미널에서 답할 수 있다.
- 일시정지 중에는 PreToolUse에서 막히므로 새 PermissionRequest가 오지 않는다. 예외 도구의 `AskUserQuestion`은 Phase 2대로 큐에 올라온다.
- 재개하면 다음 도구 호출부터 평소대로다. 막힌 동안의 호출은 다시 실행되지 않는다(Claude가 deny 이유를 보고 스스로 재시도하거나 사용자에게 묻는다).

### 4.4 스냅샷
- `SessionView.floorStatus`에 `"paused"`를 더한다(`FloorStatus = "working" | "idle" | "paused" | "ended"`). `paused`에 있고 살아 있으면 구성원 상태와 무관하게 `"paused"`.
- `SessionView.pausedDenied?: number` — 켠 뒤로 막힌 호출 수. 일시정지 층에만 넣는다.
- 구성원(`Member`)은 바꾸지 않는다. 책상은 평소대로 그린다(일시정지 중에도 대화 기록은 바뀔 수 있다).

## 5. 종료

### 5.1 API
- `POST /api/floors/:id/terminate`, 본문 `{ force?: boolean }`. 200 `{ signal: "SIGTERM" | "SIGKILL" }`.
- 서버 검사(모두 통과해야 신호를 보낸다):
  1. 세션 레코드가 있고 `alive`다. 아니면 409 `{ error: "ended" }`.
  2. `pid !== process.pid`. 같으면 400 `{ error: "self" }`(생길 수 없지만 막는다).
  3. `ProcStartMatcher(pid, procStart)`가 `true`다. `false`면 409 `{ error: "pid-reused" }`, `undefined`(확인 불가)면 **보내지 않고** 409 `{ error: "unverified" }`. 생존 판정은 "살아 있는 쪽으로" 기울지만, 신호는 "보내지 않는 쪽으로" 기운다.
  4. `force`가 아닌데 `terminating`에 이미 있으면 200(멱등, 다시 보내지 않는다).
- 신호: `force ? "SIGKILL" : "SIGTERM"`. `terminating.set(id, { sentAt, force })`. 로그 `floors`/`terminate`(세션 id·신호 이름만).
- 신호 보내기는 `BuilderOptions.isAlive`처럼 **주입**한다(`signal?: (pid, sig) => void`). 테스트는 가짜를 넣고, 실제 `process.kill`은 `server/index.ts`에서만 묶는다.
- 보호: pause와 같다.

### 5.2 화면 흐름
1. "종료" 버튼 → 확인 창. 내용: 층 이름, 폴더(`cwd`), "팀원 N명 · 작업 중 M명", 문장 `이 세션을 끕니다. 대화 기록은 남지만, 하던 작업은 끊깁니다.` ★ 현재 세션(`isCurrent`)이면 경고 한 줄 추가: `지금 이 대시보드를 켠 세션입니다. 끄면 이 터미널의 Claude Code도 끝납니다.`
2. "끄기" → `terminate` → 층 칩이 "종료 중"으로 바뀐다(`terminating`에 있으면 `floorStatus`는 그대로, `SessionView.terminating: true`).
3. 10초 뒤에도 `alive`면 두 번째 확인 창: `아직 켜져 있습니다. 강제로 끌까요? 저장되지 않은 작업이 사라질 수 있습니다.` "강제로 끄기" → `terminate {force:true}`.
4. 끝나면 평소의 "종료됨 HH:MM" 층이 된다. 종료 뒤 `paused`에서도 빠진다.
- 두 확인 창 모두 `BudgetDialog`의 패턴(role=dialog, 포커스 트랩, Esc 닫기, `useLayoutEffect` 포커스)을 따른다.
- 409를 받으면 창에 한 줄 안내: `ended` → `이미 끝난 층입니다.`, `pid-reused`/`unverified` → `이 세션의 프로세스를 확인하지 못해 끄지 않았습니다. 터미널에서 직접 끝내 주세요.`

## 6. 삭제(숨김)

- `POST /api/floors/:id/hide`: `floorStatus === "ended"`인 세션만. 살아 있으면 409 `{ error: "alive" }`. 200 `{ hidden: number }`(숨긴 수).
- `DELETE /api/floors/hidden`: 모두 다시 보이기. 200 `{ hidden: 0 }`.
- 스냅샷: 숨긴 세션은 `sessions`에서 뺀다. 층 번호(`floor`)는 숨긴 뒤 남은 세션으로 다시 매긴다(1F = 가장 오래된 세션, Phase 1 규칙 유지). `Snapshot.hiddenFloors: number`를 더한다.
- 화면: 끝난 층의 "삭제" 버튼 → 바로 숨긴다(확인 창 없음 — 되돌릴 수 있고 데이터를 지우지 않는다). 빌딩 맨 아래에 `hiddenFloors > 0`일 때만 "숨긴 층 N개 · 모두 보이기" 버튼. 층별 되돌리기는 두지 않는다.
- 숨긴 층이 다시 살아나는 일은 없다(끝난 세션만 숨길 수 있다). `claude --resume`으로 같은 id가 다시 살아나면 숨김을 풀고 보인다(살아 있는 세션은 숨기지 않는다는 규칙이 우선).

## 7. 화면

- `FloorControls`: `aria-disabled`를 떼고 동작을 붙인다.
  - 스위치: `aria-checked`가 영업 중이면 true. 라벨 "영업 중" ↔ "멈춤". 누르면 pause/resume. 요청 중에는 잠근다.
  - "종료" 버튼(위험 색). 끝난 층에는 "삭제" 버튼만.
  - "작업 지시" 버튼은 4b까지 그대로 `aria-disabled`, 제목 `아직 사용할 수 없습니다`.
- 일시정지 층: `floor--paused`로 방을 어둡게 하고, 방 안에 "휴업" 팻말(텍스트가 들어간 도트 스프라이트, 색만으로 알리지 않는다). 칩 "멈춤"(`chip--paused`), LED 회색 계열. 머리 요약에 `· 막힌 호출 N`(`pausedDenied > 0`일 때).
- 종료 중: 칩 "종료 중".
- 접근성: 스위치 상태 변경·종료 결과는 기존 `aria-live` 알림 경로(예산 저장과 같은 `announce`)로 읽어 준다.
- HUD·엘리베이터·단축키는 바꾸지 않는다.
- 디자인 명세는 designer가 `docs/design/phase4a/SPEC.md`에 쓰고, 설명서 그림은 `docs/design/phase4a/manual-figures/`에 둔다. 그림에는 `fakeuser` 같은 가짜 이름만 쓴다.

## 8. 한계 (화면과 설명서에 그대로 적는다)

1. 일시정지와 숨김은 대시보드가 켜져 있는 동안만이다. 대시보드를 끄면 모두 영업 중으로 돌아오고 숨긴 층도 다시 보인다. 보안 장치가 아니다(Phase 3 한계 1과 같다).
2. 일시정지는 다음 도구 호출부터 막는다. 이미 생각 중인 문장은 끝까지 나오고, 터미널 입력에 대한 답도 이어진다. 도구만 막힌다.
3. 종료는 프로세스 신호다. "하던 일을 정리하고 끝내기"는 channel이 필요해 4b에서 다룬다.
4. 리드·팀원·서브에이전트를 따로 멈출 수는 없다. 그건 Phase 3의 권한 정책("모든 도구 금지")으로 한다.

## 9. 로그·진단·doctor

- 로그 종류 `floors`: `pause`, `resume`, `paused-deny`, `terminate`, `hide`, `unhide`. 세션 id·도구 이름·신호 이름만. 명령·경로·tool_input은 넣지 않는다.
- 진단 묶음(bundle)에 현재 `paused`·`hidden`·`terminating` 수를 더한다(id는 넣지 않는다).
- doctor 항목은 추가하지 않는다.

## 10. 설치·제거·사용설명서

- 설치 스크립트·플러그인 hooks.json은 바꾸지 않는다(기존 PreToolUse hook을 그대로 쓴다).
- 사용설명서에 "층 관리" 장을 더한다: 스위치, 종료(두 단계), 삭제(숨김), 한계 4개, 이유 문구. `test/scripts/manual.test.ts`가 이유 문구·한계 문장을 코드와 대조한다.

## 11. 완료 기준

1. 단위: 관문 순서(일시정지 deny가 정책·예산보다 먼저), 예외 도구 통과, 횟수, 409 경로(ended/self/pid-reused/unverified/alive), 멱등, 스냅샷 `paused`/`terminating`/`hiddenFloors`/층 번호 재매김, 자동 정리(끝난 세션).
2. 변이 확인: procStart 검사를 빼면 `pid-reused` 테스트가 실패한다. 예외 도구 집합에서 하나를 빼면 통과 테스트가 실패한다.
3. UI(jsdom): 스위치·확인 창 두 단계·삭제·모두 보이기, 포커스 복귀, aria 문구.
4. 실제 세션(job tmp `CLAUDE_CONFIG_DIR`, 포트 4319 이상, 실제 claude 절대 경로):
   - 일시정지 → 팀원과 리드의 Bash가 위 이유 문구로 막힌다 → 재개 → 다음 Bash가 통과한다.
   - 종료 → SIGTERM으로 프로세스가 끝나고 층이 "종료됨"이 된다. 가짜 pid·procStart로 `pid-reused`가 거부된다.
   - 끝난 층 삭제 → 목록에서 빠지고 "모두 보이기"로 돌아온다.
5. 정적 렌더로 일시정지 층·확인 창·숨김 버튼 배치 확인(qlmanage, 900·1200폭).
6. 누출 검사: 로그·진단에 명령 원문, 경로, 사용자 이름, 토큰 없음.
7. 단독 최종 확인: 새 worktree, `npm ci`, 전체 테스트 3회, typecheck.

## 12. 범위 밖

- 작업 지시, 새 층 만들기(4b).
- 세션 기록 파일 삭제, `~/.claude` 쓰기.
- 일시정지·숨김의 파일 저장.
- 에이전트 단위 일시정지(정책으로 대신한다).
- 종료 전 "정리 요청"(channel).

## 13. 위험

| 위험 | 대응 |
|---|---|
| 잘못된 프로세스에 신호 | procStart 일치할 때만, 확인 불가면 보내지 않음(5.1). 서버 자신 거부. |
| 사용자가 현재 세션(★)을 끈다 | 확인 창에 경고 한 줄. 막지는 않는다(사용자 결정). |
| 팀원이 별도 프로세스라 남는다(P4 틀림) | 실제 세션 확인에서 드러나면 설명서에 적고 목록에 그대로 보인다. |
| 팀의 테스트가 실제 세션·사용자 대시보드에 신호를 보낸다 | 신호 주입(5.1), 실험 세션만, pid는 세션 레코드에서만, PID로만 끈다(B113). 사용자 4317과 그 세션은 어떤 경우에도 대상이 아니다. |
| 일시정지가 "멈춘 것처럼 보이는데" 터미널에서는 계속 답한다 | 한계 2를 화면 팻말 툴팁과 설명서에 적는다. |

## 14. 실행 뒤 확인된 것과 남은 위험 (2026-10-12, 구현 `feat/v2-phase4a`)

1–13장은 승인 당시 그대로 둔다(4.2의 이유 문구만 B122로 승인 뒤 교정했다). 판정 원문은 진행 기록(`.superpowers/sdd/2026-10-11-v2-phase4a/progress.md`)의 Ruling B114–B141에 있고, 계획 문서의 "실행 중 바뀐 것" 절에 모았다.

### 14.1 확인된 것 — 모델 없이 (Task 11 Part A, 실험 서버 4319, job tmp claude home에 우리가 쓴 세션 레코드와 우리가 띄운 `sleep`)
| 확인 | 결과 |
|---|---|
| procStart가 맞지 않는 레코드(pid = 우리 sleep) | 스냅샷에서 이미 `ended`, `terminate` 409 `ended`, sleep은 살아 있음(신호 없음) |
| procStart가 없는 레코드 | 409 `unverified`, 신호 없음 |
| procStart를 그 sleep의 실제 시작 시각(`LC_ALL=C TZ=UTC ps -o lstart=`)으로 | 200 `SIGTERM`, 우리 sleep만 끝나고 다음 스냅샷에서 `ended` |
| 숨김 | 살아 있는 층 409 `alive`. 끝난 층을 숨기면 목록에서 빠지고 층 번호가 다시 매겨지며 `hiddenFloors: 1`. `DELETE /api/floors/hidden` 뒤 돌아옴 |
| 진단 파일 | `diag --port 4319`로 생성(qa 누출 검사용) |

- 첫 실행에서 SIGTERM 항목이 409 `unverified`였다. 실험 스크립트가 procStart를 한국어 로케일 `ps` 출력으로 적었기 때문이다. 서버는 의도대로 "판단 불가 → 보내지 않음"으로 답했다.
- 신호는 우리가 기록한 PID에만 갔다(남은 sleep도 기록한 PID로만 정리, B113).

### 14.2 확인된 것 — 실제 세션 (Task 11 Part B)
구성: 실제 `claude`(절대 경로), `--plugin-dir` 사본(4319), `--model sonnet --permission-mode auto`, 팀원 in-process, 모든 창은 `caffeinate -s -i` 아래. 프롬프트 2개.

| # | 확인 | 결과 |
|---|---|---|
| B0 | `CLAUDE_CONFIG_DIR`을 job tmp로 띄우기 | 온보딩(테마 선택) 화면이 떠 모델 호출 없이 내리고, Phase 3 구성(실제 HOME, 서버는 기본 claude home 읽기)으로 바꿨다(B119대로) |
| B1 | 일시정지 → "팀원 rev를 만들어 Bash, 너도 Bash" | 리드의 `Agent`(팀원 만들기)와 `Bash`가 둘 다 막혔다. 이유는 `PreToolUse:Agent hook error:` / `PreToolUse:Bash hook error:` 앞말 뒤에 `PAUSED_REASON` 글자 그대로. 스냅샷 `paused`, `pausedDenied: 2` ✅ |
| B2 | 재개 → 리드와 새 팀원 rev가 각각 Bash | 둘 다 통과(`p4-free`). 스냅샷 idle ✅ |
| B3 | 종료(SIGTERM) | 세션 레코드의 pid(procStart 일치)인 실험 claude가 끝났다(종료 코드 143). **팀원 rev는 별도 프로세스가 아니었고 함께 끝났다(P4 맞음).** 층은 `ended`로 남지 않고 목록에서 사라졌다(아래 14.3) ✅ |
| B4 | 끝난 층 숨김·모두 보이기 | 대상이 없어 생략. Part A의 숨김 항목으로 갈음했다(team-lead 판정 — 레코드를 남기려고 SIGKILL로 끝내면 사용자 claude home에 죽은 레코드를 남기게 된다) |

- **B143(관찰):** 일시정지 중에는 `Agent`(팀원·서브에이전트 만들기)도 막힌다. 예외 도구 아홉 개에 `Agent`가 없으므로 스펙대로다. 그래서 계획 B1의 "rev의 Bash"는 rev가 생기지 않아 시도되지 않았다. 막힌 두 호출은 리드의 Agent·Bash다.
- 재개 직후 한 번 찍은 스냅샷에는 아직 `paused`가 남아 있었다(스냅샷 주기, B117의 "들고 있기"가 화면에서 가리는 틈).
- 대상 세션은 cwd가 job tmp 작업 폴더인 세션 id 하나뿐이었다. 실험 대시보드에 함께 보인 사용자 세션에는 아무 요청도 보내지 않았다.

### 14.3 스펙과 다른 점
- **11장 4의 "가짜 pid·procStart로 `pid-reused`가 거부된다"는 실제 서버로 닿지 않는다(B123 I2, B140).** 세션 목록을 읽는 단계(`readSessions`)가 이미 procStart를 확인해 맞지 않는 레코드를 `alive: false`로 만든다. 그래서 `terminate`는 검사 1에서 `ended`를 돌려준다(14.1 첫 줄). `pid-reused` 분기는 "빌드 때는 맞았는데 그 뒤 3초 안에 pid가 재사용된" 경쟁에서만 닿는 방어선이다. 주입 레코드를 쓴 단위·API 테스트로만 덮는다.
- **SIGTERM으로 끄면 층이 "종료됨"으로 남지 않고 목록에서 사라진다(B142, 5.2-4·11.4와 다름).**
  - Claude Code는 SIGTERM에 정상 종료하며 자기 세션 레코드(`sessions/<pid>.json`)를 지운다. 그래서 스냅샷에서 층이 빠진다.
  - 서버 쪽은 문제가 없다(sweep이 목록에 없는 id를 paused·terminating에서 비움).
  - "종료됨" 층으로 남는 것은 레코드가 남는 경우, 곧 SIGKILL(강제로 끄기)이나 충돌뿐이다. 끝난 층의 삭제(숨김)도 그 경우에만 쓰인다.
  - 화면의 "꺼짐" 알림(B124 ⑧)은 층이 `ended`로 바뀔 때만 나오게 되어 있어, 보통 경로(층이 사라짐)에서 빠졌다. 이 화면에서 끈 층이 사라질 때도 알리도록 고쳤다(developer #334).
- **종료 검사를 하나 더 둔다(B123):** pid가 정수이고 1보다 클 때만 신호를 보낸다(`kill(0)`은 서버 자신의 프로세스 그룹, 1은 init). signal이 던지면 ESRCH는 `ended`, 그 밖은 `unverified`이고 "종료 중"으로 남기지 않는다.
- **로그의 세션 표시는 세션 id가 아니라 순번이다(B123):** 9장의 "세션 id"보다 좁혔다(Phase 2 결정 큐와 같은 방식). `paused-deny` msg는 고정이고 도구 이름은 data에만 있다(B128).
- **화면(B124, 7장):**
  - 한계 2 툴팁은 팻말이 아니라 멈춤 칩의 `title`과 스위치의 `aria-describedby`에 있다.
  - `· 막힌 호출 N`은 머리 요약이 아니라 칩 바로 뒤에 있다.
  - "방을 어둡게"는 셔터로 갈음했다.
  - 이유 문구와 라벨은 B122다(스위치·칩은 "멈춤", 팻말·말풍선은 Phase 1의 "휴업").
- **응답 값을 들고 있기(B117·B127):** 스냅샷이 3초 늦으므로 스위치·종료 중 칩·숨김·"다시 불러오는 중"은 응답 값을 최대 6초 들고 있는다. 숨긴 층은 그 세션이 alive로 오면 즉시 다시 보인다.

### 14.4 남은 위험과 정리
- **Windows 미검증(B141):** 코드상 종료는 늘 `unverified`(보내지 않음)다. readSessions가 win32에서 matcher를 건너뛰고, terminate의 matcher는 `ps` 실행·파싱에 실패하면 판단 불가이기 때문이다. 안전한 쪽이지만 실기 확인 전이다.
- **팀원이 리드와 함께 끝나는지(P4):** in-process 팀원은 확인됐다(14.2 B3). 팀원을 별도 터미널 창(tmux·iTerm 분할)으로 띄우는 방식은 확인 전이다(Phase 3 B94와 같음).
- **범위 밖 화면 항목(B134):** 빈 층 안내 문장이 좁은 폭에서 한 글자씩 꺾이는 것은 Phase 1 화면이라 이번에 고치지 않았다.
- **정리 항목(B135·B140, 증상 없음):**
  - 말풍선용 멈춤 값 `pausedOf`가 React 상태가 아닌 모듈 전역 Map이다(갱신이 렌더 순서와 다른 리렌더에 기댐, 테스트끼리 상태를 나눔).
  - `FloorControl.sessionNo`가 지워지지 않는다(사용자가 조작한 세션 수만큼).
  - 미룬 둘째 종료 창이 200ms 주기로 확인한다.
- **설치 스크립트·런처의 마지막 doctor는 기본 포트 4317을 조회한다**(Phase 3 B109와 같음, 사용자 PC의 정상 동작).
- **간헐 실패는 원인이 확정됐다(B136·B137):** 시스템 잠자기다. 테스트 결함이 아니다. 단독 확인은 `caffeinate -s -i` 아래에서 한다.
- 한계 1~4(8장)는 그대로다. 일시정지·숨김은 대시보드가 켜져 있는 동안만이고 보안 장치가 아니다. Phase 2 13장의 가짜 hook 위험도 그대로다. 세션 id를 아는 같은 PC의 프로세스는 가짜 PreToolUse로 "막힌 호출" 수를 늘릴 수 있다(일시정지한 세션에만, 표시만).
