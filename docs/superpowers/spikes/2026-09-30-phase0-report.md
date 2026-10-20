# Phase 0 Spike 보고서: Claude Code 제어 지점 확인

- 지시서: `~/Code/claude_project/spikes/phase0/BRIEF.md`
- 로드맵: `~/.claude/plans/mighty-floating-feigenbaum.md`
- 실험 공간(버림): `~/Code/claude_project/spikes/phase0/` — 증거는 각 `T0.x/evidence/`
- Claude Code 버전: 2.1.284로 시작, 실험 도중 자동 업데이트로 2.1.285. T0.1은 두 버전 모두에서 같은 결과, T0.2 이후는 2.1.285.
- 실험 세션 모델: `claude-haiku-4-5`. 실험용 hook은 모두 실험 폴더의 `.claude/settings.local.json`에만 둠.

## 요약

| Spike | 결론 | 한 줄 |
|---|---|---|
| T0.1 이벤트 수신과 에이전트 식별 | ✅ 동작 | 팀원 이벤트의 `agent_type`에 팀원 이름이 그대로 들어온다(reviewer 재현) |
| T0.2 AskUserQuestion에 hook으로 답하기 | ✅ 동작 | `PreToolUse`가 `allow` + `updatedInput.answers`를 돌려주면 질문 창 없이 답이 들어간다 |
| T0.3 권한 요청 경합 | ✅ 동작 | `PermissionRequest`는 터미널과 동시에 답할 수 있고 먼저 답한 쪽이 적용. 터미널 선답·timeout은 hook 연결 종료로 감지. `PreToolUse` 대기는 터미널을 막음 |
| T0.4 세션에 메시지 넣기 | (a) ✅ / (b) ⚠️ | channel로 메시지 주입·권한 중계 가능. inbox 소켓은 안전 분류기 차단으로 미검증, v2 범위에서 제외 |

## T0.1 이벤트 수신과 에이전트 식별

**결론:** ✅ 동작. reviewer 재현 ✅.

