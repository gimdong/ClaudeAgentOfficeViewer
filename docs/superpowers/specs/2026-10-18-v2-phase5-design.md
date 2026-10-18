# v2 Phase 5 — 공개 배포 설계

## 1. 배경과 목표
- 저장소(gimdong/ClaudeAgentOfficeViewer)가 공개로 바뀌었다. 사내 동료뿐 아니라 누구나 받아 쓸 수 있다.
- 설치는 지금처럼 GitHub Releases의 압축 파일 하나(서버 + 플러그인)로 한다. 저장소를 마켓플레이스로 직접 등록하는 경로는 만들지 않는다(플러그인만 깔리고 서버가 없는 상태를 막기 위해).
- 이번 단계의 네 가지: (2장) 같은 계정만 받기, (3장) 서버·플러그인 버전 불일치 경고, (4장) 영어 README·설명서, (5장) 관리자 안내 한 장.
- 하지 않는 것: 화면 문구 번역, macOS·Windows의 계정 검사, 저장소 마켓플레이스 등록.

## 2. 같은 계정만 받기 (Linux)
위협: 여러 사람이 쓰는 Linux(예: DGX)에서 다른 계정의 프로세스가 `127.0.0.1:4317`에 접속해 가짜 권한 요청·질문을 띄우거나 사용자의 답을 받아 갈 수 있다. 같은 계정의 프로세스는 이미 `~/.claude`를 읽을 수 있으므로 막을 대상이 아니다.

- **범위:** 4317의 모든 요청(hook, channel, `/api`, 화면). Host 검사 바로 뒤의 미들웨어 하나.
- **켜지는 조건:** `process.platform === "linux"`이고 `process.getuid`가 있을 때. 그 밖의 OS는 검사하지 않는다.
- **판정:** 요청 소켓의 `remotePort`를 클라이언트 쪽 로컬 포트로 보고, `/proc/net/tcp`와 `/proc/net/tcp6`에서 `local_address` 포트 = remotePort, `rem_address` 포트 = 서버 포트인 줄을 찾는다. 그 줄의 uid 열이 `process.getuid()`와 같으면 통과.
- **실패하면 거절:** 줄이 없거나 `/proc`를 읽을 수 없으면 403. 다른 uid도 403.
- **캐시:** 판정은 소켓마다 한 번. 결과를 `WeakMap<Socket, boolean>`에 둔다(keep-alive 연결에서 다시 읽지 않는다).
- **진단:** `HookStatsView.rejected`에 `"403-uid"` 키를 더해 거절 수를 센다(모든 경로). doctor는 이 수가 0보다 크면 경고 한 줄: `다른 계정의 접속 {n}건을 막았습니다. 여러 사람이 쓰는 컴퓨터라면 정상입니다.`
- **응답 본문:** `같은 사용자 계정의 프로그램만 접속할 수 있습니다` (text/plain).
- **로그:** uid 값과 포트는 적지 않고, 거절 사실과 경로 종류(hook/api/기타)만 적는다.
- **코드 위치:** `server/peer.ts` — `peerUidFromProc(tcpText: string, tcp6Text: string, clientPort: number, serverPort: number): number | null` (순수 함수)와 `sameUserGuard(opts)` 미들웨어. `/proc` 읽기는 미들웨어 안에서 `readFileSync`로 하고, 테스트는 읽기 함수를 주입한다.

### /proc/net/tcp 형식
```
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:A1B2 0100007F:10DD 01 00000000:00000000 00:00000000 00000000  1000        0 12345
```
포트는 콜론 뒤 16진수 4자리. uid는 8번째 열(0부터 세면 7). 첫 줄은 머리글이다. tcp6의 주소는 32자리 16진수지만 포트 위치는 같다.

