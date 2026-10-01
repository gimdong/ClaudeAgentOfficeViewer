# v2 Phase 2 확인 스파이크 (Task 0)

- 날짜: 2026-10-02, 실행: developer (배정 #123), 기준 HEAD `35224fe`
- Claude Code: 시작 시 `2.1.286`, 첫 세션 시작 직후 자동 업데이트로 **`2.1.287`**. 모든 시나리오(S1~S3)는 2.1.287에서 실행.
- 모델: `--model sonnet`. 리드 세션만 썼다(팀원·서브에이전트의 PermissionRequest는 확인하지 않음).
- 증거 폴더: `$CLAUDE_JOB_DIR/tmp/spike2/` (`/Users/gdh/.claude/jobs/034395cd/tmp/spike2/`, 커밋하지 않음). 판정은 director가 한다.

## 1. 안전 값

| 항목 | 시작 (06:42:57) | 끝 (06:55:58) |
|---|---|---|
| `~/.claude/settings.json` sha1 | `8aad40373b0e9a196d0c8e5e6250aab5468476a6` | 같음 |
| `known_marketplaces.json`의 `claude-office` | 3 | 3 |
| `~/.claude-office/VERSION` | `2.0.0-beta.1`, sha1 `56f848cf…0e03`, mtime Oct 1 22:31:40 | 같음 |
| `~/.zshrc` mtime | Oct 1 22:31:40 | 같음 |
| 4317 리슨 PID | 32825 | 32825 |
| 4319 리슨 | 없음 | 없음(수신기 종료) |
| tmux `-L spike2` | — | 서버 없음(kill-server) |

원본: `safety-before.txt`, `safety-after.txt`. 실험 세션이 평소처럼 남긴 것(안전 값 밖): 세션 기록(`~/.claude/projects/…`), 작업 폴더 신뢰 등록(`~/.claude.json`), S2 계획 파일 `~/.claude/plans/plan-only-make-a-inherited-heron.md`.

## 2. 방법

- `receiver.mjs`: `127.0.0.1:4319/hooks/event`. `{t, n, event, tool, keys, toolInputKeys, hasToolUseId}`만 `events.jsonl`에 쓴다(값은 남기지 않음). 요청마다 `scenario.json`을 다시 읽어 이벤트·도구별 응답 JSON과 지연(초)을 정한다. `res.on("close")`에서 `writableEnded`를 기록한다.
- 플러그인 사본: `node scripts/make-dev-plugin.mjs --port 4319 --out spike2/plugin`, 사본의 `PermissionRequest` timeout만 600(나머지 5).
- `run.mjs`: `spawnSync("/opt/homebrew/bin/tmux", ["-L","spike2",…], { env })`. `env`는 `{ HOME: "/Users/gdh", USER: "gdh", PATH: "<claude 버전 폴더>:/usr/bin:/bin", TERM }`만 명시(`process.env` 펼치지 않음). 명령은 `readlink ~/.local/bin/claude`의 절대 경로 + `--plugin-dir <사본> --model sonnet --permission-mode <모드>`. 시작 전 `realpath`로 작업 폴더·플러그인 사본이 job tmp 아래인지 확인.
- 계획과 다른 점 두 가지:
  1. **`USER` 추가.** `HOME`·`PATH`·`TERM`만으로는 첫 프롬프트에 "Not logged in · Please run /login"이 떴다(그 캡처는 같은 이름 `pane-s1a-window.txt`로 다시 찍으며 덮어써져 파일로는 남지 않음). 베타 B24 Step 4 선례(`HOME`·`PATH`·`USER`·`TERM`)대로 `USER`를 더해 로그인됨. 비밀값 아님.
  2. **`--permission-mode default` 명시.** 이 Mac의 기본 모드가 auto라 첫 세션이 "auto mode on"으로 열렸다(`pane-start2.txt`). S1 (a) "평소 권한 창이 뜨는 도구" 조건을 맞추려고 default(manual)로 다시 열었다. S2는 `plan`.
- 참고: 좁힌 PATH 때문에 사용자 전역 설정의 다른 command hook(SessionStart·UserPromptSubmit)이 `node: command not found`로 실패한다(non-blocking, 우리 http hook과 무관). 우리 수신기에 `SessionStart`는 한 번도 오지 않았다(다른 이벤트는 모두 옴).

## 3. 결과 요약

| # | 질문 | 결과 | 증거 |
|---|---|---|---|
| S1 (a) | Write에 `PreToolUse` `ask` → `PermissionRequest`가 오는가 | ✅ 창 뜸 + PermissionRequest 옴(27ms 뒤) | `ev-upto-s1a.jsonl` n5–6, `pane-s1a-window.txt`, `pane-s1a-after.txt` |
| S1 (b) | Read(평소 자동 허용)에 `ask` → `PermissionRequest`가 오는가 | ✅ 창("Do you want to proceed?") 뜸 + PermissionRequest 옴(26ms 뒤) | `ev-upto-s1b-allow.jsonl` n12–13, `pane-s1b-window.txt` |
| S1b | 이어 온 PermissionRequest에 hook이 답하면 적용되는가 | ✅ allow(3초 뒤) → "Allowed by PermissionRequest hook", 실행됨. deny + message(3초 뒤) → "Denied by PermissionRequest hook", 실행 안 됨, Claude가 message 원문을 받음 | allow: `pane-s1b-allow-after.txt`, n13–14. deny: `ev-upto-s1b-deny.jsonl` n18–20, `pane-s1b-deny.txt` |
| S1c | PermissionRequest 입력의 키 | 아래 4절. **`tool_use_id` 없음**, 리드 세션에서는 `agent_id`·`agent_type`도 없음, `permission_suggestions`는 Write에만 | `events.jsonl` |
| S2 | ExitPlanMode가 PermissionRequest를 거치고 allow·deny가 동작하는가 | **부분: PermissionRequest는 옴. deny ✅, allow ❌** | 아래 5절 |
| S3 | 붙잡은 연결이 5분을 넘겨도 살아 있는가 | ✅ 330초 뒤 allow → "Allowed by PermissionRequest hook", 파일 생성 | `ev-s3.jsonl` n54(21:49:56 → 21:55:26 replied, `writableEnded:true`), `pane-s3-window.txt`, `pane-s3-mid150.txt`, `pane-s3-after.txt` |

## 4. S1c — 이벤트별 키 (2.1.287, 리드 세션)

| 이벤트 | 키 |
|---|---|
| PreToolUse | `cwd, effort, hook_event_name, permission_mode, prompt_id, scratchpad_dir, session_id, tool_input, tool_name, tool_use_id, transcript_path` |
| **PermissionRequest (Write)** | `cwd, effort, hook_event_name, permission_mode, permission_suggestions, prompt_id, scratchpad_dir, session_id, tool_input, tool_name, transcript_path` |
| PermissionRequest (Read, ExitPlanMode) | 위에서 `permission_suggestions`만 없음 |
| PostToolUse | PreToolUse 키 + `duration_ms, tool_response` (`tool_use_id` 있음) |
| Notification | `cwd, hook_event_name, message, notification_type, prompt_id, scratchpad_dir, session_id, transcript_path` |

- `tool_input` 키: Write `content, file_path` / Read `file_path` / ExitPlanMode `plan, planFilePath`.
- **`tool_use_id`는 PermissionRequest에 없다.** PreToolUse·PostToolUse에는 있다. 짝을 찾으려면 `session_id` + `prompt_id` + `tool_name` + `tool_input` 비교가 필요하다(PreToolUse→PermissionRequest 간격은 매번 10~30ms).
- `agent_id`·`agent_type`: 리드 세션의 PermissionRequest에는 없음. 팀원·서브에이전트의 PermissionRequest는 이번에 확인하지 않았다.
- `prompt_id`, `scratchpad_dir`, `effort`는 Phase 0 기록에 없던 키다.

## 5. S2 — ExitPlanMode 상세

`--permission-mode plan`, "계획만 세워 줘"로 유도. 매번 PreToolUse(ExitPlanMode) 직후 PermissionRequest(ExitPlanMode)가 왔고 터미널에 "Ready to code? … Would you like to proceed?" 창이 떴다.

| 시도 | hook 응답 | 결과 | 증거 |
|---|---|---|---|
| deny ×3 | `deny` + `message`, 5초 뒤 | ✅ 창 닫힘 → "Error: <message>" + "Denied by PermissionRequest hook". **plan 모드 유지**, Claude가 message대로 계획을 고쳐 다시 제출(그래서 3번 반복됨) | `ev-s2-deny.jsonl` n29·33·37, `pane-s2-deny-window.txt`, `pane-s2-allow-after.txt`(첫 캡처에 deny 결과와 "plan mode on") |
| allow | `allow`, 5초 뒤 | ❌ 응답은 전달됨(`writableEnded:true`) 그러나 창이 그대로 남음(30초 이상). 1초 뒤 Notification 옴 | `ev-s2-allow-plain.jsonl` n41–42, `pane-s2-allow-after2.txt` |
| allow + `updatedPermissions:[{type:"setMode",mode:"default",destination:"session"}]` | 5초 뒤 | ❌ 같음 | `ev-s2-allow-setmode.jsonl` n45–46, `pane-s2-allow-setmode.txt` |
| allow, 지연 0초 | 즉시 | ❌ 같음 | `ev-s2-allow-delay0.jsonl` n49–50, `pane-s2-allow-delay0.txt` |

- allow 세 번 모두 터미널에서 Esc로 닫았다(`pane-s2-esc.txt`). 계획 실행(hello.txt 생성)은 한 번도 일어나지 않았다.
- 정리: **ExitPlanMode에서 hook은 거부만 할 수 있고 승인은 못 한다**(2.1.287).

## 6. 그 밖에 본 것

- **hook이 deny하면 뒤따르는 이벤트가 없다.** S1b deny 뒤 `PostToolUse`·`PostToolUseFailure`·`PermissionDenied` 모두 오지 않고 바로 `Stop`(n20). ExitPlanMode deny도 같다.
- **Notification은 PermissionRequest 약 6초 뒤에 온다**(창이 대기 중일 때. n7·n55). hook이 그 전에 답하면 오지 않는다(S1b 3초 allow·deny).
- 매 `Stop` 뒤 `SubagentStop`(agent_id·agent_type 있음)이 1~2초 뒤에 온다(상태 줄 "← 1 agent", 사용자 환경의 백그라운드 보조 에이전트로 보임). 계획에는 영향 없다.
- PreToolUse `ask`의 `permissionDecisionReason`이 창에 보이는지는 캡처에서 확인되지 않았다(창 문구는 평소와 같음).

## 7. 막힌 항목

- 권한 분류기에 막힌 것 없음.
- 확인하지 못한 것: 팀원·서브에이전트 PermissionRequest의 `agent_id`/`agent_type`, `SessionStart`가 http hook으로 오지 않는 이유.
