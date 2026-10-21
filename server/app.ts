import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../src/shared/types";
import type { DiagnosticsSummary } from "../src/shared/types";
import type { HookStats } from "./events/stats";
import { CLEAR_OLD_COOKIE, COOKIE, bearerOf, cookieName, cookieOf, tokenMatches } from "./auth";
import { BUDGET_MAX, BUDGET_MIN } from "./budget/store";
import { parseAnswer } from "./decisions/protocol";
import type { DecisionQueue } from "./decisions/queue";
import type { SnapshotHub } from "./hub";
import { errInfo, getLogger } from "./log";
import type { PolicyVerdict } from "./policy/gate";
import { isTargetKey, parseRules, type PolicyFile, type SetResult } from "./policy/store";
import type { PolicyRules } from "../src/shared/types";
import type { SessionRecord } from "./collectors/sessions";
import type { TerminateResult } from "./floors/control";
import { MAX_TEXT, type ChannelHub } from "./floors/channels";
import { sameUserGuard } from "./peer";
import { HOOK_V2, openRequest, sealResponse, type HookKeys, type ReplayWindow } from "./hooks/v2";
import type { HeldResponse } from "./decisions/queue";
import type { ReopenMode, ReopenResult } from "./floors/reopen";
import { validateLaunch, type LaunchInput } from "./floors/launch";
import { leadInstruct, type LeadSent } from "./floors/lead";
import { DutyBoard } from "./floors/duty";
import { PairingBook } from "./floors/pairing";
import { ReportStore, folderView } from "./floors/reports";
import { handleSubmit } from "./floors/submit";
import { QuestionBoard } from "./floors/questions";

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Host 헤더에서 포트를 뗀 호스트명만 꺼낸다. IPv6 리터럴("[::1]:4317")의 대괄호는 그대로 남긴다. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const i = h.lastIndexOf(":");
  return i === -1 ? h : h.slice(0, i);
}

/**
 * Host 헤더가 로컬 주소를 가리키는지 확인한다(DNS rebinding 방지 — 127.0.0.1에만 바인딩해도
 * 공격자 페이지가 자신이 통제하는 도메인을 그 IP로 리졸브시켜 브라우저가 이 서버로 요청을
 * 보내게 만들 수 있다. Host 헤더는 그 도메인 이름 그대로 오므로 여기서 걸러낸다).
 * 포트는 검사하지 않는다 — Vite dev 프록시(target 문자열 축약형, changeOrigin 미설정이라 기본값
 * false)가 브라우저의 원래 Host(예: localhost:5173)를 그대로 이 서버에 넘기기 때문에, 포트까지
 * 검사하면 dev 서버를 거친 요청이 막힌다. 대소문자를 구분하지 않는다.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return ALLOWED_HOSTNAMES.has(hostnameOf(hostHeader).toLowerCase());
}

export type { DiagnosticsSummary }; // 화면과 같이 쓰도록 src/shared/types.ts로 옮겼다

/** 예산 관문(Task 6이 채운다). 둘 다 메모리 값만으로 즉시 답한다(1초 안) */
export interface BudgetGateHooks {
  /** PreToolUse에 돌려줄 JSON. 관문이 아니면 null(빈 200) */
  preToolUse(input: Record<string, unknown>): object | null;
  /** 이 PermissionRequest가 방금 연 관문 호출이면 예산 값, 아니면 null */
  claim(input: Record<string, unknown>): { budgetTokens: number; usedTokens: number } | null;
}
export interface DiagnosticsDeps { summary(): Promise<DiagnosticsSummary>; makeBundle(): Promise<string>; diagDir: string }

const BUNDLE_NAME = /^claude-office-diag-\d{8}-\d{6}\.json$/;

