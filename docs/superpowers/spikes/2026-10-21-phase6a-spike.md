# Phase 6a spike 보고서: hook을 command hook으로 (2026-10-21)

- 브랜치 `spike/phase6a`(main 14a4d33에서 시작, 병합하지 않음). 실험 코드는 버림(저장소 밖 job 임시 폴더). 이 문서가 산출물이다.
- 목적: Phase 5 Critical-1의 hook 쪽 근본 수정을 확인한다. 지금 플러그인의 http hook은 받는 쪽이 누구인지 확인하지 않는다. 그래서 다계정 컴퓨터에서 대시보드가 꺼진 동안 다른 계정이 `127.0.0.1:4317`을 차지하면 hook 응답을 위조하고 도구 입력·결과를 볼 수 있다(Phase 5에서는 문서로 밝히고 받아들임).
- 설계 전제(사용자 승인): `plugins/claude-office/hooks/hooks.json`의 hook 13개를 **전부** http → command hook(`relay.mjs`)으로 바꾼다. relay는 0600 hook 열쇠 파일로 **서버가 먼저 증명**하는 챌린지-응답(Phase 5 channel B257 재사용)을 거친 뒤에만 이벤트를 보내고, 답을 stdout으로 돌려준다. 대시보드 꺼짐·증명 실패면 아무것도 출력하지 않고 즉시 끝난다(세션은 터미널 권한으로 계속).
- 근거: developer 실측(모델 없이, macOS, Node 24), security 설계 검토·중계 공격 실측, qa 공식 문서 조사(code.claude.com/docs/en/hooks, 2026-10-21 확인). 실제 Claude Code 세션 실측은 하지 않았다 — 임시 `CLAUDE_CONFIG_DIR`에서 로그인 화면이 나왔고, 자격 증명을 옮기지 않기로 한 규칙대로 멈췄다. 사용자 결정으로 그 항목은 설계로 대비하고 구현 끝에 사용자가 설치본으로 확인한다.

## 요약

| 항목 | 판정 | 한 줄 |
|---|---|---|
| ① 지연 | ✅ | CJS + `node:net` 단일 파일 relay가 도구 1회(Pre+Post) **웜 65.5ms**(p95 66.7) — 기준 100ms 안. 권고대로 exec form이면 셸 비용이 없어 이 값이 기준 |
| 실패 경로 | ✅ | 꺼짐·가짜 서버·열쇠 없음 모두 약 30ms에 무출력 exit 0, 가짜 서버는 hello만 받음(이벤트 본문 0바이트) |
| ② 결정 반영 | ⚠️ 문서 근거, 실측 미완 | command hook과 http hook은 같은 입출력 스키마(qa). Claude Code가 command hook 결정을 따르는 것은 실제 세션으로 확인하지 못함 |
| ③ 취소 감지 | 서버 쪽 ✅ / Claude Code 쪽 ⚠️ | relay가 어떤 신호로 끝나든 서버는 5~13ms 안에 `res.on('close')`로 앎. Claude Code가 어떤 신호를 보내는지는 미확인 |
| ④ 병합 | 부분 ✅ | 문서: PreToolUse는 deny > defer > ask > allow(우리 deny가 이김). PermissionRequest·updatedInput 병합은 문서에 없음 |
| 보안 검토 | Important 2 | 요청 본문 무인증(재현) → AES-GCM 권고 / 맨 `node`의 PATH 탐색 → exec form + 절대 경로 |

## ① 지연 — ✅

모델 없이 relay 프로세스를 직접 띄워, 시험 서버(127.0.0.1, 4320 이상 포트)와 Pre+Post 한 쌍을 주고받는 시간을 쟀다.

| relay 구현 | 웜 중앙값 |
|---|---|
| ESM + fetch | 110ms |
| ESM + node:http | 95ms |
| **CJS + node:net(raw socket) 단일 파일** | **65.5ms**(p95 66.7) |
| 참고: 지금 http hook(Claude Code 프로세스 안) | 0.6ms |