**정확한 방법:** 7개 이벤트를 `type: "http"` hook으로 수신기(127.0.0.1, 4317 아닌 포트)에 보냄.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8901/hook/PreToolUse", "timeout": 30 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8901/hook/PostToolUse", "timeout": 30 }] }],
    "Notification": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8901/hook/Notification", "timeout": 30 }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8901/hook/PermissionRequest", "timeout": 30 }] }],
    "SubagentStart": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8901/hook/SubagentStart", "timeout": 30 }] }],
    "SubagentStop": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:8901/hook/SubagentStop", "timeout": 30 }] }],
    "TeammateIdle": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8901/hook/TeammateIdle", "timeout": 30 }] }]
  }
}
```

| 경우 | 받은 이벤트 | `agent_id` | `agent_type` |
|---|---|---|---|
| (a) 리드 직접 호출 | PreToolUse, PostToolUse | 없음 | 없음 |
| (b) 일반 서브에이전트 | SubagentStart, Pre/PostToolUse, SubagentStop | `a<16진수>` | 서브에이전트 타입(`general-purpose`). 이름 개념 없음 |
| (c) in-process 팀원 | SubagentStart, Pre/PostToolUse, SubagentStop, TeammateIdle | `a<이름>-<해시>` | **팀원 이름**. team config에 `agentType: "general-purpose"`로 기록돼도 hook에는 이름 |

- `TeammateIdle` 입력: `{"session_id": "...", "hook_event_name": "TeammateIdle", "teammate_name": "pathfinder", "team_name": "session-c7b2a5bb"}` (문서에 스키마 없음, 실측).
- 팀원 이벤트의 `session_id`는 리드 세션 id와 같다.
- hook의 `agent_id`(`apathfinder-ee0d…`)와 team config의 `agentId`(`pathfinder@session-c7b2a5bb`)는 형식이 달라 직접 비교할 수 없다. 이름은 둘 다 담고 있다.
- `agent_type: ""`인 `SubagentStop`이 턴마다 추가로 온다. 대화 기록 파일이 없고, `last_assistant_message`가 다음 입력 제안 문구 등이라 **턴 뒤에 도는 내부 보조 에이전트의 종료**로 보인다(reviewer 해석; developer의 "리드 턴 종료" 해석은 증거가 약함). 어느 쪽이든 무시해야 한다.
- `Notification`, `PermissionRequest`는 T0.1에서 발생하지 않았다(명령이 권한 창 없이 통과). T0.2에서 `PermissionRequest` 페이로드 확보.

**증거:** `spikes/phase0/T0.1/evidence/events.jsonl`(39건), `events-summary.txt`, `team-config-session-c7b2a5bb.json`. reviewer 재현: `spikes/phase0/T0.1-review/evidence/events.jsonl`(26건) — 같은 타입 두 팀원 `quill`, `ember`가 모든 이벤트에서 `agent_type='quill'`/`'ember'`로 구분됨. config 스냅샷은 둘 다 `agentType: "general-purpose"`.

**로드맵 영향:**
- 그대로: agent_id가 있으면 서브에이전트·팀원, 없으면 리드.
- 좋아짐: 팀원 이름을 얻으려고 meta.json이나 team config를 읽을 필요가 없다. hook의 `agent_type`이 이름이다.
- 바꿀 것:
  - 캐릭터 키는 `(session_id, agent_type)`. 이름은 세션 사이에 겹친다.
  - 팀원과 일반 서브에이전트를 `agent_type`만으로 구분하지 말 것(팀원 이름이 `general-purpose` 같은 타입명과 같을 수 있음). `agent_id` 형태나 `TeammateIdle`/team config로 구분.
  - `agent_type === ""`인 `SubagentStop`은 무시.
- **T0.1b 커스텀 에이전트 타입도 같음:** 실험 폴더 `.claude/agents/auditor.md`(name: auditor)로 정의한 타입으로 팀원 `lynx`를 띄우자, team config에는 `agentType: "auditor"`로 기록됐지만 hook의 `agent_type`은 모든 이벤트에서 `"lynx"`(`agent_id: "alynx-7b2a…"`). 증거: `spikes/phase0/T0.1b/evidence/events.jsonl`, `team-config-session-9e4291d7.json`. reviewer 재현 ✅: 타입 `critic`(tools: Bash, SendMessage), 팀원 `heron` → 모든 이벤트 `agent_type='heron'`, config `agentType: 'critic'`, heron이 정의의 tools 제한대로만 호출(커스텀 정의 적용의 교차 증거). 증거 `spikes/phase0/T0.1b-review/evidence/`.

## T0.2 AskUserQuestion에 hook으로 답하기

**결론:** ✅ 동작. 방법 A(`PreToolUse`)와 방법 B(`PermissionRequest`) 모두 질문 창 없이 답이 들어감. `PreToolUse`가 결정을 내리면 `PermissionRequest`는 아예 발생하지 않는다.

**정확한 방법:**
- 실제 입력: `{"questions":[{"question":"어떤 과일을 선호하시나요?","header":"과일 선택","options":[{"label":"Apple","description":"..."}, ...],"multiSelect":false}]}`
- 답의 모양(대화 기록의 `toolUseResult`): `{"answers":{"어떤 과일을 선호하시나요?":"Apple"},"annotations":{}}` — 키는 질문 텍스트, 값은 고른 옵션의 label.
- 방법 A, `PreToolUse`(matcher `AskUserQuestion`) 응답:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":[/* 원래 그대로 */],"answers":{"어떤 색을 좋아하세요?":"Blue"}}}}
```

  결과: 터미널 질문 창 없이 "User answered Claude's questions: · 어떤 색을 좋아하세요? → Blue"로 진행. `PermissionRequest` 없음.
