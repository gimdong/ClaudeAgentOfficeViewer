# Administrator guide / 관리자 안내

[English](#english) · [한국어](#한국어)

## English

Claude Agent Office is a local dashboard. Its Claude Code plugin sends hook events to `http://127.0.0.1:4317` on the same computer and nowhere else. If your organization manages Claude Code settings, add the following to managed settings so the plugin works.

### Managed settings

```json
{
  "enabledPlugins": { "claude-office@claude-office": true },
  "allowedHttpHookUrls": ["http://127.0.0.1:4317/*"],
  "channelsEnabled": true
}
```

- `allowedHttpHookUrls`: needed only while users still run a plugin from an earlier version (plain HTTP hooks), if you restrict HTTP hook URLs. The beta.14 plugin uses command hooks and does not need it.
- `enabledPlugins`: if `allowManagedHooksOnly` is on, the plugin's hooks run only when the plugin is force-enabled here.
- `channelsEnabled`: only if users need the experimental features (sending instructions to a floor, starting a new floor). The app attaches its channel with `--dangerously-load-development-channels`, so `allowedChannelPlugins` is not needed (adding it may block other channel plugins).

Without these settings the dashboard still shows sessions and token counts, but no speech bubbles, raised hands or answering from the dashboard. `claude-office doctor` reports a managed-settings problem as `❌ 회사 관리자 설정: …` ("company managed settings").

On a computer shared by several accounts (any OS), make sure every user installs beta.14 or later from the archive: plugins from earlier versions send plain HTTP hooks that another account can read and answer while the user's dashboard is off (see the [README security model](../README.md#security-model)).

### Lead features (experimental)

Reports, approvals, chat questions and sending teammates off duty use the same channels feature as sending instructions, so they need `channelsEnabled` above. They work only on floors started from the dashboard.

- While a floor is paused, the plugin's three channel tools are not blocked, because they only submit to the dashboard and do not move the session's work forward: `mcp__plugin_claude-office_office-channel__ask_user`, `mcp__plugin_claude-office_office-channel__submit_report`, `mcp__plugin_claude-office_office-channel__submit_handover`.
- Reports and handover notes are stored in `~/.claude-office/reports.json`, and the building name in `~/.claude-office/building.json` (both readable only by the user's account). Nothing is written to `~/.claude`.

### What the PLAN bar shows

The PLAN bar in the top bar uses the rate limits that Claude Code passes to the status line. On macOS and Linux the installer connects to the status line only if the user answers yes in a terminal or runs it with `--statusline` (it changes `statusLine` in the user's `~/.claude/settings.json`, keeps the original settings backup and the values received from the status line in `~/.claude/claude-office`, and `claude-office uninstall` restores it). Without that connection the bar shows `-- statusline 연결이 꺼져 있음(다시 설치할 때 켤 수 있음)` ("status line connection is off; can be turned on when reinstalling"). Windows does not support the connection. The table shows what each account provides when connected.

| Account | 5-hour / weekly bar | Spend-limit bar | Budget |
|---|---|---|---|
| Pro / Max | Shown | — | Works |
| Organization with a gateway spend limit | — | Shown | Works |
| Enterprise seat | `-- 요금제가 알려 주지 않음` ("the plan does not report it") | — | Works |
| API key | `-- 요금제가 알려 주지 않음` ("the plan does not report it") | — | Works |

Per-floor token budgets work on every account because they are counted from local transcripts.

## 한국어

Claude Agent Office는 그 컴퓨터 안에서만 도는 대시보드입니다. 플러그인은 hook 이벤트를 같은 컴퓨터의 `http://127.0.0.1:4317`로만 보냅니다. 회사가 Claude Code 설정을 관리한다면, 플러그인이 동작하도록 관리 설정(managed settings)에 아래를 넣어 주세요.

### 관리 설정

```json
{
  "enabledPlugins": { "claude-office@claude-office": true },
  "allowedHttpHookUrls": ["http://127.0.0.1:4317/*"],
  "channelsEnabled": true
}
```

- `allowedHttpHookUrls`: HTTP hook 주소를 제한하고 있을 때, 사용자가 이전 버전의 플러그인(http hook)을 쓰는 동안만 필요합니다. beta.14 플러그인은 command hook을 써서 필요 없습니다.
- `enabledPlugins`: `allowManagedHooksOnly`가 켜져 있으면 여기서 플러그인을 강제로 켜야 플러그인의 hook이 동작합니다.
- `channelsEnabled`: 실험 기능(작업 지시·새 층)을 쓸 때만 넣습니다. 이 앱은 channel을 `--dangerously-load-development-channels`로 붙이므로 `allowedChannelPlugins`는 필요 없습니다(넣으면 다른 channel 플러그인을 막을 수 있습니다).

이 설정이 없어도 세션과 토큰 숫자는 보이지만, 말풍선·손들기·대시보드에서 답하기는 동작하지 않습니다. `claude-office doctor`는 관리 설정 문제를 `❌ 회사 관리자 설정: …`으로 알려 줍니다.

여러 계정이 쓰는 컴퓨터(운영체제와 무관)에서는 모든 사용자가 압축 파일로 beta.14 이상을 설치했는지 확인하세요. 이전 버전의 플러그인은 암호화하지 않은 http hook을 보내, 사용자의 대시보드가 꺼진 동안 다른 계정이 읽고 대신 답할 수 있습니다([README 보안](../README.ko.md#보안) 참고).

### 리드 기능(실험 기능)

보고서·결재·대화 질문·팀원 퇴근은 작업 지시와 같은 channel 기능을 쓰므로 위의 `channelsEnabled`가 필요합니다. 대시보드가 띄운 층에서만 동작합니다.

- 층이 멈춘(휴업) 동안에도 플러그인의 channel 도구 세 개는 막지 않습니다. 대시보드로 제출만 하고 세션의 일을 진행시키지 않기 때문입니다: `mcp__plugin_claude-office_office-channel__ask_user`, `mcp__plugin_claude-office_office-channel__submit_report`, `mcp__plugin_claude-office_office-channel__submit_handover`.
- 보고서와 인수인계 메모는 `~/.claude-office/reports.json`, 빌딩 이름은 `~/.claude-office/building.json`에 저장합니다(둘 다 그 사용자 계정만 읽을 수 있음). `~/.claude`에는 쓰지 않습니다.

### PLAN 바에 보이는 것

위쪽 막대의 PLAN 바는 Claude Code가 상태줄에 넘겨 주는 사용 한도를 씁니다. macOS·Linux에서 설치 스크립트는 사용자가 터미널에서 y라고 답하거나 `--statusline`을 붙였을 때만 상태줄에 연결합니다(그 사용자의 `~/.claude/settings.json`의 `statusLine`을 바꾸고, 원래 설정의 백업과 상태줄에서 받은 값을 `~/.claude/claude-office`에 두며, `claude-office uninstall`이 되돌립니다). 연결하지 않으면 `-- statusline 연결이 꺼져 있음(다시 설치할 때 켤 수 있음)`으로 보입니다. Windows에서는 연결을 지원하지 않습니다. 아래 표는 연결했을 때 계정마다 보여 줄 수 있는 것입니다.

| 계정 | 5시간·주간 바 | 지출 한도 바 | 예산 |
|---|---|---|---|
| Pro / Max | 보임 | — | 동작 |
| gateway 지출 한도 조직 | — | 보임 | 동작 |
| 엔터프라이즈 좌석 | -- 요금제가 알려 주지 않음 | — | 동작 |
| API 키 | -- 요금제가 알려 주지 않음 | — | 동작 |

층별 토큰 예산은 이 컴퓨터의 대화 기록으로 세므로 모든 계정에서 동작합니다.