- 줄인 방법: ESM → CJS −22ms, fetch → node:http −15ms, node:http → node:net −7ms.
- 효과 없던 방법: compile cache, keep-alive. `node --snapshot-blob`은 오히려 +5ms였고, node:http를 쓰는 판은 스냅샷 빌드가 실패했다.
- 비용의 대부분(쌍당 54ms)은 node를 두 번 띄우는 데서 나온다. 남은 약 11ms 가운데 약 6ms는 모듈 적재(`require`만으로 60.0ms), 핸드셰이크·전송은 약 5ms다. 그래서 코드를 더 다듬어도 크게 줄지 않는다.
- 도구 1회마다 지금보다 약 65ms가 늘어난다. 셸(`sh -c`, shell form)로 띄우면 약 72ms로 **추정**된다(ESM판에서 잰 셸 비용 +6.7ms를 더한 값, CJS판에서는 재지 않음) — 아래 권고의 exec form은 셸을 쓰지 않는다. 디스크 콜드(캐시를 비운 첫 실행)는 sudo가 필요해 재지 않았다.
- 보안 강화 두 안(아래 보안 ⑤)의 지연은 같다: 기준(본문 무인증) 65.6/66.0ms, (가) 본문 MAC 65.7/67.7ms, (나) AES-256-GCM 65.5/68.1ms(웜 중앙값/p95). 차이는 측정 잡음 안이다.

## 실패 경로 — ✅

- 대시보드 꺼짐, 가짜 서버(증명 못 함), 열쇠 파일 없음: 모두 약 30ms에 exit 0, stdout 0바이트.
- 가짜 서버가 받은 것은 hello(열쇠 식별자 kid와 nonce)뿐이고, 이벤트 본문은 0바이트였다.
- 공식 문서: 무출력 exit 0은 "결정 없음"이고 평소 권한 흐름으로 간다("staying silent doesn't approve it"). 그래서 대시보드가 꺼지거나 가짜 서버면 터미널이 직접 묻는다.

## ② 결정 반영 — ⚠️ 문서 근거, 실측 미완

- 공식 문서상 command hook과 http hook은 같은 입출력 스키마다. http의 "2xx + JSON 본문"이 command의 "exit 0 + stdout JSON", "빈 본문"이 "무출력 exit 0"에 해당한다.
- PreToolUse의 `hookSpecificOutput.permissionDecision`(allow/deny/ask)·`updatedInput`, PermissionRequest의 `decision.behavior` 모두 같은 형식이다.
- exit code: 2는 차단(이유는 stderr), 그 밖의 0이 아닌 코드는 차단하지 않는 오류. **PermissionRequest는 exit 2를 무시**하므로 deny는 `decision.behavior`로 보내야 한다.
- 실제 Claude Code 세션에서 command hook의 결정을 그대로 따르는지는 확인하지 못했다(로그인 화면에서 멈춤). → 구현 끝 사용자 설치본 확인 항목.

## ③ 취소 감지

- **서버 쪽 ✅:** relay가 SIGTERM·SIGINT·SIGHUP·SIGKILL 어느 것으로 끝나도, 서버는 5~13ms 안에 `res.on('close')`로 연결이 끊긴 것을 안다(`writableEnded=false`). 그래서 relay가 끝나면 대시보드의 손들기(대기 중 결정)를 닫을 수 있다.
- **Claude Code 쪽 ⚠️:** PermissionRequest를 기다리는 동안 사용자가 터미널에서 먼저 답하거나 Esc를 누를 때 Claude Code가 hook 프로세스를 어떻게 끝내는지(신호 종류)는 문서에 없고, 실측하지 못했다.
- **설계로 대비:** relay에 자체 대기 한도를 둔다. hook `timeout`(기본 600초)보다 약간 짧게(예: 590초) 잡고, 넘으면 무출력 exit 0으로 끝낸다. 그러면 Claude Code가 프로세스를 끝내든, relay가 스스로 끝나든 서버는 같은 `close`로 결정을 닫는다.
- timeout 문서: 만료되면 취소·출력 버림·결정 없음. PreToolUse도 통과한다.

