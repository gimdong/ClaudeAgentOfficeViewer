import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../src/shared/types";
import type { DiagnosticsSummary } from "../src/shared/types";
import type { HookStats } from "./events/stats";
import { COOKIE, bearerOf, cookieOf, tokenMatches } from "./auth";
import { BUDGET_MAX, BUDGET_MIN } from "./budget/store";
import { parseAnswer } from "./decisions/protocol";
import type { DecisionQueue } from "./decisions/queue";
import type { SnapshotHub } from "./hub";
import { errInfo, getLogger } from "./log";
import type { PolicyVerdict } from "./policy/gate";
import { isTargetKey, parseRules, type PolicyFile, type SetResult } from "./policy/store";
import type { PolicyRules } from "../src/shared/types";

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

export function createApp(
  hub: Pick<SnapshotHub, "current" | "subscribe"> & Partial<Pick<SnapshotHub, "poke">>,
  opts: {
    staticDir?: string;
    heartbeatMs?: number;
    onHookEvent?: (input: Record<string, unknown>) => void;
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
  } = {},
): Express {
  const app = express();

  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) {
      // 사내 프록시가 Host를 바꿔 hook이 막히는 경우를 진단에서 볼 수 있게 센다
      if (req.path === "/hooks/event") opts.stats?.reject("403");
      res.status(403).type("text/plain").send("로컬 주소로만 접속할 수 있습니다");
      return;
    }
    next();
  });

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
      const input = body as Record<string, unknown>;
      opts.stats?.accept(input.hook_event_name as string);
      const isPre = input.hook_event_name === "PreToolUse";
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
    },
  );
  // express.json이 낸 오류(본문 초과 413, JSON 문법 400)를 이 경로에서만 짧게 돌려준다
  app.use((err: { status?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
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
      res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      res.redirect(302, "/");
    });
    // /api/* 전체. /hooks/event와 화면 정적 파일은 여기를 지나지 않는다(스펙 7.1·7.2).
    // 쓰기는 Ruling B32: (쿠키 + 같은 출처 Origin) 또는 (Bearer + Origin 없음 — CLI). 401에 app 표시를 넣어
    // doctor가 토큰 없이도 이 프로그램인지 알아보게 한다
    app.use("/api", (req, res, next) => {
      const byCookie = tokenMatches(cookieOf(req.headers.cookie), token);
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
  return app;
}
