# 스파이크: agent team 팀원의 권한 질문은 왜 대시보드에 오지 않는가 (2026-10-27)

배정 #741(security), LEDGER `.superpowers/sdd/2026-10-27-teammate-perm-spike/progress.md`. 제품 코드 없음.

## 문제
회사 PC(beta.18~19)에서 agent team 팀원의 Bash 권한 질문은 리더 터미널에 뜨지만, 대시보드에는 손들기도 "결정 대기" 숫자도 생기지 않는다. 진단은 hook 포함 모두 초록이다. 리드 자신의 권한 질문은 Phase 2·6a 때부터 대시보드로 온다. Phase 2 스파이크는 팀원·서브에이전트를 확인하지 않았다.

## 한 일과 막힌 곳
- **실제 세션 실측은 하지 못했다.** 계획은 임시 `CLAUDE_CONFIG_DIR`에 기록용 hook 설정을 두고 tmux에서 claude(agent team, default 권한 모드)를 띄우는 것이었다. 하지만 임시 설정 폴더로 띄운 claude는 `Not logged in · Please run /login`으로 멈췄다(Claude Code 2.1.310, macOS). 자격 증명을 복사하거나 실제 `~/.claude`를 쓰는 것은 규칙상 금지라 여기서 멈췄다. 사용자 settings sha1은 전후 모두 같다(기준값).
- 대신 설치된 Claude Code 2.1.310 실행 파일 안의 번들 JS를 **읽기만 하는 정적 분석**으로 흐름을 확인했다(`strings` + 문자열 검색). 아래의 "확인"은 이 코드에 근거하고, "추정"은 실측으로 닫아야 한다.