## 3. 서버·플러그인 버전 불일치 경고
- `plugins/claude-office/hooks/hooks.json`의 모든 http hook에 `"headers": { "X-Claude-Office-Plugin": "<버전>" }`을 넣는다. 정적 값이라 `allowedEnvVars`가 필요 없다.
- 서버는 `/hooks/event`에서 이 헤더를 읽어 마지막 값을 기억한다(`pluginVersion: string | null`, 헤더가 없으면 `"unknown"`).
- 스냅샷에 `plugin?: { version: string; match: boolean }`을 넣는다. hook을 한 번도 받지 않았으면 넣지 않는다.
- HUD에 `match === false`일 때만 칩 하나: `플러그인 {version} ≠ 서버 {서버 버전} — 같은 압축 파일로 다시 설치하세요` (version이 `"unknown"`이면 `플러그인 버전 모름`).
- 버전 올리기 대상에 hooks.json을 더한다(7파일). `test/plugin/plugin.test.ts`가 모든 hook의 헤더가 package.json 버전과 같은지 확인한다.

## 4. 영어 README·설명서
- `README.md`를 영어로 새로 쓰고, 지금 한국어 내용은 `README.ko.md`로 옮긴다. 두 파일 첫 줄에 서로의 링크.
- 영어 README 내용: 무엇인지(그림 한 장), 설치(macOS/Linux tar.gz, Windows zip), 시작(`claude-office open`), 보안 모델(127.0.0.1만, 토큰 URL, Linux 같은 계정 검사, `~/.claude`는 읽기만, 설정 파일 비수정), 실험 기능(channels, 연구 프리뷰), 관리자 안내 링크, 라이선스.
- `docs/manual/en.html`: 한국어 설명서의 설치·시작·문제 해결 세 장만 영어로. 그림은 넣지 않는다. 한국어 설명서 첫 부분에 영어판 링크.
- 릴리스 노트(`.github/workflows/release.yml`의 본문)에 영어 문단을 앞에 둔다. "Source code 압축은 설치에 쓰지 마세요"의 영어판도 넣는다.
- 버전 올리기 대상에 en.html이 버전을 적는다면 포함한다(적지 않으면 대상 아님).

## 5. 관리자 안내 (`docs/admin.md`, 영어 + 한국어)
- managed settings 예시:
```json
{
  "enabledPlugins": { "claude-office@claude-office": true },
  "allowedHttpHookUrls": ["http://127.0.0.1:4317/*"],
  "channelsEnabled": true,
  "allowedChannelPlugins": ["claude-office@claude-office"]
}
```
  - `allowManagedHooksOnly` 환경에서는 `enabledPlugins`로 강제 활성화해야 hook이 살아난다.
  - channels 두 항목은 실험 기능(작업 지시·새 층)을 쓸 때만.
- 요금제별 PLAN 바 표:

| 계정 | 5시간·주간 바 | 지출 한도 바 | 예산 |
|---|---|---|---|
| Pro / Max | 보임 | — | 동작 |
| gateway 지출 한도 조직 | — | 보임 | 동작 |
| 엔터프라이즈 좌석 | -- 데이터 없음 | — | 동작 |
| API 키 | -- 데이터 없음 | — | 동작 |

- 코드 변경 없음.

## 6. 테스트
- `test/server/peer.test.ts`: 같은 uid 통과, 다른 uid 거절, 줄 없음 거절, tcp6 줄 판정, 머리글·빈 줄 무시, 읽기 실패 거절, linux가 아니면 검사 안 함, 같은 소켓 두 번째 요청은 다시 읽지 않음.
- `test/server/app.test.ts` 또는 새 파일: 미들웨어가 `/hooks/event`·`/api/*`·화면 모두에 걸리고 거절 수가 `403-uid`에 쌓임.
- 버전: hook 헤더 → 스냅샷 `plugin.match`, 헤더 없음 → `unknown`, HUD 칩 표시/숨김.
- 문서: `README.md`·`README.ko.md` 상호 링크, `docs/admin.md`의 JSON이 파싱됨, `en.html`에 세 장 제목.
- 실제 Linux 다계정 확인은 사용자가 DGX에서 한다(설치본 확인 절차를 설명서에 한 줄).

## 7. 위험
- 컨테이너·네트워크 네임스페이스가 다르면 `/proc/net/tcp`에 클라이언트 줄이 없어 거절된다. 진단 문구로 알 수 있게 한다. 우회 설정은 만들지 않는다(필요해지면 그때).
- `/proc/net/tcp`가 매우 큰 서버(수만 연결)에서는 첫 요청이 느릴 수 있다. 연결마다 한 번만 읽으므로 받아들인다.