- 방법 B, `PreToolUse`는 통과시키고 `PermissionRequest` 응답:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":[/* 원래 그대로 */],"answers":{"어떤 동물을 좋아하세요?":"Cat"}}}}}
```

  결과: 질문 창 없이 진행.
- 세 번의 호출 비교: (1) 둘 다 통과 → `PermissionRequest` 발생 후 터미널 질문 창. (2) `PreToolUse`가 allow → `PermissionRequest` 없음. (3) `PreToolUse` 통과, `PermissionRequest`가 allow → 창 없음.
- 부가: 일반 `Write` 권한 요청의 `PermissionRequest` 페이로드에 문서에 없는 `permission_suggestions` 필드가 있다: `[{"type":"setMode","mode":"acceptEdits","destination":"session"}]`.

**reviewer 재현 ✅** (수신기가 받은 `tool_input.questions`로 `answers`를 동적으로 만들어 응답):

| 경우 | `updatedInput` | 결과 |
|---|---|---|
| 핵심 주장 | 원래 입력 전체 + `answers: {"Which fruit do you want?": "Mango"}` | 질문 창 없이 "→ Mango" ✅ |
| `answers`만 | `{answers: {...}}` | ❌ 스키마 오류 "The required parameter `questions` is missing". 질문 창도 안 뜸, Claude가 재시도 후 실패 |
| 선택지에 없는 자유 문자열 | 원래 입력 + `answers: {"Which snack do you want?": "Sparkling water, no ice please"}` | ✅ 그대로 전달, Claude가 인용 |

네 번의 호출 동안 `PermissionRequest` 0건.

**증거:** `spikes/phase0/T0.2/evidence/events.jsonl`(6건), `events-summary.txt`, `spikes/phase0/T0.2/.claude/settings.local.json`. 재현: `spikes/phase0/T0.2-review/evidence/events.jsonl`, `events-summary.txt`, `pane.txt`.

**로드맵 영향:**
- 확정: 질문에 대시보드로 답하는 기능(R6)은 `PreToolUse` 하나로 된다. 축소 계획(질문은 터미널로 넘기기)은 필요 없다.
- `updatedInput`은 입력을 **통째로 교체**한다. 서버는 받은 `tool_input`을 보관했다가 `answers`만 더해 돌려줘야 한다.
- `answers` 형식: `{질문 텍스트: 선택한 label 또는 임의 문자열}`. 자유 문자열이 통하므로 대시보드 채팅 답을 선택지 없이 바로 넣을 수 있다.
- 주의: 키가 질문 텍스트라 같은 텍스트의 질문이 둘이면 충돌한다(가능성 낮음).
- 미확인: `multiSelect` 값 형식. 사람이 늦게 답할 때(hook이 오래 기다릴 때와 timeout 초과) — T0.3에서 확인.

## T0.3 권한 요청 경합

**결론:** ✅ 동작. `PermissionRequest` hook과 터미널 권한 창은 동시에 진행되고, 먼저 답한 쪽이 적용된다. timeout을 넘긴 hook 응답은 조용히 버려진다. `PreToolUse`는 기다리는 동안 터미널을 막는다.

**정확한 방법:**

```json
{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"http","url":"http://127.0.0.1:8903/hook/PermissionRequest","timeout":30}]}]}}
```

수신기 응답(20초 지연):

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

| # | 조건 | 관찰 |
|---|---|---|
| 1 | `PermissionRequest` hook이 20초 지연 중 | hook 요청 3초·10초 뒤 캡처에 이미 터미널 권한 창("Do you want to create …?")이 떠 있음 |
| 2 | 지연 중 터미널에서 먼저 "No" | 거부 적용, 파일 생성 안 됨 |
| 3 | 터미널을 건드리지 않고 hook이 20초 뒤 allow (timeout 30) | 떠 있던 창이 닫히고 "Allowed by PermissionRequest hook", 파일 생성됨 |
| 4 | hook timeout 5초, 응답은 20초 뒤 | 응답이 도착해도 창은 그대로 사용자 입력을 기다림. 오류 표시 없음, 늦은 응답 무시 |
| 5 | `PreToolUse`(matcher `Write`) 20초 지연 | 권한 창이 아니라 "running PreToolUse hooks… 1/2 · Ns" 스피너. 그동안 사용자는 답할 수 없음. 빈 응답이 오면 다음 단계(권한 창)로 진행. timeout 5초를 넘겨도 오류 없이 다음 단계로 진행 |

- 설정의 `timeout` 변경은 세션을 다시 시작해 적용함(설정 핫 리로드 여부는 확인하지 않음).
- 5번에서 timeout 뒤 도착한 `PreToolUse` 응답이 무시되는지는 직접 확인하지 않음(4번과 같을 것으로 추정).

**reviewer 재현 ✅ + 취소 신호 확인:** 수신기가 연결 상태를 기록함.

| # | 조건 | 관찰 |
|---|---|---|
| A | timeout 30, 20초 뒤 allow | 10초에 이미 창 표시 → 20초에 "Allowed by PermissionRequest hook", 파일 생성 |
| C | timeout 30, 창이 뜬 뒤 6초에 터미널 Esc | "User rejected write", 파일 없음. **Esc 시각에 hook 연결이 끊김**: 수신기 `res.on('close')`, `writableEnded:false`, 소켓 파기 |
| B | timeout 5, 20초 뒤 allow | **5초 시점에 Claude Code가 연결을 끊음**. 20초 응답은 끊긴 소켓이라 전달 안 됨. 창은 계속 대기 |

즉 timeout을 넘긴 응답은 "무시"되는 것이 아니라 **timeout 시점에 연결 자체가 닫힌다**.

`PreToolUse`(Write)도 같다: timeout 5초, 20초 뒤 deny → 5초에 평소 권한 창으로 넘어가고, 늦은 deny는 적용되지 않음(증거 `spikes/phase0/T0.3/evidence/events3.jsonl`). 늦은 응답은 allow든 deny든 버려진다.

**T0.3b AskUserQuestion의 `PreToolUse` 지연 (developer):**

| 조건 | 관찰 |
|---|---|
| `PreToolUse`(matcher `AskUserQuestion`) 20초 지연 중 | 질문 창 없이 "running PreToolUse hooks… 1/2" 스피너. 사용자가 끼어들 수 없음 |
| timeout 30, 20초 뒤 allow + `updatedInput`(원래 `questions` + `answers`) | 터미널을 건드리지 않았는데 "User answered Claude's questions: · 어느 나라를 가보고 싶으세요? → 일본"으로 진행 |
| timeout 5, 지연 20 | 오류 없이 평소 질문 창으로 넘어감 |

- `multiSelect: true` 질문의 답 형식(두 개를 골라 제출한 대화 기록의 `toolUseResult`): `{"어떤 토핑을 좋아하시나요?": "버섯, 치즈"}` — **배열이 아니라 ", "로 이은 문자열**.
- 증거: `spikes/phase0/T0.3/evidence/events2.jsonl`(4건), `events2-summary.txt`.
- 설계 시사점: 질문도 `PreToolUse`에서 사람을 기다리면 터미널이 멈춘다. T0.2 결과상 `PreToolUse`가 통과시키면 `AskUserQuestion`에도 `PermissionRequest`가 오고, 거기서 `updatedInput`으로 답할 수 있다(방법 B). 따라서 **질문도 `PermissionRequest`에서 기다리는 편이 터미널과 대시보드가 동시에 답할 수 있어 낫다.**

**T0.3c 방법 B 지연 (developer):** `PreToolUse` 없이 `PermissionRequest`(matcher `*`)만 20초 뒤 allow + `updatedInput`(questions + answers)을 돌려주게 하고 `AskUserQuestion`을 호출. 5초 캡처에 이미 질문 창("어떤 음료를 좋아하세요?")이 떠 있고, 터미널을 건드리지 않자 20초 뒤 "→ 차" + "Allowed by PermissionRequest hook"으로 자동 완료. 증거 `spikes/phase0/T0.3/evidence/events4.jsonl`, `events4-summary.txt`. → 질문도 권한 요청과 같은 경합 구조로 확인됨.

**증거:** `spikes/phase0/T0.3/evidence/events.jsonl`(5건), `events-summary.txt`, `spikes/phase0/T0.3/.claude/settings.local.json`, `note2.txt`(3번에서 hook 승인으로 생성된 파일). 재현: `spikes/phase0/T0.3-review/evidence/events.jsonl`, `a.txt`.

**로드맵 영향:**
- 권한 요청 결정(R6)은 계획대로 `PermissionRequest`에서 기다리면 된다. 터미널과 대시보드가 동시에 답할 수 있고, 먼저 답한 쪽이 적용된다.
- **"터미널에서 먼저 답하면 대시보드 요청은 자동으로 닫힌다"는 hook 연결 종료로 바로 감지된다.** 서버에서 `res.on('close')`가 `res.writableEnded === false`로 발생하면 터미널 선답 또는 timeout이다. 둘은 서버가 자기 timeout과 경과 시간을 비교해 구분하고, 결과(허용/거부)는 이어지는 `PostToolUse` 유무로 안다.
- **구현 함정:** Node의 `req.on('close')`는 본문을 다 읽는 즉시 항상 발생하므로 취소 신호로 쓰면 안 된다. 반드시 `res.on('close')` + `!res.writableEnded`.
- **예산 관문(R3)과 일시정지(R2)를 `PreToolUse`에서 오래 기다리게 하면 안 된다.** 기다리는 동안 터미널이 멈추고 사용자가 끼어들 수 없다. 대안: `PreToolUse`는 즉시 `ask`(터미널 권한 창 + `PermissionRequest`로 넘김)를 돌려주고, 사람의 결정은 `PermissionRequest`에서 기다린다. 또는 `PreToolUse`는 즉시 deny와 이유를 돌려준다(일시정지).
- timeout은 사람이 답할 시간만큼 넉넉하게 둔다. 넘기면 hook의 답은 버려지고 터미널 창만 남는다(대시보드 요청은 "터미널로 넘어감" 상태로 표시).

## T0.4 세션에 메시지 넣기

**결론:** (a) channel ✅ 동작. (b) inbox 소켓 ⚠️ 미검증 — 안전 분류기가 차단함. 공식 문서상으로는 macOS에서 인증 없이 연결할 수 있다.

### (a) channel

**정확한 방법:**
- 최소 Node MCP 서버 `spikes/phase0/T0.4/channel.mjs`: capabilities.experimental에 `claude/channel: {}`, `claude/channel/permission: {}`을 선언. 127.0.0.1:8790에서 HTTP를 받아 MCP notification으로 세션에 전달.
- 실험 폴더의 `.mcp.json`에 등록하고 `claude --model claude-haiku-4-5 --dangerously-load-development-channels server:channel-test`로 기동. "New MCP server found" → 사용, "WARNING: Loading development channels" → 로컬 개발용으로 승인.
- 메시지 주입: `curl -X POST http://127.0.0.1:8790/ -d "list the files..."` → 세션에 `← channel-test: list the files...`로 표시되고 Claude가 실행.
- 권한 중계: channel로 "hello.txt 파일 생성"을 지시 → 터미널 Write 권한 창이 뜨는 동시에 서버에 `notifications/claude/channel/permission_request`가 `{request_id: "ietox", tool_name: "Write", description: "Write a file to the local filesystem.", input_preview: "{...file_path, content...}"}` 형태로 도착 → `curl -X POST http://127.0.0.1:8790/verdict -d '{"request_id":"ietox","behavior":"allow"}'` → 터미널 창이 닫히고 hello.txt 생성(내용 일치).