## 결론 (정적 분석 근거)
1. **[확인] 별도 프로세스 팀원(tmux·창)의 권한 질문은 팀 메일함으로 리더에게 넘어간다.** 팀원 쪽 `[PermissionSync]` 코드가 `{type:"permission_request", request_id, agent_id:<팀원 이름>, tool_name, tool_use_id, description, input, permission_suggestions}` 메시지를 만들어 리더 메일함에 쓴다(팀원 판별: 팀 이름이 있고 자기 id가 `team-lead`가 아님).
2. **[확인 — 직접 호출 없음, 간접 호출은 실측 항목 3] 리더는 그 요청을 PermissionRequest hook 없이 자기 터미널 대화상자로 바로 띄운다.** 리더의 `[InboxPoller]`가 요청을 읽으면 다음을 한다.
   - agent_id와 보낸 쪽이 다르면 버린다.
   - 권한 대화상자를 만들어(`requestSource: {type:"subagent", agentName}`) 리더 화면에 띄운다.
   - 사용자 답(allow·deny)을 `permission_response`로 팀원 메일함에 돌려준다.
   - 이 길에는 `executePermissionRequestHooks`(PermissionRequest hook 실행) 호출이 없다. 리더 자신의 도구 호출 길에만 있다.
   → **대시보드가 PermissionRequest hook으로 붙잡는 결정 대기열에 팀원 질문이 들어올 길이 없다.** 사용자가 본 증상과 맞다.
   - 범위(reviewer #742): 정적으로 확인한 것은 이 구간에 **직접** 호출이 없다는 데까지다. 대화상자 큐를 거친 간접 호출이 없다는 것은 실측 항목 3에서 닫는다.
3. **[확인] 대신 리더는 Notification hook을 부른다.** 같은 코드가 대화상자를 띄운 뒤, 어떤 조건(코드 안의 두 플래그, 뜻은 미확인)이 맞으면 알림 함수를 부른다. 그 함수는 Notification hook 입력 `{hook_event_name:"Notification", message:"<팀원> needs permission for <도구>", notification_type:"worker_permission_prompt"}`를 실행한 뒤 터미널 알림을 띄운다. 이 hook은 **리더 세션의 session_id**로 온다(리더 프로세스에서 실행). 네트워크 접근 질문은 같은 종류로 `"<팀원> needs network access to <호스트>"`이다.
   - 참고로 리더 자신의 권한 질문도 일정 시간 답이 없으면 `notification_type:"permission_prompt"` Notification을 부른다(`CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS`로 끌 수 있음).
4. **[추정 — 실측 필요] 팀원 프로세스가 질문을 리더에게 넘기기 전에 자기 PermissionRequest hook을 먼저 부르는지는 정적으로 닫지 못했다.** 부른다면 팀원 세션 id·agent 정보로 relay를 거쳐 대시보드에 왔을 것이다. 사용자 증상(손들기 없음)으로 보면 부르지 않거나, 불러도 대시보드가 모르는 세션 id라 층에 붙지 않았을 수 있다. 실측 항목 1이다.
5. **[추정] in-process 팀원과 이름 없는 서브에이전트는 리더 프로세스 안에서 같은 권한 흐름을 탄다.** 그래서 PermissionRequest hook이 리더 session_id와 `agent_id`·`agent_type`과 함께 올 가능성이 높다(대화상자의 `requestSource:"subagent"`, hook 입력의 agent 필드). 실측 항목 2이다.
6. **allow 답의 적용:** 2번 길에서는 hook이 아니라 리더 대화상자의 답이 팀원에게 돌아간다. 그래서 대시보드가 hook으로 allow를 내도 그 길에는 끼어들 수 없다. 4번이 참이라면(팀원이 자기 hook을 먼저 부름) 그때의 allow는 팀원 쪽에 적용된다(일반 PermissionRequest 규칙). 실측 항목 3이다.

## 해결 방향 (2~3안)
- **안 A — Notification으로 "팀원이 권한을 묻는 중" 손들기(답은 터미널):** 플러그인은 이미 13개 이벤트에 Notification을 포함한다. 서버가 리더 세션의 `notification_type:"worker_permission_prompt"`를 받으면 message에서 팀원 이름과 도구를 꺼내 그 팀원 책상에 손들기를 표시한다. 버튼 대신 "리더 터미널에서 답하세요" 안내를 띄운다. 해제는 그 팀원의 다음 PostToolUse·PostToolUseFailure·PermissionDenied 이벤트(팀원 세션), 또는 일정 시간 뒤다. 별도 프로세스 팀원은 session_id가 리더와 다르므로, 리더 세션의 Notification과 그 팀원의 이벤트는 **층 안 팀원 이름으로 짝짓는다**(B71 원칙과 같음). 짝을 찾지 못하면 시간 해제로만 끝낸다. 이 짝짓기와 시간 해제를 구현 계획에 적는다(reviewer #742). 한계:
  - 대시보드에서 답할 수 없다.
  - message 글자 형식은 문서에 없는 내부 문자열이라 바뀔 수 있다. 형식이 맞지 않으면 리드 책상에 "팀원 권한 질문" 하나로 표시한다.
  - 3번의 발화 조건 두 개를 실측해야 한다(포커스 중이면 안 오는지 등).
  - 보안: 이 표시는 인증된 /hooks/v2 이벤트만으로 만든다(B344와 같은 규칙). 표시만이라 권한 효과는 없다.
- **안 B — 진단에 이벤트·알림 종류별 수신 수:** 진단 화면 hook 칸에 "PermissionRequest n · Notification(worker_permission_prompt) m"처럼 종류별 최근 수를 보인다. "모두 초록인데 안 보임"을 사용자가 스스로 가를 수 있다. 작고 안전하며, 안 A의 실측 도구로도 쓴다.
- **안 C — Phase 8 웹 터미널:** 리더 터미널 대화상자 자체를 대시보드에서 보고 답한다. 팀원 질문까지 그대로 답할 수 있는 유일한 길이다. 범위가 크고 별도 보안 설계(터미널 입력 = 명령 실행 권한)가 필요하다.
- 권고: **B를 먼저**(작고 증상을 바로 보여 줌), 실측으로 3·4번을 닫은 뒤 **A**, 답하기는 **C(Phase 8)**로 둔다.

## 실측으로 닫을 것 (로그인된 실제 세션 필요 — 사용자 설치본 확인 또는 허락된 계정)
1. tmux 팀원이 Bash 권한을 물을 때, 팀원 세션 id로 PermissionRequest가 relay에 오는가(오면 session_id·agent_id·agent_type 값).
2. in-process 팀원·이름 없는 서브에이전트가 물을 때, 리더 session_id로 PermissionRequest가 오고 agent 필드가 무엇인가.
3. 1번이 온다면 대시보드 allow가 팀원에게 적용되는가. 안 오면 Notification(worker_permission_prompt)이 리더 세션으로 오는가, 리더 창이 포커스일 때도 오는가.
4. 방법: 대시보드 설치본의 진단 묶음(이벤트 이름·agent 필드만)이나 `claude --debug`의 `[InboxPoller]`·`[PermissionSync]`·`executePermissionRequestHooks` 줄.

## 근거 메모
- 확인 문자열(2.1.310 번들): `[PermissionSync] Sent`, `[InboxPoller] Found … permission request(s)`, `Dropping permission request … agent_id … does not match sender`, `needs permission for`, `notificationType:"worker_permission_prompt"`, Notification hook 입력 생성부(`hook_event_name:"Notification"`, `notification_type`), `executePermissionRequestHooks called for tool`.
- 버전이 바뀌면 이 흐름도 바뀔 수 있다. 결론은 2.1.310 기준이다.