## ④ 병합

- 문서: hook은 병렬로 실행된다. 같은 핸들러는 settings 사이에서 한 번만, 플러그인 사본은 따로 실행된다.
- PreToolUse 결정은 **deny > defer > ask > allow**로 이긴다. 그래서 사용자가 다른 도구의 hook으로 allow를 내도 우리 deny가 이긴다.
- 문서: PermissionRequest에서 hook의 allow는 일치하는 deny 규칙을 덮지 않는다.
- PermissionRequest 결정과 `updatedInput`의 병합 규칙은 문서에 없다. → 설명서에 한 줄("다른 도구의 hook과 함께 쓰면 권한 요청의 결정이 어떻게 합쳐지는지는 Claude Code에 달려 있습니다")을 두고, 구현 끝 사용자 확인 항목.

## 보안 검토 (security)

### 검토 결과
- **① 순서(실측):** 4317을 남이 차지해도 이벤트 본문이 나가기 전에 끊긴다(위 실패 경로).
- **② 열쇠 파일(설계 권고):** 토큰과 따로 `<설치 폴더>/hook.key`(0600, 폴더 0700). 경로는 설치 때 플러그인 설정에 적는다. 회전은 rename으로 원자적으로 한다(서버 시작마다 회전은 권하지 않음). 다른 계정은 읽지 못하고, 같은 계정은 범위 밖(이미 모든 것을 읽을 수 있음). relay는 열쇠 파일을 읽을 때 `fstat`으로 owner(자기 uid)와 mode(0600)를 검사해, 맞지 않으면 무출력 종료한다(시험 후보 6의 근거).
- **③ 무출력:** 무출력 exit 0이 허용으로 해석되는 이벤트는 없다(security 판단 — 문서 인용은 도구 호출과 권한 흐름(PreToolUse·PermissionRequest) 부분만 확인, 13개 이벤트 전부는 아님). 위험은 exit 2와 JSON이 아닌 stdout이다 — security 판단으로 UserPromptSubmit·SessionStart에서는 JSON이 아닌 stdout이 대화 문맥에 들어갈 수 있다(문서 인용 없음, 구현 끝 확인 항목). 그래서 relay는 **모든 오류·신호에서 exit 0과 빈 stdout으로 끝나고, 검증을 통과한 JSON만 한 번에 다 쓴 뒤 끝나야 한다**(출력 안전 규칙). 시제품에는 아직 없어 구현 필수.
- **④ 실패 구분(설계 권고):** 동작은 구분하지 않는다(모두 무출력). 증명 실패만 0600 `relay.log`에 한 줄(본문·kid·nonce 없이) 남겨 doctor가 보여 준다. 연결 거부는 아무것도 남기지 않는다. 핸드셰이크 시간 초과는 짧게, 결정 대기는 위 ③의 자체 한도.
- **⑥ 병합:** PreToolUse deny 우선이라 다른 도구의 allow보다 우리 deny가 이긴다.

### Important 1 — 요청 본문이 인증되지 않는다 (재현)
- 서버가 먼저 증명하는 핸드셰이크만으로는 부족하다. 핸드셰이크를 진짜 서버로 그대로 넘기는 중계자가, 그 뒤 본문의 `tool_input.command`만 바꿀 수 있다.
- 실측: 중계자가 명령을 `ls -la`로 바꾸면 대시보드에는 바뀐 명령이 보이고, 사용자가 허용하면 relay는 MAC이 맞는 allow를 출력한다. Claude는 **원래 명령**을 실행한다 — 사용자는 보지 않은 명령을 허용한 셈이다. 응답 MAC만으로는 막을 수 없다.
- 두 안을 시제품으로 만들어 중계 공격(요청 본문 변조·응답 변조·응답 재사용·요청 재전송·가짜 서버)을 대조했다(보강 전 판은 본문 변조 때 allow를 냄). (나)는 다섯 경우를 실측으로 막았다(본문은 평문이 보이지 않아 암호문 1비트를 바꿔 시험). (가)는 본문·응답 변조와 가짜 서버를 실측으로 막았고, 응답 재사용·요청 재전송은 구조상 막힌다(추론, 실측 안 함).
  - (가) 요청 본문 MAC + 응답을 요청 해시에 묶기(2 RTT): 위조는 막지만, 중계자가 평문을 볼 수 있다.
  - (나) **AES-256-GCM 양방향 암호화(1 RTT)**: 위조와 엿보기를 모두 막는다. 중계·가짜 서버 로그에 평문 0건. 서버에 재전송 막는 기록(ts·id)이 필요하다.