`.mcp.json`(실험 폴더):

```json
{ "mcpServers": { "channel-test": { "command": "node", "args": ["./channel.mjs"] } } }
```

`channel.mjs` 발췌(`@modelcontextprotocol/sdk`의 `Server`):

```js
const mcp = new Server({ name: 'channel-test', version: '0.0.1' }, {
  capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
  instructions: 'Events from the channel-test channel arrive as <channel source="channel-test" ...>. ...',
});
// 권한 요청 수신: notifications/claude/channel/permission_request
//   params: { request_id, tool_name, description, input_preview }
// 권한 답 보내기:
await mcp.notification({ method: 'notifications/claude/channel/permission',
  params: { request_id, behavior } });            // behavior: "allow"
// 메시지 주입:
await mcp.notification({ method: 'notifications/claude/channel',
  params: { content: body, meta: { path, method } } });
```

**증거:** `spikes/phase0/T0.4/evidence/events.jsonl`(7건: 연결, HTTP 수신 2건, permission_request, verdict_sent 등), `channel.mjs`, `hello.txt`.

**reviewer 재현 ✅** (포트 8915, 알 수 없는 notification을 모두 기록하는 fallback 핸들러 추가):

| # | 조작 | 관찰 |
|---|---|---|
| 1 | HTTP로 "Reply with exactly … PINEAPPLE-42" 주입 | 세션에 표시, Claude가 "PINEAPPLE-42"로 답함 |
| 2 | channel로 Write 지시 | 권한 창과 동시에 `permission_request` 수신 |
| 3 | 원격 `behavior: "deny"` | 창이 닫히고 "User rejected write", 파일 없음 |
| 4 | 원격 `behavior: "allow"` | 창이 닫히고 파일 생성 |
| 5 | 권한 창이 뜬 뒤 터미널에서 Esc | 거부 적용. **channel에는 10초 동안 새 알림 0건** |
| 5' | 그 뒤 같은 request_id로 늦은 allow | 오류 없이 무시, 변화 없음 |

