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

- `allowedHttpHookUrls`: needed if you restrict HTTP hook URLs. The plugin only posts to the local dashboard.
- `enabledPlugins`: if `allowManagedHooksOnly` is on, the plugin's hooks run only when the plugin is force-enabled here.
- `channelsEnabled`: only if users need the experimental features (sending instructions to a floor, starting a new floor). The app attaches its channel with `--dangerously-load-development-channels`, so `allowedChannelPlugins` is not needed (adding it may block other channel plugins).

Without these settings the dashboard still shows sessions and token counts, but no speech bubbles, raised hands or answering from the dashboard. `claude-office doctor` reports a managed-settings problem as `❌ 회사 관리자 설정: …` ("company managed settings").

### What the PLAN bar shows

The PLAN bar in the top bar uses the rate limits that Claude Code passes to the status line. The release does not install the status-line tap yet, so every account currently shows `-- 데이터 없음` (no data); the table shows what each account can provide once it is supported.

| Account | 5-hour / weekly bar | Spend-limit bar | Budget |
|---|---|---|---|
| Pro / Max | Shown | — | Works |
| Organization with a gateway spend limit | — | Shown | Works |
| Enterprise seat | `-- 데이터 없음` (no data) | — | Works |
| API key | `-- 데이터 없음` (no data) | — | Works |

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

- `allowedHttpHookUrls`: HTTP hook 주소를 제한하고 있다면 필요합니다. 플러그인은 이 컴퓨터의 대시보드로만 보냅니다.
- `enabledPlugins`: `allowManagedHooksOnly`가 켜져 있으면 여기서 플러그인을 강제로 켜야 플러그인의 hook이 동작합니다.
- `channelsEnabled`: 실험 기능(작업 지시·새 층)을 쓸 때만 넣습니다. 이 앱은 channel을 `--dangerously-load-development-channels`로 붙이므로 `allowedChannelPlugins`는 필요 없습니다(넣으면 다른 channel 플러그인을 막을 수 있습니다).

이 설정이 없어도 세션과 토큰 숫자는 보이지만, 말풍선·손들기·대시보드에서 답하기는 동작하지 않습니다. `claude-office doctor`는 관리 설정 문제를 `❌ 회사 관리자 설정: …`으로 알려 줍니다.

### PLAN 바에 보이는 것

위쪽 막대의 PLAN 바는 Claude Code가 상태줄에 넘겨 주는 사용 한도를 씁니다. 배포판은 아직 상태줄 탭을 설치하지 않으므로 지금은 모든 계정에서 `-- 데이터 없음`으로 보입니다. 아래 표는 지원된 뒤 계정마다 보여 줄 수 있는 것입니다.

| 계정 | 5시간·주간 바 | 지출 한도 바 | 예산 |
|---|---|---|---|
| Pro / Max | 보임 | — | 동작 |
| gateway 지출 한도 조직 | — | 보임 | 동작 |
| 엔터프라이즈 좌석 | -- 데이터 없음 | — | 동작 |
| API 키 | -- 데이터 없음 | — | 동작 |

층별 토큰 예산은 이 컴퓨터의 대화 기록으로 세므로 모든 계정에서 동작합니다.