- **권고: (나).** 지연은 같고, Critical-1의 원래 피해(도구 입력·결과 노출)까지 닫는다. 구현 때 방향별 키, 재전송 기록의 정리와 상한, 형식 검사를 넣는다.
- 남는 위험(받아들임): 암호문 길이로 본문(명령) 길이를 짐작할 수 있고, kid로 같은 연결의 요청끼리 이을 수 있으며 활동 시각이 드러난다.

### Important 2 — 맨 `node`는 PATH로 찾는다
- hooks.json의 command가 맨 이름 `node`이면, PATH에 `.`이나 빈 항목이 있을 때 작업 폴더의 `./node`가 hook마다 실행된다.
- exec form(`args`)만으로는 풀리지 않는다 — 셸 해석은 없어지지만 맨 이름은 여전히 PATH로 찾는다.
- **권고:** exec form + 설치 때 적은 node 절대 경로. 예: `"command": "<설치 때의 node 절대 경로>", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/relay.mjs"]`.
- nvm 전환 등으로 그 경로가 사라지면 터미널 권한으로 돌아가 안전하지만, 대시보드가 조용히 멈춘다 → doctor가 이 경로를 검사한다.

### onFailure — 13개 모두 기본값("continue")
- 문서에 `onFailure: "block"`(실패하면 차단)이 있다. 그러나 이 설계에서 대시보드 꺼짐·증명 실패는 무출력 exit 0, 곧 **성공**이라 "block"은 Critical-1을 막지 못한다.
- 오히려 부작용이 생긴다: PermissionRequest 시간 초과가 거부로 바뀌고, 포트를 차지한 쪽이 응답을 끌기만 해도 모든 도구를 막을 수 있으며(서비스 거부), Stop·TeammateIdle을 멈추지 못하게 된다.
- "block"을 권할 곳은 나중의 opt-in "엄격 모드"(PreToolUse 하나만)뿐이고, 이번 범위 밖이다.

### 구현 Phase의 보안 시험 후보 (security)
1. 가짜 서버(proof 없음·틀린 proof·모르는 kid·hello 404): stdout 0바이트, exit 0, 가짜 서버가 받은 요청에 본문 표지·열쇠 원문 없음.
2. 중계 본문 변조: 서버가 거절하거나 stdout 0바이트.
3. 중계 응답 변조(deny→allow, updatedInput 바꿈): stdout 0바이트.
4. 재전송: 같은 nonce로 두 번째 이벤트 → 거절, 지난 응답을 새 호출에 끼우면 stdout 0.
5. 응답의 hookEventName이 받은 이벤트와 다르면 stdout 0. UserPromptSubmit·SessionStart는 JSON 객체만.
6. 오류 경로(열쇠 없음·0644·owner 다름·잘린 열쇠·잘못된 stdin JSON·1MB 초과·연결 중 끊김·쓰레기 JSON): 모두 exit 0, stdout 0바이트, stderr에 경로·스택 없음.
7. 신호: 결정 대기 중 SIGTERM·SIGINT·SIGHUP → exit 0, stdout 0, 서버는 `close`로 결정을 닫음.
8. exit 2 경로 없음(소스에 `process.exit(2)`·`exitCode = 2`가 없음을 확인하는 테스트).
9. 증명 실패는 relay.log(0600)에 한 줄, 본문·kid·nonce 없음. 연결 거부는 기록 없음.
10. 열쇠 회전 경쟁: rename 동안 100번 실행해도 stdout은 0바이트거나 올바른 답.
11. 실행 경로: PATH에 `.`이 있고 cwd에 가짜 `node`가 있어도 설치 때 적은 절대 경로의 node가 쓰인다.
12. onFailure가 없거나 "continue", exec form + 절대 경로(설치본 hooks.json 검사).