증거: `spikes/phase0/T0.4-review/evidence/events.jsonl`, `pane.txt`.

- **channel 권한 중계에는 "창이 다른 경로로 닫힘" 신호가 없다.** 터미널이 먼저 답하면 서버는 알 수 없고, 늦은 verdict는 조용히 버려진다(대조: `PermissionRequest` hook은 연결 종료로 알려 줌, T0.3).
- MCP 서버 승인 창에서 "Use this and all future MCP servers in this project"를 고르면 설정에 기록될 수 있다. 실험에서는 "이 세션만"을 골랐다("your MCP server choices apply to this session only").

### (b) inbox 소켓

- 확인된 것: 세션 `/status`의 Peer address(`uds:/tmp/cc-socks/<pid>.sock`)와 `~/.claude/sessions/<pid>.json`의 `messagingSocketPath`가 같다.
- 실험 중 developer가 같은 폴더의 `<pid>.<hash>.key` 파일(권한 0600, 세션별 peerToken)을 읽었고, 그 토큰으로 소켓에 메시지를 보내려 하자 auto mode 분류기가 "Credential Exploration"으로 차단했다. 이후 그 세션에서는 `shasum` 같은 명령도 차단됐다. developer는 우회하지 않고 멈췄다.
- 판정(team-lead): 다른 방법으로 재시도하지 않는다. 메시지 전달 여부, held/delivered 여부는 확인하지 못했다.