/**
 * 화면용 쓰기 API의 Origin 규칙(Ruling B1). Origin이 없으면(CLI·curl) 통과 — Host 검사는 앞 미들웨어가 했다.
 * 있으면 http이고, Host와 같은 host:port이며, 그 호스트가 로컬 주소여야 한다. 다른 웹페이지의 요청을 막는다.
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && !!host && u.host.toLowerCase() === host.trim().toLowerCase() && isAllowedHost(u.host);
  } catch {
    return false;
  }
}

/** 대시보드 쿠키 Set-Cookie 줄. 속성은 Phase 2 그대로(HttpOnly·SameSite=Strict·Path=/, 1년). 이름은 cookieName(B297) */
const cookieLine = (name: string, token: string) => `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;

/** handleHook이 쓰는 응답 모양: 결정 큐가 붙잡는 모양 + headersSent */
type HookResponse = HeldResponse & { readonly headersSent: boolean };

/** /hooks/v2 응답 어댑터: 200 json·end를 {id, out}으로 암호화해 한 번만 보낸다. 그 밖의 상태는 401 빈 본문 */
function sealed(real: express.Response, id: string, keys: HookKeys): HookResponse {
  const send = (code: number, out: unknown) => {
    if (real.headersSent) return;
    if (code === 200) real.status(200).json(sealResponse(id, out, keys));
    else real.status(401).end();
  };
  return {
    get writableEnded() {
      return real.writableEnded;
    },
    get headersSent() {
      return real.headersSent;
    },
    on: (event, fn) => real.on(event, fn),
    status: (code) => ({ json: (b: unknown) => send(code, b), end: () => send(code, null) }),
  };
}

export function createApp(
  hub: Pick<SnapshotHub, "current" | "subscribe"> & Partial<Pick<SnapshotHub, "poke">>,
  opts: {
    staticDir?: string;
    heartbeatMs?: number;
    onHookEvent?: (input: Record<string, unknown>) => void;
    /**
     * hook이 보낸 플러그인 버전(Phase 5 §3). 옛 /hooks/event는 X-Claude-Office-Plugin 헤더(없으면 "unknown")에 legacy=true,
     * /hooks/v2는 요청 평문의 plugin에 legacy=false(Phase 6a §4). sessionId는 대화 키로 바꾼 값
     */
    onPluginVersion?: (version: string, legacy: boolean, sessionId: string) => void;
    /** 암호화 hook 입구(Phase 6a §4). keys()가 null이면(열쇠 파일 소유자가 다름 등) 입구를 닫는다(모두 401) */
    hookV2?: { keys(): HookKeys | null; seen: ReplayWindow };
    /** hook의 session_id를 대화 키로 바꾼다(B194 — 합친 층의 층 id로 온 hook). 모르는 id는 그대로. 없으면 바꾸지 않는다 */
    normalizeSession?: (sessionId: string) => string;
    stats?: HookStats;
    diagnostics?: DiagnosticsDeps;
    /** 대시보드 토큰(스펙 7.1). 없으면 인증하지 않는다(단위 테스트용). main()은 항상 넣는다 */
    auth?: { token: string; /** 401 본문에 싣는 서버 버전(FB-8). 런처가 떠 있는 서버가 같은 버전인지 가린다 */ version?: string };
    /** 결정 큐(스펙 3.2). 없으면 PermissionRequest도 즉시 빈 200(Phase 1 동작) */
    decisions?: Pick<DecisionQueue, "hold" | "answer" | "onEvent">;
    gate?: BudgetGateHooks;
    /** PUT /api/budget(스펙 5.4). sessionId가 없으면 새 층 기본값. 값 검사는 라우트가 한다 */
    budget?: { set(sessionId: string | undefined, budgetTokens: number | null): void };
    /** 권한 정책 관문(Phase 3 스펙 6장). 메모리 값만 보는 동기 판정 */
    policy?: { preToolUse(input: Record<string, unknown>): PolicyVerdict | null; claim(input: Record<string, unknown>): boolean };
    /** 정책 API(스펙 7.4). 바뀌면 hub.poke()로 스냅샷을 다시 만든다 */
    policyApi?: { all(): PolicyFile; set(target: string, rules: PolicyRules): SetResult; remove(target: string): { ok: true; saved: boolean } };
    /** 작업 지시·새 층(Phase 4b). launch는 tmux를 띄우고 세션 id를 돌려준다 */
    channels?: {
      hub: ChannelHub;
      launch(input: LaunchInput): Promise<{ ok: true; sessionId: string; tmux: string } | { ok: false; error: "limit" | "tmux" }>;
      /** 작업 지시 켜기(옮겨 열기). 없으면 라우트가 없다 */
      reopen?(record: SessionRecord, mode: ReopenMode): Promise<ReopenResult>;
      /** 그 층의 옮겨 열기가 진행 중인지 — 그동안 pause·resume·terminate·hide는 409 busy(B205 ②) */
      reopening?(sessionId: string): boolean;
      /** 보고서·인수인계·질문 저장소(Phase 6b). 없으면 메모리만(테스트) */
      reports?: ReportStore;
      /** 제출 도구 PreToolUse 짝짓기(B311). 없으면 새로 */
      pairing?: PairingBook;
      /** 대화 질문 판(Phase 6b 스펙 4장). 없으면 새로(Stop 대체 경로는 꺼짐) */
      questions?: QuestionBoard;
      /** 퇴근·퇴사(Phase 6b 스펙 6·7장). 없으면 새로 */
      duty?: DutyBoard;
    };
    /** 층 관리(Phase 4a 스펙 4·5·6). record는 마지막 스냅샷 빌드의 세션 레코드(B117) */
    floors?: {
      preToolUse(input: Record<string, unknown>): object | null;
      pause(id: string): void;
      resume(id: string): void;
      isPaused(id: string): boolean;
      terminate(record: SessionRecord | undefined, force: boolean): Promise<TerminateResult>;
      hide(id: string): void;
      unhideAll(): void;
      hiddenCount(): number;
      record(id: string): SessionRecord | undefined;
    };
    /** 같은 계정 검사의 주입(테스트용). 없으면 실제 OS·uid·/proc */
    sameUser?: { platform?: string; uid?: number; read?: (p: string) => string };
  } = {},
): Express {
  const app = express();
  const snapshotHub = hub; // 아래 channels 블록의 hub(ChannelHub)와 이름이 겹친다
  const reports = opts.channels?.reports ?? new ReportStore();
  const pairing = opts.channels?.pairing ?? new PairingBook();
  const questions = opts.channels?.questions ?? new QuestionBoard();
  const duty = opts.channels?.duty ?? new DutyBoard({ reports });
  opts.channels?.hub.onHeldGone((key, sent, meta) => {
    questions.heldGone(key, sent);
    // 보관한 팀리더 지시가 실제로 나갔을 때 퇴근·퇴사를 기록한다(11장 a)
    if (sent && meta && typeof meta === "object" && "kind" in meta) duty.onSent(meta as LeadSent);
  });

  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) {
      // 사내 프록시가 Host를 바꿔 hook이 막히는 경우를 진단에서 볼 수 있게 센다
      if (req.path === "/hooks/event") opts.stats?.reject("403");
      res.status(403).type("text/plain").send("로컬 주소로만 접속할 수 있습니다");
      return;
    }
    next();
  });
  // 같은 계정만 받기(Phase 5 §2): Host 검사 바로 뒤, 모든 경로(hook·channel·/api·화면). 셈은 403-uid만(Host의 403과 겹치지 않음)
  app.use(sameUserGuard({ ...opts.sameUser, onReject: () => opts.stats?.reject("403-uid") }));

  /**
   * hook 이벤트 처리(Phase 1~5의 /hooks/event 본문). 옛 입구와 /hooks/v2가 같이 부른다(Phase 6a §4).
   * res는 실제 응답 또는 v2의 암호화 어댑터 — 200 json/end만 쓰고, PermissionRequest는 결정 큐가 붙잡는다
   */
  const handleHook = (raw: Record<string, unknown>, res: HookResponse, pluginVersion: string, legacy: boolean): void => {
    // 맨 앞 한 곳에서 session_id를 대화 키로 바꾼 복사본을 모든 관문(일시정지·정책·예산·큐·이벤트·서브에이전트)에 넘긴다(B194)
    const sid = opts.normalizeSession?.(raw.session_id as string) ?? (raw.session_id as string);
    const input = sid === raw.session_id ? raw : { ...raw, session_id: sid };
    opts.stats?.accept(input.hook_event_name as string);
    try {
      // 버전 문자열은 부르는 쪽이 40자로 자른다(스냅샷이 커지지 않게)
      opts.onPluginVersion?.(pluginVersion, legacy, input.session_id as string);
    } catch (e) {
      getLogger().error("hooks", "plugin version failed", { error: errInfo(e) });
    }
    // 제출 도구의 주인 짝짓기와 대화 질문 해제·Stop 판정은 /hooks/v2 이벤트만(스펙 12장 d)
    if (!legacy) {
      try {
        pairing.onPreToolUse(input);
        void questions.onEvent(input).catch((e) => getLogger().error("questions", "event failed", { error: errInfo(e) }));
      } catch (e) {
        getLogger().error("hooks", "pairing failed", { error: errInfo(e) });
      }
    }
    const isPre = input.hook_event_name === "PreToolUse";
    // 0. 일시정지 deny(Phase 4a 스펙 4.2): 가장 넓은 규칙이라 맨 앞. 정책·예산 관문·큐·이벤트 저장소를 거치지 않는다
    // (막힌 호출이 "작업 중"으로 남지 않게, Phase 3 B79). 판정이 던지면 일시정지가 없는 것처럼 이어 간다
    if (isPre) {
      try {
        const paused = opts.floors?.preToolUse(input);
        if (paused) return void res.status(200).json(paused);
      } catch (e) {
        getLogger().error("floors", "pause check failed", { error: errInfo(e) });
        if (res.headersSent) return;
      }
    }
    // 정책 판정(스펙 6.2). 판정에서 예외가 나면 로그만 남기고 정책이 없는 것처럼 이어 간다(스펙 6.4)
    let verdict: PolicyVerdict | null = null;
    if (isPre) {
      try {
        verdict = opts.policy?.preToolUse(input) ?? null;
      } catch (e) {
        getLogger().error("policy", "check failed", { error: errInfo(e) });
      }
    }
    // 1. 정책 deny: 즉시 답한다. 예산 관문·큐·이벤트 저장소를 거치지 않는다(막힌 호출이 "작업 중"으로 남지 않게, Ruling B79).
    // respond()가 던지면 아래 단계로 그대로 내려간다(정책 오류가 도구를 막지 않는다)
    if (verdict?.decision === "deny") {
      try {
        return void res.status(200).json(verdict.respond());
      } catch (e) {
        getLogger().error("policy", "deny failed", { error: errInfo(e) });
        if (res.headersSent) return;
      }
    }
    try {
      opts.onHookEvent?.(input);
    } catch (e) {
      // hook 쪽을 절대 막지 않는다. 로그만 남기고 200을 돌려준다. 요청 본문(비밀값 가능)은 로그에 넣지 않는다
      getLogger().error("hooks", "event handling failed", { error: errInfo(e) });
    }
    try {
      // 터미널이 먼저 답한 결정을 닫는다(Ruling B70). 예산의 "터미널 허용 = 계속"은 위 onHookEvent의 관문이 먼저 판정한다
      opts.decisions?.onEvent(input);
    } catch (e) {
      getLogger().error("hooks", "decision event failed", { error: errInfo(e) });
    }
    try {
      if (isPre) {
        // 2. 예산 관문이 정책 ask보다 먼저다 — 예산 ask는 뒤따르는 PermissionRequest가 예산 결정으로 짝지어져야 한다(B48)
        const out = opts.gate?.preToolUse(input);
        if (out) return void res.status(200).json(out);
      } else if (input.hook_event_name === "PermissionRequest" && opts.decisions) {
        const budget = opts.gate?.claim(input);
        let byPolicy = false;
        if (!budget) {
          try {
            byPolicy = opts.policy?.claim(input) ?? false;
          } catch (e) {
            getLogger().error("policy", "claim failed", { error: errInfo(e) });
          }
        }
        // 붙잡은 응답에는 큐만 쓴다(대시보드 답, 590초 빈 200, 상한 초과 빈 200)
        opts.decisions.hold(input, res, budget ? { kind: "budget", budget } : byPolicy ? { policy: true } : undefined);
        return;
      }
    } catch (e) {
      getLogger().error("hooks", "decision handling failed", { error: errInfo(e) });
      if (res.headersSent) return;
    }
    // 3. 정책 ask
    if (verdict?.decision === "ask") {
      try {
        return void res.status(200).json(verdict.respond());
      } catch (e) {
        getLogger().error("policy", "ask failed", { error: errInfo(e) });
        if (res.headersSent) return;
      }
    }
    res.status(200).end();
  };
  // hook 이벤트 수신(스펙 5장). hook 요청은 인증하지 않는다(Phase 2 스펙 7.2 — 결정을 요청할 뿐이다). Host 검사(위), Origin 거부,
  // Content-Type 강제로 외부 웹페이지의 위조 요청을 막는다: 다른 출처의 브라우저가 JSON을 보내려면
  // 사전 확인이 필요한데 이 서버는 CORS를 허용하지 않는다. Claude Code의 hook 요청에는 Origin이 없다.
  app.post(
    "/hooks/event",
    (req, res, next) => {
      if (req.headers.origin !== undefined) {
        opts.stats?.reject("403");
        res.status(403).end();
        return;
      }
      if (!req.is("application/json")) {
        opts.stats?.reject("415");
        res.status(415).end();
        return;
      }
      next();
    },
    express.json({ limit: "1mb", type: () => true }),
    (req, res) => {
      const body = req.body as unknown;
      const valid =
        !!body && typeof body === "object" && !Array.isArray(body) &&
        typeof (body as Record<string, unknown>).hook_event_name === "string" &&
        typeof (body as Record<string, unknown>).session_id === "string";
      if (!valid) {
        opts.stats?.reject("400");
        res.status(400).end();
        return;
      }
      handleHook(body as Record<string, unknown>, res, (req.get("X-Claude-Office-Plugin") ?? "unknown").slice(0, 40), true);
    },
  );
  // 암호화 hook 입구(Phase 6a §4): Host·같은 계정(위) → Origin 거부 → JSON 1.5MB → kid·GCM·v·ts·재전송 창 → 같은 처리 함수.
  // 응답은 응답 키로 암호화한다. 실패는 모두 401 빈 본문(이유는 응답·로그에 싣지 않는다)
  if (opts.hookV2) {
    const v2 = opts.hookV2;
    const fail = (res: express.Response) => {
      opts.stats?.reject("401-v2");
      res.status(401).end();
    };
    app.post(
      "/hooks/v2",
      (req, res, next) => (req.headers.origin === undefined ? next() : fail(res)),
      express.json({ limit: HOOK_V2.maxBody, type: () => true }),
      (req, res) => {
        const keys = v2.keys();
        const r = keys ? openRequest(req.body, keys, Date.now(), v2.seen) : null;
        if (!keys || !r?.ok) return fail(res);
        opts.stats?.acceptV2();
        handleHook(r.event, sealed(res, r.id, keys), r.plugin, false);
      },
    );
  }
  // express.json이 낸 오류(본문 초과 413, JSON 문법 400)를 이 경로에서만 짧게 돌려준다
  app.use((err: { status?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path === "/hooks/v2") {
      opts.stats?.reject("401-v2");
      res.status(401).end();
      return;
    }
    if (req.path !== "/hooks/event") {
      next(err);
      return;
    }
    const status = err.status === 413 ? 413 : 400;
    opts.stats?.reject(status === 413 ? "413" : "400");
    res.status(status).end();
  });

  if (opts.auth) {
    const { token } = opts.auth;
    // 토큰 주소(/?k=…)를 쿠키로 바꾸고 /로 돌려보내 주소창·방문 기록에 토큰이 남지 않게 한다(스펙 7.1)
    app.get("/", (req, res, next) => {
      const k = req.query.k;
      if (k === undefined) return next();
      res.setHeader("Cache-Control", "no-store");
      if (!tokenMatches(typeof k === "string" ? k : undefined, token)) {
        res.status(401).type("text/plain").send("주소가 올바르지 않습니다. 터미널에서 claude-office로 다시 열어 주세요");
        return;
      }
      // 이름은 브라우저가 본 포트로(B297). 옛 이름 co는 값이 이 열쇠일 때만 지운다 — co는 포트를 가르지 않아,
      // 같은 브라우저로 쓰는 다른 포트의 beta.13 설치본 쿠키까지 지우지 않게(B300)
      const line = cookieLine(cookieName(req.headers.host, req.socket.localPort ?? 0), token);
      res.setHeader("Set-Cookie", tokenMatches(cookieOf(req.headers.cookie, COOKIE), token) ? [line, CLEAR_OLD_COOKIE] : [line]);
      res.redirect(302, "/");
    });
    // /api/* 전체. /hooks/event와 화면 정적 파일은 여기를 지나지 않는다(스펙 7.1·7.2).
    // 쓰기는 Ruling B32: (쿠키 + 같은 출처 Origin) 또는 (Bearer + Origin 없음 — CLI). 401에 app 표시를 넣어
    // doctor가 토큰 없이도 이 프로그램인지 알아보게 한다
    app.use("/api", (req, res, next) => {
      const name = cookieName(req.headers.host, req.socket.localPort ?? 0);
      let byCookie = tokenMatches(cookieOf(req.headers.cookie, name), token);
      // 옛 이름(co, beta.13까지)은 열쇠가 맞을 때만 받아 새 이름으로 다시 심고 옛 것을 지운다(B297·B298)
      if (!byCookie && tokenMatches(cookieOf(req.headers.cookie, COOKIE), token)) {
        byCookie = true;
        res.setHeader("Set-Cookie", [cookieLine(name, token), CLEAR_OLD_COOKIE]);
      }
      const byBearer = tokenMatches(bearerOf(req.headers.authorization), token);
      if (!byCookie && !byBearer) return void res.status(401).json({ error: "unauthorized", app: "claude-office", ...(opts.auth?.version ? { version: opts.auth.version } : {}) });
      if (req.method === "GET" || req.method === "HEAD") return next();
      const origin = req.headers.origin;
      const fromPage = byCookie && origin !== undefined && isSameOrigin(origin, req.headers.host);
      const fromCli = byBearer && origin === undefined;
      if (!fromPage && !fromCli) return void res.status(403).end();
      if (!req.is("application/json")) return void res.status(415).end();
      next();
    });
  }

  if (opts.diagnostics) {
    const diag = opts.diagnostics;
    app.get("/api/diagnostics", async (_req, res) => {
      try {
        res.json(await diag.summary());
      } catch (e) {
        getLogger().error("diag", "summary failed", { error: errInfo(e) });
        res.status(500).json({ error: "진단 정보를 만들지 못했습니다" });
      }
    });
    // 본문은 읽지 않는다(빈 {}). 파일 이름과 위치는 서버가 정한다
    app.post("/api/diagnostics/bundle", async (req, res) => {
      if (!isSameOrigin(req.headers.origin, req.headers.host)) return void res.status(403).end();
      if (!req.is("application/json")) return void res.status(415).end();
      try {
        const file = await diag.makeBundle();
        getLogger().info("diag", "bundle created", { file });
        res.status(201).json({ file });
      } catch (e) {
        getLogger().error("diag", "bundle failed", { error: errInfo(e) });
        res.status(500).json({ error: "진단 파일을 만들지 못했습니다" });
      }
    });
    app.get("/api/diagnostics/files/:name", (req, res) => {
      const name = req.params.name;
      if (!BUNDLE_NAME.test(name)) return void res.status(404).end();
      // root를 주면 점 파일 검사는 root 아래 경로(= 이름 규칙을 통과한 파일 이름)에만 적용된다.
      // 설치 위치 ~/.claude-office가 점 폴더라 전체 경로를 넘기면 기본값(dotfiles: ignore)에 걸려 404가 된다
      res.download(name, name, { root: diag.diagDir }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    });
  }

  if (opts.decisions) {
    const queue = opts.decisions;
    // 쓰기 인증(쿠키 + 같은 출처, B32)은 위 /api 미들웨어가 한다. auth 없이 만든 앱은 예전 Origin 규칙
    app.post(
      "/api/decisions/:id",
      (req, res, next) => {
        if (!isSameOrigin(req.headers.origin, req.headers.host)) return void res.status(403).end();
        if (!req.is("application/json")) return void res.status(415).end();
        next();
      },
      express.json({ limit: "16kb", type: () => true }),
      (req, res) => {
        // 모르는 키·큰 배열·틀린 타입은 400. 종류에 맞는지는 큐가 판단한다. 이유·답 내용은 로그에 남기지 않는다
        const a = parseAnswer(req.body);
        if (!a) return void res.status(400).json({});
        const r = queue.answer(req.params.id as string, a);
        if (r.ok) res.status(200).json({ state: r.state });
        else res.status(r.status).json(r.state ? { state: r.state } : {});
      },
    );
    app.use("/api/decisions", (err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status === 413 ? 413 : 400).json({});
    });
  }

  if (opts.budget) {
    const budget = opts.budget;
    app.put(
      "/api/budget",
      (req, res, next) => {
        if (!isSameOrigin(req.headers.origin, req.headers.host)) return void res.status(403).end();
        if (!req.is("application/json")) return void res.status(415).end();
        next();
      },
      express.json({ limit: "4kb", type: () => true }),
      (req, res) => {
        const b = req.body as { sessionId?: unknown; budgetTokens?: unknown } | null;
        const t = b?.budgetTokens;
        const valid =
          !!b && typeof b === "object" && !Array.isArray(b) &&
          Object.keys(b).every((k) => k === "sessionId" || k === "budgetTokens") &&
          (b.sessionId === undefined || typeof b.sessionId === "string") &&
          (t === null || (typeof t === "number" && Number.isInteger(t) && t >= BUDGET_MIN && t <= BUDGET_MAX));
        if (!valid) return void res.status(400).json({});
        const sessionId = b.sessionId as string | undefined;
        if (sessionId !== undefined && !hub.current().sessions.some((s) => s.id === sessionId)) return void res.status(404).json({});
        budget.set(sessionId, t as number | null);
        res.status(204).end();
      },
    );
    app.use("/api/budget", (err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status === 413 ? 413 : 400).json({});
    });
  }

  if (opts.policyApi) {
    const policy = opts.policyApi;
    const sameOrigin = (req: express.Request, res: express.Response, next: express.NextFunction) =>
      isSameOrigin(req.headers.origin, req.headers.host) ? next() : void res.status(403).end();
    // req.params는 Express가 디코드한 값이다. 퍼센트 인코딩이 깨졌으면 Express가 400 오류를 넘기고 아래 오류 처리가 받는다
    const targetOf = (req: express.Request): string | null => (isTargetKey(req.params.target) ? (req.params.target as string) : null);
    const changed = () => {
      try {
        hub.poke?.();
      } catch (e) {
        getLogger().error("policy", "poke failed", { error: errInfo(e) });
      }
    };
    app.get("/api/policy", (_req, res) => {
      res.json(policy.all());
    });
    app.put(
      "/api/policy/targets/:target",
      sameOrigin,
      (req, res, next) => (req.is("application/json") ? next() : void res.status(415).end()),
      express.json({ limit: "4kb", type: () => true }),
      (req, res) => {
        const target = targetOf(req);
        const b = req.body as unknown;
        const ok = !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === 1 && Object.hasOwn(b, "rules");
        const rules = ok ? parseRules((b as { rules: unknown }).rules) : null;
        if (!target || !rules) return void res.status(400).json({});
        const r = policy.set(target, rules);
        // 상한 초과는 화면이 상한 안내를 보이게 이유를 싣는다(Ruling B95). 그 밖의 400에는 싣지 않는다
        if (!r.ok) return void res.status(400).json(r.reason === "limit" ? { reason: "limit" } : {});
        changed();
        res.status(200).json({ saved: r.saved });
      },
    );
    app.delete("/api/policy/targets/:target", sameOrigin, (req, res) => {
      const target = targetOf(req);
      if (!target) return void res.status(400).json({});
      const r = policy.remove(target);
      changed();
      res.status(200).json({ saved: r.saved });
    });
    app.use("/api/policy", (err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status === 413 ? 413 : 400).json({});
    });
  }

  if (opts.floors) {
    const floors = opts.floors;
    const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
    const guard = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!isSameOrigin(req.headers.origin, req.headers.host)) return void res.status(403).end();
      if (!req.is("application/json")) return void res.status(415).end();
      next();
    };
    // req.params는 Express가 디코드한 값이다. 깨진 퍼센트 인코딩은 Express가 400 오류로 넘기고 아래 오류 처리가 받는다
    const idOf = (req: express.Request): string | null => {
      const id = req.params.id;
      return typeof id === "string" && SESSION_ID.test(id) ? id : null;
    };
    const poke = () => {
      try {
        hub.poke?.();
      } catch (e) {
        getLogger().error("floors", "poke failed", { error: errInfo(e) });
      }
    };
    // 옮겨 열기가 진행 중인 층은 다른 층 조작을 막는다(15초 사이 건 멈춤이 sweep에 말없이 지워지지 않게, B205 ②)
    const notReopening = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const id = idOf(req);
      if (id && opts.channels?.reopening?.(id)) return void res.status(409).json({ error: "busy" });
      next();
    };
    const pauseRoute = (pause: boolean) => (req: express.Request, res: express.Response) => {
      const id = idOf(req);
      if (!id) return void res.status(400).json({});
      if (!floors.record(id)?.alive) return void res.status(409).json({ error: "ended" });
      const before = floors.isPaused(id);
      if (pause) floors.pause(id);
      else floors.resume(id);
      if (floors.isPaused(id) !== before) poke();
      res.status(200).json({ paused: pause });
    };
    app.post("/api/floors/:id/pause", guard, notReopening, pauseRoute(true));
    // 재개 브리핑의 [보내고 재개](Phase 4b 7장): 본문 { sendHeld: true }면 재개한 뒤 보관 지시를 보낸다
    app.post("/api/floors/:id/resume", guard, notReopening, express.json({ limit: "1kb", type: () => true }), (req, res) => {
      const id = idOf(req);
      if (!id) return void res.status(400).json({});
      if (!floors.record(id)?.alive) return void res.status(409).json({ error: "ended" });
      const sendHeld = (req.body as { sendHeld?: unknown } | undefined)?.sendHeld === true;
      // 연결 전이면 보낼 수 없으니 재개하지 않는다 — 재개만 되고 보관 지시가 남는 어긋남을 막는다(리뷰 #410 M2)
      if (sendHeld && opts.channels && (opts.channels.hub.view(id)?.held ?? 0) > 0 && !opts.channels.hub.connected(id)) return void res.status(409).json({ error: "not-connected" });
      const before = floors.isPaused(id);
      floors.resume(id);
      if (floors.isPaused(id) !== before) poke();
      const sent = sendHeld ? (opts.channels?.hub.flushHeld(id) ?? 0) : undefined;
      res.status(200).json({ paused: false, ...(sent !== undefined ? { sent } : {}) });
    });
    app.post("/api/floors/:id/terminate", guard, notReopening, express.json({ limit: "1kb", type: () => true }), async (req, res) => {
      const id = idOf(req);
      const b = req.body as unknown;
      const ok = !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every((k) => k === "force") && ((b as { force?: unknown }).force === undefined || typeof (b as { force?: unknown }).force === "boolean");
      if (!id || !ok) return void res.status(400).json({});
      // 신호는 레코드의 pid로만 보낸다(본문·주소의 pid는 받지 않는다, 스펙 5.1)
      const r = await floors.terminate(floors.record(id), (b as { force?: boolean }).force === true);
      if (r.ok) {
        if (r.sent) poke();
        return void res.status(200).json({ signal: r.signal });
      }
      res.status(r.error === "self" ? 400 : 409).json({ error: r.error });
    });
    app.post("/api/floors/:id/hide", guard, notReopening, (req, res) => {
      const id = idOf(req);
      if (!id) return void res.status(400).json({});
      const r = floors.record(id);
      if (!r) return void res.status(404).json({});
      if (r.alive) return void res.status(409).json({ error: "alive" });
      const before = floors.hiddenCount();
      floors.hide(id);
      if (floors.hiddenCount() !== before) poke();
      res.status(200).json({ hidden: floors.hiddenCount() });
    });
    app.delete("/api/floors/hidden", guard, (_req, res) => {
      const before = floors.hiddenCount();
      floors.unhideAll();
      if (before !== 0) poke();
      res.status(200).json({ hidden: 0 });
    });
    if (opts.channels) {
      const { hub, launch } = opts.channels;
      const textOf = (b: unknown): string | null => {
        const t = (b as { text?: unknown } | undefined)?.text;
        return typeof t === "string" && t.trim() && t.length <= MAX_TEXT && !t.includes("\0") ? t : null;
      };
      const on = (_req: express.Request, res: express.Response, next: express.NextFunction) => (hub.enabled() ? next() : void res.status(403).json({ error: "off" }));
      app.post("/api/floors/launch", guard, on, express.json({ limit: "16kb", type: () => true }), async (req, res) => {
        const v = validateLaunch(req.body);
        if (!v.ok) return void res.status(400).json({ error: v.error });
        const r = await launch(v.value);
        if (!r.ok) return void res.status(r.error === "limit" ? 429 : 502).json({ error: r.error });
        res.status(200).json({ sessionId: r.sessionId, tmux: r.tmux });
      });
      const reopen = opts.channels.reopen;
      if (reopen) {
        // 작업 지시 켜기(옮겨 열기, brief 설계 3): 살아 있고 대시보드가 띄우지 않았고(B203) 멈추지 않은(B202) 층만
        app.post("/api/floors/:id/reopen", guard, on, express.json({ limit: "1kb", type: () => true }), async (req, res) => {
          const id = idOf(req);
          const mode = (req.body as { mode?: unknown } | undefined)?.mode;
          if (!id || (mode !== undefined && mode !== "subagents" && mode !== "team")) return void res.status(400).json({});
          const r = floors.record(id);
          if (!r) return void res.status(404).json({});
          if (!r.alive) return void res.status(409).json({ error: "ended" });
          if (hub.has(id)) return void res.status(409).json({ error: "launched" });
          if (floors.isPaused(id)) return void res.status(409).json({ error: "paused" });
          // 합친 층은 bg job이 같은 대화를 계속 쓰므로 앞면만 끄면 두 프로세스가 한 대화를 쓴다(B205 ③)
          if (r.convId && r.convId !== r.sessionId) return void res.status(409).json({ error: "merged" });
          const out = await reopen(r, mode as ReopenMode);
          // 다시 열지 못했으면 화면이 터미널에서 열 명령(claude --resume {id})을 보이게 대화 id를 싣는다(B207 F2)
          const resumeId = out.ok ? undefined : out.error === "still-running" || out.error === "limit" || out.error === "tmux" ? r.convId ?? r.sessionId : undefined;
          // 신호 전에 멈춘 실패는 세션이 그대로라 이어 열 명령이 필요 없다(B212 I1)
          if (!out.ok && out.before) return void res.status(out.error === "cwd" ? 400 : 409).json({ error: out.error });
          if (!out.ok) return void res.status(out.error === "limit" ? 429 : out.error === "tmux" ? 502 : 409).json({ error: out.error, ...(resumeId ? { resumeId } : {}) });
          res.status(200).json({ tmux: out.tmux });
        });
      }
      app.post("/api/floors/:id/instruct", guard, on, express.json({ limit: "16kb", type: () => true }), (req, res) => {
        const id = idOf(req);
        const text = textOf(req.body);
        if (!id || !text) return void res.status(400).json({});
        const r = hub.instruct(id, text, floors.isPaused(id));
        if (!r.ok) return void res.status(r.error === "not-launched" ? 404 : 409).json({ error: r.error });
        res.status(200).json({ id: r.id, state: r.state });
      });
      // 서류철(Phase 6b 스펙 5장). 읽기 — 본문(모델 글)은 화면이 글자로만 그린다
      app.get("/api/floors/:id/reports", (req, res) => {
        const id = idOf(req);
        if (!id) return void res.status(400).json({});
        res.status(200).json(folderView(reports, id));
      });
      // 팀리더 지시(Phase 6b 스펙 2장): kind별 정해진 틀로만 만든다(사용자 글은 틀의 칸에만, leadText.ts)
      app.post("/api/floors/:id/lead", guard, on, express.json({ limit: "32kb", type: () => true }), (req, res) => {
        const id = idOf(req);
        if (!id) return void res.status(400).json({});
        // 퇴근·퇴사 등의 대상은 팀원만(리드 자신은 아님, B321 M5). 서브에이전트는 팀원 목록에 없다(리드에 합쳐짐)
        const members = snapshotHub.current().sessions.find((x) => x.id === id)?.members.filter((m) => m.role !== "lead" && m.name !== "team-lead").map((m) => m.name) ?? [];
        const r = leadInstruct(hub, id, floors.isPaused(id), req.body, members, reports, (sent) => duty.onSent(sent));
        // 답을 보냈으면 질문 표시를 지우고, 보관했으면 "보관됨"(B308·B309)
        const qid = (req.body as { kind?: unknown; questionId?: unknown } | undefined)?.kind === "reply" ? (req.body as { questionId?: unknown }).questionId : undefined;
        if (r.status === 200 && typeof qid === "string") questions.onReply(qid, (r.body as { state: "sent" | "held" }).state);
        res.status(r.status).json(r.body);
      });
      app.put("/api/experimental", guard, express.json({ limit: "1kb", type: () => true }), (req, res) => {
        const v = (req.body as { channels?: unknown } | undefined)?.channels;
        if (typeof v !== "boolean") return void res.status(400).json({});
        if (v && !hub.available().ok) return void res.status(409).json({ error: "unavailable" });
        res.status(200).json(hub.setEnabled(v));
      });
      app.get("/api/floors/:id/held", (req, res) => {
        const id = idOf(req);
        if (!id) return void res.status(400).json({});
        res.status(200).json({ held: hub.held(id) });
      });
      app.put("/api/floors/:id/held/:hid", guard, express.json({ limit: "16kb", type: () => true }), (req, res) => {
        const id = idOf(req);
        const text = textOf(req.body);
        if (!id || !text) return void res.status(400).json({});
        res.status(hub.editHeld(id, String(req.params.hid), text) ? 200 : 404).json({});
      });
      app.delete("/api/floors/:id/held/:hid", guard, (req, res) => {
        const id = idOf(req);
        if (!id) return void res.status(400).json({});
        res.status(hub.dropHeld(id, String(req.params.hid)) ? 200 : 404).json({});
      });
    }
    app.use("/api/floors", (err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status === 413 ? 413 : 400).json({});
    });
  }

  app.get("/api/snapshot", (_req, res) => {
    res.json(hub.current());
  });

  app.get("/api/stream", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (s: Snapshot) => res.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
    send(hub.current());
    const off = hub.subscribe(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), opts.heartbeatMs ?? 15_000);
    req.on("close", () => {
      off();
      clearInterval(heartbeat);
    });
  });

  // channel 서버(플러그인)가 거는 나가는 연결(Phase 4b 스펙 5장). 쿠키가 아니라 층 열쇠의 증명으로만 인증하고(B257 — 열쇠 원문은 오가지 않는다),
  // 브라우저(Origin 있음)는 본문을 읽기 전에 거부한다
  if (opts.channels) {
    const { hub: ch } = opts.channels;
    const HEX = /^[0-9a-f]{64}$/;
    const noBrowser = (req: express.Request, res: express.Response, next: express.NextFunction) => (req.headers.origin === undefined ? next() : void res.status(403).end());
    const body = express.json({ limit: "1kb", type: () => true });
    app.post("/channel/hello", noBrowser, body, (req, res) => {
      const b = req.body as { kid?: unknown; nonce?: unknown } | undefined;
      if (typeof b?.kid !== "string" || !HEX.test(b.kid) || typeof b.nonce !== "string" || !HEX.test(b.nonce)) return void res.status(400).end();
      const r = ch.hello(b.kid, b.nonce);
      if (r) res.json(r);
      else res.status(401).end();
    });
    app.get("/channel/stream", noBrowser, (req, res) => {
      const m = /^Proof ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
      const a = m && ch.attach({ kid: m[1], snonce: m[2], proof: m[3] }, res);
      // 같은 층에 살아 있는 연결이 있으면 409(스펙 12장 g ② — 401·403이면 channel 서버가 영영 멈춘다. 409는 잠시 뒤 다시 시도)
      if (a === "busy") return void res.status(409).end();
      if (!a) return void res.status(401).end();
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Office-Ack": a.ack });
      res.flushHeaders(); // 첫 지시나 심장박동을 기다리지 않고 연결됨을 알린다
      const heartbeat = setInterval(() => res.write(": ping\n\n"), opts.heartbeatMs ?? 15_000);
      req.on("close", () => clearInterval(heartbeat));
    });
    // channel MCP 도구의 제출(Phase 6b 스펙 3장). 크기 상한은 MAC 계산 전(본문 파서)에, 층은 연결로만
    app.post("/channel/submit", noBrowser, express.json({ limit: "256kb", type: () => true }), (req, res) => {
      const t = /^Ack ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      const r = handleSubmit({ hub: ch, reports, pairing, questions, convOf: (f) => opts.normalizeSession?.(f) ?? f }, t, req.body);
      res.status(r.status).json(r.body);
    });
    app.post("/channel/ack", noBrowser, body, (req, res) => {
      const t = /^Ack ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      res.status(t && ch.ack(t, (req.body as { id?: unknown } | undefined)?.id) ? 200 : 401).json({});
    });
  }

  const staticDir = opts.staticDir;
  if (staticDir && existsSync(join(staticDir, "index.html"))) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method === "GET" && !req.path.startsWith("/api/")) res.sendFile(join(staticDir, "index.html"));
      else next();
    });
  } else if (staticDir) {
    // 경로는 넣지 않는다(설치 폴더 이름). 설치본인지 여부는 start 로그의 webExists·mode로 안다
    getLogger().error("server", "static files missing");
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
      res.status(503).type("html").send('<!doctype html><meta charset="utf-8"><title>Claude Agent Office</title><p>화면 파일이 없습니다 — 다시 설치해 주세요</p>');
    });
  }
  // 마지막 오류 처리기(B262): express 기본 오류 페이지는 스택(설치 경로·사용자 이름)을 내보낸다. 본문은 비운다.
  // 4xx 상태가 붙은 오류(본문 파서의 400·413 등)는 그 상태, 상태가 없는 예외는 서버 쪽 잘못이라 500(B276)
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const s = err?.status;
    res.status(typeof s === "number" && s >= 400 && s < 500 ? s : 500).end();
  });
  return app;
}