## 6a 설계에 주는 결론
1. command hook으로 바꾸는 것은 지연 면에서 된다 — CJS + raw socket 단일 파일 relay를 exec form으로 띄우면 도구 1회 약 65ms.
2. relay 프로토콜은 **AES-256-GCM 1 RTT**(서버가 먼저 증명 + 요청·응답 모두 암호화·인증). 핸드셰이크만 인증하는 판은 중계 공격에 뚫린다.
3. 실행은 **exec form + node 절대 경로**, `onFailure`는 기본값.
4. relay는 출력 안전 규칙(모든 오류·신호에서 exit 0 + 빈 stdout, 검증한 JSON만 한 번에)과 자체 대기 한도(hook timeout보다 약간 짧게)를 지킨다.
5. 이 설계를 적용하면 Phase 5 Critical-1(hook 쪽)과 "macOS 다른 계정의 가짜 hook"이 함께 닫힌다. 남는 것은 "대시보드가 꺼진 동안은 터미널 권한으로 돌아간다"는 사용성뿐이다.

## 구현 끝 사용자 설치본 확인 (실제 세션 실측 대신)
1. **정책 deny가 막는지:** 대시보드의 권한 정책으로 막은 도구가 command hook 경로에서도 막히는지.
2. **대시보드 허용·거부가 반영되는지:** 권한 요청을 대시보드에서 허용·거부하면 Claude Code가 그대로 따르는지(updatedInput 포함).
3. **터미널에서 먼저 답할 때 손들기가 닫히는지:** 대시보드에 손들기가 떠 있는 동안 터미널에서 먼저 답하거나 Esc를 누르면, 대시보드의 손들기가 사라지는지.
4. 대시보드를 끈 상태에서 도구를 쓰면 터미널이 평소처럼 묻는지(무출력 exit 0 = 평소 권한 흐름).
5. 다른 도구의 hook과 함께 쓸 때 우리 deny가 이기는지, 권한 요청 결정이 어떻게 합쳐지는지(설정의 deny 규칙은 hook allow로 덮이지 않음).
6. relay가 받는 작업 폴더(cwd)와 env가 예상대로인지.
7. UserPromptSubmit·SessionStart에서 relay 출력이 대화 문맥에 끼어들지 않는지(출력 안전 규칙).
8. `--debug` 로그에서 터미널에서 먼저 답할 때 hook이 `cancelled`로 끝나고 대시보드 손들기가 닫히는지(③ Claude Code 쪽).

## 안전 기록
- 실험은 job 임시 폴더(각자 하위 폴더), 127.0.0.1, 포트 4320 이상만. 사용자 4317 대시보드·설치본·`~/.claude`는 건드리지 않았다(settings.json 해시 전후 같음). install.sh는 돌리지 않았다.
- 실제 Claude Code 세션은 임시 설정 폴더에서 로그인 화면까지만 띄우고 내렸다(프롬프트 0개, 자격 증명은 건드리지 않음). 띄운 프로세스는 모두 기록한 PID로만 내렸다. developer는 4320~4330 리슨 0을 확인했고, security(4331~4362)는 띄운 PID로 내렸으며, 보고서 커밋 뒤 director가 4320~4362 리슨 0을 다시 확인했다.
- 비밀값·실제 사용자 이름·홈 경로는 이 문서와 결과 파일에 없다.