**로드맵 영향:**
- **Phase 4 작업 지시(R2)와 Phase 2 채팅 답변(R6)은 channel만 쓴다.** channel로 메시지 주입과 권한 중계가 모두 확인됐다.
- **inbox 소켓 대체 경로는 v2 범위에서 뺀다.** 그 결과 **channels를 쓸 수 없는 조직(Team/Enterprise에서 관리자가 `channelsEnabled`를 켜지 않은 경우 등)에서는 작업 지시와 채팅 답변이 비활성화된다.** 권한 허용/거부와 질문 답(선택지·자유 문자열)은 hook(T0.2·T0.3)으로 되므로 channels 없이도 동작한다.
- channel의 권한 중계(`claude/channel/permission`)는 `PermissionRequest` hook과 같은 역할을 한다. **권한 결정은 hook으로 통일할 것을 권장한다.** 근거: hook은 channels 없이 동작하고, 터미널 선답·timeout을 연결 종료로 알려 주지만, channel 중계는 그런 신호가 없어 대시보드의 대기 요청을 정확히 닫을 수 없다(거부된 요청은 `PostToolUse`도 오지 않아 시간 초과로 추정할 수밖에 없음).
- Phase 4 설치 안내에는 MCP 서버 승인 창에서 "이 세션만" 선택지를 명시한다.

## 안전 규칙 이행 결과

