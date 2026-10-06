# v2 Phase 3 확인 스파이크 (Task 0)

- 날짜: 2026-10-07, 실행: developer(배정 #200). 판정은 이 문서에 적지 않는다(director).
- Claude Code: `2.1.291`(실행 중 자동 업데이트 없음). 모델 `--model sonnet`.
- 쓴 프롬프트: **5개**(상한 8). 다시 확인용 프롬프트는 쓰지 않았다.
- 증거 폴더: `$CLAUDE_JOB_DIR/tmp/spike3/`(커밋하지 않음). 아래 파일 이름은 이 폴더 기준.

## 1. 안전 값

| 항목 | 시작(`safety-before.txt`) | 끝(`safety-after.txt`) |
|---|---|---|
| `~/.claude/settings.json` sha1 | 기준과 같음(`8aad40373b0e…76a6`) | 같음 |
| `known_marketplaces`의 `claude-office` | 기준과 같음(3건) | 같음 |
| `installed_plugins`의 `claude-office` 버전 | 기준과 같음(`2.1.0-dev`) | 같음 |
| `~/.claude-office/VERSION` 값·mtime | 기준과 같음 | 같음 |
| `~/.claude-office/token` mtime | 기준과 같음 | 같음 |
| `~/.zshrc` mtime | 기준과 같음 | 같음 |
| 4319 리슨 / `tmux -L spike3` 세션 | 없음 / 없음 | 없음 / 없음 |

`diff safety-before.txt safety-after.txt` → 차이 없음. 끝난 뒤 `pgrep -f spike3` 결과 없음(실험 claude·수신기·MCP 서버 모두 내려감).
실험 세션이 평소처럼 남긴 것(안전 값 밖): `~/.claude/projects/…` 세션 기록, `~/.claude.json`의 작업 폴더 신뢰 등록.

## 2. 방법

- `receiver.mjs`: `127.0.0.1:4319/hooks/event`. 한 줄에 `{n, t, event, tool, agentKind, agentType, toolUseId(끝 6자), permissionMode, keys, toolInputKeys, inputHash(Phase 2 inputHash와 같은 정규 직렬화 sha256 앞 12자), replied}`만 `events.jsonl`에 쓴다. **`tool_input` 값은 쓰지 않는다.** `agentKind`는 `agent_id` 없음 → `lead`, `/^a[0-9a-f]{8,}$/` → `sub`, 그 밖 → `teammate`(`server/events/summarize.ts`의 규칙과 같음).
- `scenario.json`(요청마다 다시 읽음): `PreToolUse`에만 응답하고 나머지는 모두 빈 200.

  | agentKind | tool | 응답 | 이유 문구 |
  |---|---|---|---|
  | lead | Bash | deny | `SPIKE-DENY-1 lead bash blocked` |
  | sub | Bash | deny | `SPIKE-DENY-SUB sub bash blocked` |
  | sub | Read | ask | `SPIKE-ASK-SUB sub read needs confirm` |
  | teammate | Bash | deny | `SPIKE-DENY-TM teammate bash blocked` |
  | teammate | Write | ask | `SPIKE-ASK-TM teammate write needs confirm` |

- 플러그인 사본: `node scripts/make-dev-plugin.mjs --port 4319 --out spike3/plugin`(저장소 hooks.json 그대로, PermissionRequest 600).
- `run.mjs`: `spawnSync("<tmux>", ["-L","spike3",…], { env })`. `env`는 `{ HOME, USER, PATH: "<claude 버전 폴더>:/usr/bin:/bin", TERM: "xterm-256color", CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }`만(`process.env`를 펼치지 않음). 명령: `<claude 절대 경로> --plugin-dir <사본> --model sonnet --permission-mode <모드> --settings spike3/settings-spike.json --mcp-config spike3/mcp.json`, 작업 폴더 `spike3/work`(`README.md` 한 줄). 실행 직전 작업 폴더·사본·설정 파일이 job tmp 아래인지 `realpath`로 확인.
- **팀원 in-process:** `claude --help`(2.1.291)에는 팀원 표시 방식 플래그가 없다(`--tmux`는 `--worktree`용). 그래서 실험 전용 설정 파일 `settings-spike.json` = `{"teammateMode":"in-process"}`를 `--settings`로 넘겼다(사용자 settings.json은 그대로). 결과적으로 팀원 `rev`는 별도 tmux 창 없이 리드 화면 안에서 돌았다(`pane-b-s2*.txt`, tmux 창은 `cc` 하나뿐).
- MCP: `mcp.mjs`(도구 `ping` 하나, `pong`을 돌려주는 stdio JSON-RPC) + `mcp.json` = `{"mcpServers":{"spk":{…}}}`.
- 폴더 신뢰 창은 기본 선택이 "No, exit"라 `Down`, `Enter`로 신뢰를 골랐다(Phase 2와 같음).
- 좁힌 PATH 때문에 사용자 전역 설정의 command hook(SessionStart·UserPromptSubmit)이 `node: command not found`로 실패한다(non-blocking, 우리 http hook과 무관, Phase 2와 같음). 이번에도 우리 수신기에 `SessionStart`는 오지 않았다.
- **전제:** 사용자의 설치된 플러그인도 이 세션에서 켜져 4317로 hook을 보냈다. 4317(2.1.0-dev)에는 정책 기능이 없어 `PreToolUse`에 빈 200을 돌려주므로, 아래의 `deny`·`ask`는 모두 4319(수신기)의 것이다.

세션과 프롬프트:

| 세션 | 모드 | 프롬프트 | 항목 |
|---|---|---|---|
| A | default | ① `Run exactly 'echo spike1' with the Bash tool. If it is refused, quote the refusal reason you received word for word, then stop.` | S1 |
| B | auto | ② ①과 같은 문장 | S1 |
| B | auto | ③ `Use the Agent tool with subagent_type Explore. Tell it to (1) run exactly 'echo sub1' with its Bash tool and (2) read README.md with its Read tool, and to quote word for word any refusal reason it receives. Then report what it said.` | S3, S4, S5 |
| B | auto | ④ `Create an agent team with one teammate named rev. Ask rev to (1) run exactly 'echo tm1' with its Bash tool, then (2) create note.txt containing 'tm' with its Write tool, and to send you any refusal reason word for word. Relay rev's reasons to me, then shut the team down.` | S2, S4, S5 |
| B | auto | ⑤ `Call the ping tool from the spk MCP server once and tell me its result.` | S6 |

auto 세션에서 "Teach auto mode" 팝업은 뜨지 않았다. ③·④의 권한 창은 캡처한 뒤 터미널에서 `Enter`(선택된 1. Yes)로 허용했다.

## 3. 결과 표

| # | 질문 | 관찰 | 증거 |
|---|---|---|---|
| S1 default | 리드 `Bash`에 `deny` → 실행 안 됨, 이유를 받음 | 실행되지 않음("Ran 1 shell command" 뒤 출력 없음). Claude 답: `거부 사유: "SPIKE-DENY-1 lead bash blocked"` | `events.jsonl` n2–4, `pane-a-s1.txt` |
| S1 auto | 같음(auto) | 실행되지 않음. Claude가 받은 문구를 `PreToolUse:Bash hook error: SPIKE-DENY-1 lead bash blocked`로 인용(**앞에 `PreToolUse:Bash hook error: `가 붙어 전달됨**) | n7–9, `pane-b-s1.txt` |
| S2 | 팀원(in-process) `Bash` deny, `Write` ask, 이유 받고 턴 계속 | `rev`의 Bash(n33) deny → 실행 안 됨. 0.7초 뒤 같은 턴에서 Write(n35) 호출 → ask → 권한 창 → 터미널 허용 → PostToolUse(n39), `work/note.txt` 생김. 리드가 전한 rev의 이유: `PreToolUse:Bash hook error: SPIKE-DENY-TM teammate bash blocked` | n32–41, `pane-b-s2.txt`, `pane-b-s2-after.txt` |
| S3 | 서브에이전트(`Explore`) `Bash` deny, `Read` ask | Explore의 Bash(n15) deny → 실행 안 됨, 이유 `PreToolUse:Bash hook error: SPIKE-DENY-SUB sub bash blocked`를 받아 보고. 이어 Read(n17) ask → 권한 창 → 터미널 허용 → PostToolUse(n21), 읽기 성공 | n14–25, `pane-b-s3.txt`, `pane-b-s3-after.txt` |
| S4 | 팀원·서브에이전트 `ask`의 권한 창 위치, `PermissionRequest` 수신 | 둘 다 **리드 터미널**에 뜸. 창 머리: `Read file · from the Explore agent`, `Create file · from the rev agent`. `PermissionRequest`가 수신기에 옴(서브 n18: ask 10ms 뒤, 팀원 n36: 583ms 뒤). 둘 다 `agent_id`·`agent_type` 포함(서브 `Explore`, 팀원 `rev`). 팀원 것에는 `permission_suggestions`도 있음(Write). `PreToolUse`·`PermissionRequest`·`PostToolUse`의 `inputHash`가 같음(서브 `a690eb1ffc50`, 팀원 `bcc2b28a0092`). 대기 중 리드 `Notification`(n20 6.0초 뒤, n38 6.0초 뒤) | n17–21, n35–39, `pane-b-s3.txt`, `pane-b-s2.txt` |
| S5 | `deny`된 호출 뒤 이벤트 | 세 경우 모두 **같은 `tool_use_id`의 이벤트가 더 오지 않음**(`PostToolUse`·`PostToolUseFailure`·`PermissionDenied` 없음). 리드 n3 → 바로 `Stop`(n4), n8 → `Stop`(n9). 서브 n15 → 다음은 같은 서브의 `PreToolUse Read`(n17). 팀원 n33 → 다음은 같은 팀원의 `PreToolUse Write`(n35) | `events.jsonl` 전체(…EiMYc2, …o9KFMq, …6xLpQP, …dGbWZ8가 각각 한 번씩만 나옴) |
| S6 | MCP `tool_name` 모양, 도구 이름 대소문자 | `mcp__spk__ping`(서버 이름 `spk`, 도구 이름 `ping` 그대로). `PreToolUse`에 `mcp_server` 키가 더 있음. 이번에 본 내장 도구 이름: `Bash`, `Read`, `Write`, `Agent`, `ToolSearch`, `TaskStop`, `SubagentHandback` — 모두 대문자로 시작, 같은 도구는 모든 이벤트에서 같은 글자 | n49–52, 위 이벤트 목록 |

## 4. 이벤트별 키 (2.1.291)

| 이벤트 / agentKind | 키 |
|---|---|
| PreToolUse / lead | cwd, effort, hook_event_name, permission_mode, prompt_id, scratchpad_dir, session_id, tool_input, tool_name, tool_use_id, transcript_path (MCP는 + mcp_server) |
| PreToolUse / sub, teammate | 위 + agent_id, agent_type |
| PermissionRequest / sub | agent_id, agent_type, cwd, effort, hook_event_name, permission_mode, prompt_id, scratchpad_dir, session_id, tool_input, tool_name, transcript_path (**tool_use_id 없음**, Phase 2와 같음) |
| PermissionRequest / teammate | 위 + permission_suggestions |
| PostToolUse / sub, teammate | agent_id, agent_type, cwd, duration_ms, effort, hook_event_name, permission_mode, prompt_id, scratchpad_dir, session_id, tool_input, tool_name, tool_response, tool_use_id, transcript_path |
| SubagentStart / sub, teammate | agent_id, agent_type, cwd, hook_event_name, prompt_id, scratchpad_dir, session_id, transcript_path |
| TeammateIdle / teammate | agent_id, agent_type, cwd, hook_event_name, permission_mode, prompt_id, scratchpad_dir, session_id, team_name, teammate_name, transcript_path |

`tool_input` 키 이름: Bash `command, description` / Read `file_path` / Write `content, file_path` / Agent(서브) `description, prompt, subagent_type` / Agent(팀원) `description, name, prompt` / `SubagentHandback` `message` / `TaskStop` `task_id` / `ToolSearch` `max_results, query` / `mcp__spk__ping` 없음.

## 5. 그 밖에 본 것 (판정 재료)

1. **`SubagentHandback`**: 서브에이전트가 끝날 때 리드에게 결과를 넘기는 도구로 보인다. 서브에이전트의 `PreToolUse`로 온다(n23, `agent_type` `Explore`). 지금 계획의 "정책에서 빼는 도구" 목록(`AskUserQuestion`, `ExitPlanMode`, `SendMessage`, `Task*` 4개)에 없다. 그대로면 `other`·`all`에 들어간다.
2. **팀원은 이번에 `SendMessage`를 부르지 않았다.** rev의 보고는 리드 화면에 `Teammate @rev finished`로 들어왔고, 수신기에 팀원의 `SendMessage` `PreToolUse`는 없었다. 리드는 팀을 `TaskStop`(n44)으로 내렸다. `TaskStop`도 빼는 목록에 없다.
3. 리드는 MCP·`TaskStop`을 부르기 전에 `ToolSearch`(n42, n49)를 먼저 불렀다.
4. 리드의 `Stop` 뒤마다 `agent_type`이 빈 `SubagentStop`(sub)이 온다(n5, n10, …). 기존 `agentOf()`가 이미 버리는 내부 보조 에이전트다.
5. 이유 문구 앞의 `PreToolUse:Bash hook error: `는 auto 세션(서브·팀원 포함)에서 Claude가 인용한 문구에 붙어 있었다. default 세션의 S1에서는 Claude가 이유만 인용했다(앞부분이 실제로 없었는지는 이 증거로 가를 수 없다).
6. 팀원 정의(`Agent`의 `name`)가 그대로 `agent_type`이 된다(`rev`). 팀원의 `agent_id`는 `/^a[0-9a-f]{8,}$/`에 맞지 않았다(수신기가 `teammate`로 분류).

## 6. 막힌 항목

없음. 권한 분류기에 막힌 호출 없음. MCP 서버는 `--mcp-config`로 붙었다.