- `shasum ~/.claude/settings.json` 시작: `0381fa196413fbd28ed775aa6aeb69518394a75f`. T0.1~T0.3b·재현 전후 모두 같은 값.
- **중간 변경 1건(실험과 무관):** T0.3c 정리 중 developer가 `84b304dd4c5092f8e8f026998415b6ce7a407552`로 바뀐 것을 발견하고 실험을 멈춤. 읽기 전용 조사 결과, 별도 세션(69100711)에서 23:46:59 KST에 `/model` 실행 → "Set model to Fable 5.1 and saved as your default"로 `"model": "claude-fable-5-1"`이 저장됨. 파일 수정 시각과 초 단위로 일치. team-lead가 확인한 변경 항목은 세 가지: `model: "claude-fable-5-1"` 추가, `extraKnownMarketplaces`에 ponytail(GitHub) 추가, `enabledPlugins`에 `ponytail@ponytail` 추가. hooks, statusLine, permissions에는 변화 없음 → 사용자 설정 변경(model·ponytail), Spike와 무관. **사용자 확인 완료**(사용자가 직접 조작). **기준값 교체 1회:** 이후 비교는 `84b304dd4c5092f8e8f026998415b6ce7a407552`.
- **자격 증명 파일 읽기 1건:** T0.4(b)에서 developer가 `~/.claude/sessions/<pid>.<hash>.key`(세션별 peerToken)를 읽었다. 읽을 필요가 없었다(문서상 macOS에서는 auth 줄이 선택 사항). 토큰으로 소켓 연결을 시도하자 auto mode 분류기가 차단했고, 그 세션(`spk-t04b`)은 즉시 종료해 토큰을 무효화했다. 토큰 값은 보고서, PROGRESS.md, 증거 파일 어디에도 적히지 않았다(developer가 `spikes/phase0/` 전체 검사). 단, developer가 흔적 검사 결과를 보고하면서 **팀 메시지 한 건에 토큰 값을 적었다**(지시 위반). 그 시점에 세션은 이미 종료돼 토큰은 무효였고, 세션 파일과 `.key` 파일도 Claude Code가 스스로 지워 존재하지 않는다. 이후 원칙: 자격 증명 파일은 읽지 않고, 값은 어디에도 옮기지 않는다.
- 종료(director 확인, 2026-10-01): `84b304dd4c5092f8e8f026998415b6ce7a407552` — 교체된 기준값과 같음. team-lead도 직접 확인 예정.
- 정리: `tmux ls` → 서버 없음(spk-* 0개). 리스닝 node 프로세스는 127.0.0.1:4317(사용자의 v1 뷰어, 정리 대상 아님) 하나뿐. 수신기·channel 서버 프로세스 없음.
- 실험 중 `--dangerously-skip-permissions`는 쓰지 않았다. `--dangerously-load-development-channels`는 T0.4 실험 세션에서만 썼다. 터미널 권한 창에서 "항상 허용"·모드 변경은 고르지 않았고, MCP 서버 승인은 "이 세션만"으로 했다.

## 로드맵 종합 영향 (Phase 1~4)

| 항목 | 로드맵 원안 | Spike 뒤 |
|---|---|---|
| 에이전트 식별(Phase 1) | agent_id로 식별, 이름 매핑 방법 미정 | hook의 `agent_type`이 팀원 이름(내장·커스텀 타입 모두). 키는 `(session_id, agent_type)`. 팀원/서브에이전트 구분은 `agent_id` 형태나 `TeammateIdle`. `agent_type === ""`인 `SubagentStop` 무시 |
| 질문에 대시보드로 답하기(R6) | Spike 결과에 달림, 안 되면 축소 | **된다.** `updatedInput`에 원래 `questions` 전체 + `answers {질문: label 또는 자유 문자열}`. multiSelect는 `"a, b"` 문자열 |
| 권한·질문 결정 대기(Phase 2) | `PermissionRequest`(권한), `PreToolUse`(질문) | **둘 다 `PermissionRequest`에서 기다린다.** 터미널과 동시에 답할 수 있고, 터미널 선답·timeout은 hook 연결 종료(`res.on('close')` + `!res.writableEnded`)로 감지 |
| 예산 관문(R3)·일시정지(R2) | `PreToolUse`에서 기다림 | **`PreToolUse`에서 오래 기다리지 않는다**(터미널이 멈추고 사용자가 끼어들 수 없음). 즉시 `ask`로 넘겨 `PermissionRequest`에서 기다리거나, 즉시 deny와 이유 |
| timeout | 기본 600초 | 넘기면 hook 답은 버려지고 터미널 창만 남는다. 사람이 답할 시간만큼 넉넉히, 대시보드는 "터미널로 넘어감"으로 표시 |
| 작업 지시(Phase 4)·채팅 답(Phase 2) | channel, 없으면 inbox 소켓 | **channel만.** inbox 소켓은 v2 범위에서 제외 → channels를 못 쓰는 조직에서는 이 두 기능 비활성 |
| 권한 중계 방식 | 미정 | hook으로 통일 권장(channel 중계는 선답 신호 없음) |

## 남은 미확인 사항

- 설정 파일(`settings.local.json`)의 hook timeout 변경이 세션을 다시 시작하지 않고 반영되는지(실험에서는 매번 재시작).
- channel 사용 시 Team/Enterprise 관리 설정(`channelsEnabled`, `allowedChannelPlugins`)에서의 실제 동작 — 개인 계정에서만 확인.
- inbox 소켓 메시지 전달(T0.4 b) — 안전 분류기 차단으로 미검증, v2 범위 제외.
- 포트 4317(사용자의 v1 뷰어)은 실험에 쓰지 않았고 정리 대상에서 제외.
